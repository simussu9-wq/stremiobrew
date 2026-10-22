// StremioBrew's nuvio-engine runner: nuvio-engine (github.com/NuvioMedia/nuvio-engine, GPL-3.0,
// libtorrent 2.0 underneath) behind a small HTTP API on 127.0.0.1:3030 (the subset of rqbit's API
// that service/tvserver.js was written against, so the helper drives it unchanged): magnets are
// added with POST /torrents, files are read from GET /torrents/<ih>, the player streams GET /torrents/<ih>/stream/<idx> (proxied, with Range, to the engine's own
// loopback server), Auto pacing posts /torrents/limits, the player's peer line reads
// /torrents/<ih>/stats/v1, and stopping playback deletes the torrent.
//
//   nuvio-bridge --port 3030 --state DIR --cache DIR --cache-mb N [--upload-kbps K]
//
// --state keeps the DHT table and resume data between runs; --cache holds the payload and is
// bounded by --cache-mb through the engine's streaming window (pieces far from the playhead are
// freed from disk and fetched again if needed).
#include "nuvio_engine/nuvio_engine.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <csignal>
#include <cstdarg>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0 // macOS: SIGPIPE is ignored instead
#endif

namespace {

struct FileEntry { std::string path; std::uint64_t size = 0; };
struct StreamEntry { std::string id; std::string url; std::uint64_t request = 0; bool ready = false; std::string error; };
struct Torrent {
    std::string ih;                // lower-case hex info hash (our key)
    std::string engine_id;         // the engine's torrent id (also the v1 hex hash)
    std::uint64_t add_request = 0;
    bool metadata = false;
    std::string error;
    std::vector<FileEntry> files;
    std::map<std::uint32_t, StreamEntry> streams;
};

nuvio_engine* engine = nullptr;
std::mutex mu;
std::condition_variable changed;
std::map<std::string, Torrent> torrents;      // ih -> torrent
std::map<std::uint64_t, std::string> add_reqs; // add request id -> ih
std::atomic_bool stopping{false};

void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logf(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::fprintf(stderr, "[nuvio-bridge] ");
    std::vfprintf(stderr, fmt, ap);
    std::fprintf(stderr, "\n");
    va_end(ap);
}

std::string lower(std::string s) { for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return s; }

std::string json_escape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += static_cast<char>(c); }
        else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += static_cast<char>(c);
    }
    return o;
}

std::string human_rate(std::uint64_t bps) {
    char b[48];
    double m = static_cast<double>(bps) / (1024.0 * 1024.0);
    if (m >= 1.0) std::snprintf(b, sizeof b, "%.2f MiB/s", m);
    else std::snprintf(b, sizeof b, "%.1f KiB/s", static_cast<double>(bps) / 1024.0);
    return b;
}

// ---- engine events ----
void refresh_files(Torrent& t) {
    std::size_t n = 0;
    if (nuvio_engine_get_file_count(engine, t.engine_id.c_str(), &n) != NUVIO_ENGINE_STATUS_OK) return;
    t.files.clear();
    for (std::size_t i = 0; i < n; ++i) {
        nuvio_engine_file f;
        nuvio_engine_file_init(&f);
        if (nuvio_engine_get_file(engine, t.engine_id.c_str(), i, &f) != NUVIO_ENGINE_STATUS_OK) break;
        f.path[sizeof f.path - 1] = 0;
        t.files.push_back({f.path, f.size});
    }
    t.metadata = !t.files.empty();
}

Torrent* by_engine_id(const std::string& id) {
    for (auto& [ih, t] : torrents) if (t.engine_id == id) return &t;
    auto low = lower(id);
    auto it = torrents.find(low.substr(0, 40));
    return it == torrents.end() ? nullptr : &it->second;
}

void event_loop() {
    while (!stopping.load()) {
        nuvio_engine_event e;
        nuvio_engine_event_init(&e);
        if (nuvio_engine_poll_event(engine, &e) != NUVIO_ENGINE_STATUS_OK) {
            std::this_thread::sleep_for(std::chrono::milliseconds(15));
            continue;
        }
        std::lock_guard<std::mutex> lock(mu);
        e.torrent_id[sizeof e.torrent_id - 1] = 0;
        e.message[sizeof e.message - 1] = 0;
        std::string tid = e.torrent_id;
        switch (e.type) {
        case NUVIO_ENGINE_EVENT_TORRENT_ADDED: {
            auto r = add_reqs.find(e.request_id);
            if (r != add_reqs.end()) {
                auto& t = torrents[r->second];
                t.engine_id = tid;
                logf("added %s", t.ih.c_str());
            }
            break;
        }
        case NUVIO_ENGINE_EVENT_TORRENT_METADATA_READY: {
            Torrent* t = by_engine_id(tid);
            if (!t) { auto r = add_reqs.find(e.request_id); if (r != add_reqs.end()) t = &torrents[r->second]; }
            if (t) {
                if (t->engine_id.empty()) t->engine_id = tid;
                refresh_files(*t);
                logf("metadata %s: %zu file(s)", t->ih.c_str(), t->files.size());
            }
            break;
        }
        case NUVIO_ENGINE_EVENT_STREAM_PREPARED: {
            e.stream_id[sizeof e.stream_id - 1] = 0;
            e.stream_url[sizeof e.stream_url - 1] = 0;
            for (auto& [ih, t] : torrents) {
                for (auto& [idx, s] : t.streams) {
                    if (s.request == e.request_id) {
                        s.id = e.stream_id; s.url = e.stream_url; s.ready = true;
                        logf("stream %s/%u ready: %s", ih.c_str(), idx, s.url.c_str());
                    }
                }
            }
            break;
        }
        case NUVIO_ENGINE_EVENT_STREAM_STOPPED: {
            e.stream_id[sizeof e.stream_id - 1] = 0;
            for (auto& [ih, t] : torrents) {
                for (auto it = t.streams.begin(); it != t.streams.end();) {
                    if (it->second.id == e.stream_id) { logf("stream %s/%u stopped by the engine", ih.c_str(), it->first); it = t.streams.erase(it); }
                    else ++it;
                }
            }
            break;
        }
        case NUVIO_ENGINE_EVENT_TORRENT_ERROR: {
            Torrent* t = by_engine_id(tid);
            if (!t) { auto r = add_reqs.find(e.request_id); if (r != add_reqs.end()) t = &torrents[r->second]; }
            if (t) {
                bool stream_err = false;
                for (auto& [idx, s] : t->streams) if (s.request == e.request_id && !s.ready) { s.error = e.message; stream_err = true; }
                if (!stream_err) t->error = e.message;
            }
            logf("error %s: %s", tid.c_str(), e.message);
            break;
        }
        default:
            break;
        }
        changed.notify_all();
    }
}

// ---- tiny HTTP server ----
struct Request { std::string method, path, query, body; std::map<std::string, std::string> headers; };

bool read_request(int fd, Request& r, std::string& leftover) {
    std::string buf;
    char tmp[4096];
    std::size_t head_end;
    while ((head_end = buf.find("\r\n\r\n")) == std::string::npos) {
        ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0 || buf.size() > 65536) return false;
        buf.append(tmp, static_cast<std::size_t>(n));
    }
    std::string head = buf.substr(0, head_end);
    leftover = buf.substr(head_end + 4);
    std::size_t line_end = head.find("\r\n");
    std::string line = head.substr(0, line_end);
    std::size_t a = line.find(' '), b = line.find(' ', a + 1);
    if (a == std::string::npos || b == std::string::npos) return false;
    r.method = line.substr(0, a);
    std::string target = line.substr(a + 1, b - a - 1);
    std::size_t q = target.find('?');
    r.path = target.substr(0, q);
    if (q != std::string::npos) r.query = target.substr(q + 1);
    std::size_t pos = line_end;
    while (pos != std::string::npos && pos < head.size()) {
        std::size_t next = head.find("\r\n", pos + 2);
        std::string h = head.substr(pos + 2, next == std::string::npos ? std::string::npos : next - pos - 2);
        std::size_t c = h.find(':');
        if (c != std::string::npos) {
            std::string v = h.substr(c + 1);
            while (!v.empty() && v[0] == ' ') v.erase(0, 1);
            r.headers[lower(h.substr(0, c))] = v;
        }
        pos = next;
    }
    std::size_t len = r.headers.count("content-length") ? std::strtoul(r.headers["content-length"].c_str(), nullptr, 10) : 0;
    if (len > 1024 * 1024) return false;
    r.body = leftover;
    while (r.body.size() < len) {
        ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return false;
        r.body.append(tmp, static_cast<std::size_t>(n));
    }
    r.body.resize(len);
    return true;
}

bool send_all(int fd, const char* p, std::size_t n) {
    while (n) {
        ssize_t w = ::send(fd, p, n, MSG_NOSIGNAL);
        if (w <= 0) return false;
        p += w; n -= static_cast<std::size_t>(w);
    }
    return true;
}

void reply(int fd, int code, const std::string& body, const char* type = "application/json") {
    const char* text = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 400 ? "Bad Request" : code == 502 ? "Bad Gateway" : code == 504 ? "Gateway Timeout" : "Error";
    char head[256];
    int n = std::snprintf(head, sizeof head, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n", code, text, type, body.size());
    send_all(fd, head, static_cast<std::size_t>(n));
    send_all(fd, body.data(), body.size());
}

std::string files_json(const Torrent& t) {
    std::string o = "[";
    for (std::size_t i = 0; i < t.files.size(); ++i) {
        const auto& f = t.files[i];
        std::string name = f.path;
        auto slash = name.find_last_of('/');
        std::string base = slash == std::string::npos ? name : name.substr(slash + 1);
        char num[32];
        std::snprintf(num, sizeof num, "%llu", static_cast<unsigned long long>(f.size));
        if (i) o += ",";
        o += "{\"name\":\"" + json_escape(base) + "\",\"path\":\"" + json_escape(name) + "\",\"length\":" + num + ",\"included\":true}";
    }
    return o + "]";
}

std::string details_json(const Torrent& t) {
    return "{\"info_hash\":\"" + t.ih + "\",\"name\":\"" + json_escape(t.files.empty() ? t.ih : t.files[0].path) + "\",\"files\":" + files_json(t) + "}";
}

std::string magnet_hash(const std::string& magnet) {
    auto p = lower(magnet).find("xt=urn:btih:");
    if (p == std::string::npos) return {};
    std::string h = lower(magnet.substr(p + 12, 40));
    if (h.size() != 40 || h.find_first_not_of("0123456789abcdef") != std::string::npos) return {};
    return h;
}

std::uint64_t json_number(const std::string& body, const char* key, bool& present) {
    present = false;
    auto p = body.find(std::string("\"") + key + "\"");
    if (p == std::string::npos) return 0;
    p = body.find(':', p);
    if (p == std::string::npos) return 0;
    ++p;
    while (p < body.size() && body[p] == ' ') ++p;
    if (body.compare(p, 4, "null") == 0) return 0;
    present = true;
    return std::strtoull(body.c_str() + p, nullptr, 10);
}

std::string stats_json() {
    nuvio_engine_stats st;
    nuvio_engine_stats_init(&st);
    if (nuvio_engine_get_stats(engine, &st) != NUVIO_ENGINE_STATUS_OK) return "{}";
    char b[1400];
    std::snprintf(b, sizeof b,
        "{\"state\":\"live\",\"live\":{\"snapshot\":{\"peer_stats\":{\"live\":%u,\"seen\":%u,\"connecting\":%u}},"
        "\"download_speed\":{\"mbps\":%.3f,\"human_readable\":\"%s\"},\"upload_speed\":{\"mbps\":%.3f,\"human_readable\":\"%s\"}},"
        "\"nuvio\":{\"peers\":%u,\"seeds\":%u,\"downloading_peers\":%u,\"down_bps\":%llu,\"up_bps\":%llu,\"downloaded\":%llu,"
        "\"mem_cache_used\":%llu,\"disk_used\":%llu,\"disk_capacity\":%llu,\"window_resident\":%llu,\"window_freed\":%llu,"
        "\"window_refetched_pieces\":%llu,\"window_unsupported\":%u,\"timed_out_block_requests\":%u,\"pending_piece_reads\":%u}}",
        st.connected_peers, st.known_peers, st.connecting_peers,
        static_cast<double>(st.download_rate_bytes_per_second) / 1048576.0, human_rate(st.download_rate_bytes_per_second).c_str(),
        static_cast<double>(st.upload_rate_bytes_per_second) / 1048576.0, human_rate(st.upload_rate_bytes_per_second).c_str(),
        st.connected_peers, st.connected_seeds, st.downloading_peers,
        static_cast<unsigned long long>(st.download_rate_bytes_per_second), static_cast<unsigned long long>(st.upload_rate_bytes_per_second),
        static_cast<unsigned long long>(st.total_payload_download_bytes), static_cast<unsigned long long>(st.memory_cache_used_bytes),
        static_cast<unsigned long long>(st.disk_cache_used_bytes), static_cast<unsigned long long>(st.disk_cache_capacity_bytes),
        static_cast<unsigned long long>(st.window_resident_bytes), static_cast<unsigned long long>(st.window_freed_bytes),
        static_cast<unsigned long long>(st.window_refetched_pieces), static_cast<unsigned>(st.window_unsupported),
        st.timed_out_block_requests, st.pending_piece_reads);
    return b;
}

// Prepares (once) the stream for ih/idx and returns its engine URL, waiting up to 60 s.
bool stream_url(const std::string& ih, std::uint32_t idx, std::string& url, std::string& err) {
    std::unique_lock<std::mutex> lock(mu);
    auto it = torrents.find(ih);
    if (it == torrents.end()) { err = "unknown torrent"; return false; }
    if (!changed.wait_for(lock, std::chrono::seconds(60), [&] { auto f = torrents.find(ih); return f == torrents.end() || f->second.metadata || !f->second.error.empty(); })) { err = "metadata timeout"; return false; }
    it = torrents.find(ih);
    if (it == torrents.end() || !it->second.metadata) { err = it == torrents.end() ? "removed" : it->second.error; return false; }
    Torrent& t = it->second;
    if (idx >= t.files.size()) { err = "no such file"; return false; }
    auto s = t.streams.find(idx);
    if (s == t.streams.end() || (!s->second.ready && !s->second.error.empty())) {
        nuvio_engine_stream_request q;
        nuvio_engine_stream_request_init(&q);
        q.torrent_id = t.engine_id.c_str();
        q.file_index = idx;
        std::uint64_t rid = 0;
        if (nuvio_engine_prepare_stream(engine, &q, &rid) != NUVIO_ENGINE_STATUS_OK) { err = "prepare failed"; return false; }
        StreamEntry e; e.request = rid;
        t.streams[idx] = e;
    }
    if (!changed.wait_for(lock, std::chrono::seconds(60), [&] {
            auto f = torrents.find(ih);
            if (f == torrents.end()) return true;
            auto g = f->second.streams.find(idx);
            return g == f->second.streams.end() || g->second.ready || !g->second.error.empty();
        })) { err = "stream timeout"; return false; }
    it = torrents.find(ih);
    if (it == torrents.end()) { err = "removed"; return false; }
    auto g = it->second.streams.find(idx);
    if (g == it->second.streams.end() || !g->second.ready) { err = g == it->second.streams.end() ? "stopped" : g->second.error; return false; }
    url = g->second.url;
    return true;
}

// Pipes the request to the engine's loopback stream (Range and HEAD included) and back.
// Returns false (nothing sent to the player) when the engine's stream is gone: refused or 404.
bool proxy_stream(int fd, const Request& r, const std::string& url) {
    // url: http://127.0.0.1:PORT/path
    unsigned port = 0;
    char path[600] = {0};
    if (std::sscanf(url.c_str(), "http://127.0.0.1:%u%599s", &port, path) != 2) return false;
    int up = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(static_cast<std::uint16_t>(port));
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (up < 0 || ::connect(up, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { if (up >= 0) ::close(up); return false; }
    std::string req = r.method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n";
    auto range = r.headers.find("range");
    if (range != r.headers.end()) req += "Range: " + range->second + "\r\n";
    req += "\r\n";
    if (!send_all(up, req.data(), req.size())) { ::close(up); return false; }
    std::vector<char> buf(256 * 1024);
    ssize_t first = ::recv(up, buf.data(), buf.size(), 0);
    if (first <= 0 || (first >= 12 && std::memcmp(buf.data() + 9, "404", 3) == 0)) { ::close(up); return false; }
    if (!send_all(fd, buf.data(), static_cast<std::size_t>(first))) { ::close(up); return true; }
    for (;;) {
        ssize_t n = ::recv(up, buf.data(), buf.size(), 0);
        if (n <= 0) break;
        if (!send_all(fd, buf.data(), static_cast<std::size_t>(n))) break; // the player closed (seek): stop
    }
    ::close(up);
    return true;
}

void forget_stream(const std::string& ih, std::uint32_t idx) {
    std::lock_guard<std::mutex> lock(mu);
    auto t = torrents.find(ih);
    if (t != torrents.end()) t->second.streams.erase(idx);
}

void handle(int fd) {
    int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    Request r;
    std::string leftover;
    if (!read_request(fd, r, leftover)) { ::close(fd); return; }
    const std::string& p = r.path;
    // GET /torrents/<ih>/stream/<idx>
    if ((r.method == "GET" || r.method == "HEAD") && p.rfind("/torrents/", 0) == 0 && p.find("/stream/") == 50) {
        std::string ih = lower(p.substr(10, 40));
        std::uint32_t idx = static_cast<std::uint32_t>(std::strtoul(p.c_str() + 58, nullptr, 10));
        std::string url, err;
        bool sent = false;
        for (int attempt = 0; attempt < 2 && !sent; ++attempt) {
            if (!stream_url(ih, idx, url, err)) break;
            sent = proxy_stream(fd, r, url);
            if (!sent) { logf("stream %s/%u gone at the engine: preparing it again", ih.c_str(), idx); forget_stream(ih, idx); err = "stream unavailable"; }
        }
        if (!sent) reply(fd, err == "unknown torrent" ? 404 : 504, "{\"error\":\"" + json_escape(err) + "\"}");
        ::close(fd);
        return;
    }
    if (r.method == "GET" && p == "/torrents") {
        std::lock_guard<std::mutex> lock(mu);
        std::string o = "{\"torrents\":[";
        int i = 0;
        for (auto& [ih, t] : torrents) { if (i) o += ","; o += "{\"id\":" + std::to_string(i++) + ",\"info_hash\":\"" + ih + "\"}"; }
        reply(fd, 200, o + "]}");
    } else if (r.method == "POST" && p == "/torrents") {
        std::string magnet = r.body;
        std::string ih = magnet_hash(magnet);
        if (ih.empty()) { reply(fd, 400, "{\"error\":\"need a magnet with a hex btih\"}"); ::close(fd); return; }
        std::unique_lock<std::mutex> lock(mu);
        auto it = torrents.find(ih);
        if (it == torrents.end()) {
            nuvio_engine_torrent_request q;
            nuvio_engine_torrent_request_init(&q);
            q.magnet_uri = magnet.c_str();
            q.source_type = NUVIO_ENGINE_TORRENT_SOURCE_MAGNET;
            std::uint64_t rid = 0;
            auto st = nuvio_engine_add_torrent(engine, &q, &rid);
            if (st != NUVIO_ENGINE_STATUS_OK) { lock.unlock(); reply(fd, 502, std::string("{\"error\":\"") + nuvio_engine_status_message(st) + "\"}"); ::close(fd); return; }
            Torrent t; t.ih = ih; t.add_request = rid;
            torrents[ih] = t;
            add_reqs[rid] = ih;
            it = torrents.find(ih);
        }
        // metadata usually takes seconds: answer now, the helper polls GET /torrents/<ih>
        changed.wait_for(lock, std::chrono::milliseconds(1500), [&] { auto f = torrents.find(ih); return f == torrents.end() || f->second.metadata; });
        it = torrents.find(ih);
        if (it != torrents.end() && it->second.metadata) reply(fd, 200, "{\"id\":0,\"details\":" + details_json(it->second) + "}");
        else reply(fd, 200, "{\"id\":0}");
    } else if (r.method == "POST" && p == "/torrents/limits") {
        bool dp = false, upp = false;
        std::uint64_t down = json_number(r.body, "download_bps", dp), upl = json_number(r.body, "upload_bps", upp);
        nuvio_engine_set_rate_limits(engine, dp ? down : 0, upp ? upl : 0);
        logf("limits: down %s, up %s", dp ? human_rate(down).c_str() : "unlimited", upp ? human_rate(upl).c_str() : "unlimited");
        reply(fd, 200, "{}");
    } else if (r.method == "GET" && p == "/stats") {
        reply(fd, 200, stats_json());
    } else if (p.rfind("/torrents/", 0) == 0 && p.size() >= 50) {
        std::string ih = lower(p.substr(10, 40)), rest = p.substr(50);
        std::unique_lock<std::mutex> lock(mu);
        auto it = torrents.find(ih);
        if (it == torrents.end()) { lock.unlock(); reply(fd, 404, "{\"error\":\"unknown torrent\"}"); ::close(fd); return; }
        if (r.method == "GET" && rest.empty()) {
            if (!it->second.metadata) { std::string e = it->second.error; lock.unlock(); reply(fd, 404, "{\"error\":\"" + json_escape(e.empty() ? "no metadata yet" : e) + "\"}"); }
            else { std::string o = details_json(it->second); lock.unlock(); reply(fd, 200, o); }
        } else if (r.method == "GET" && rest == "/stats/v1") {
            lock.unlock();
            reply(fd, 200, stats_json());
        } else if (r.method == "POST" && rest == "/delete") {
            std::string id = it->second.engine_id;
            torrents.erase(it);
            lock.unlock();
            if (!id.empty()) { std::uint64_t rid = 0; nuvio_engine_remove_torrent(engine, id.c_str(), &rid); }
            changed.notify_all();
            logf("removed %s", ih.c_str());
            reply(fd, 200, "{}");
        } else if (r.method == "POST" && (rest == "/pause" || rest == "/start")) {
            lock.unlock();
            reply(fd, 200, "{}"); // the engine has no paused state; the app no longer warms torrents up
        } else {
            lock.unlock();
            reply(fd, 404, "{\"error\":\"unknown route\"}");
        }
    } else {
        reply(fd, 404, "{\"error\":\"unknown route\"}");
    }
    ::close(fd);
}

void on_signal(int) { stopping.store(true); }

// The streaming window frees played pieces by punching holes in the payload file. On a
// filesystem that can't, the payload would grow to the whole file and fill the TV's flash: check
// first, in the cache folder itself, and refuse to start (exit code 3; the helper reports it)
// rather than fill the flash.
bool can_punch_holes(const std::string& dir) {
    std::string f = dir + "/.punch-test";
    int fd = ::open(f.c_str(), O_CREAT | O_RDWR | O_TRUNC, 0600);
    if (fd < 0) return false;
    std::vector<char> data(1024 * 1024, 'x');
    bool ok = ::pwrite(fd, data.data(), data.size(), 0) == static_cast<ssize_t>(data.size()) && ::fsync(fd) == 0;
    struct stat before{}, after{};
    ok = ok && ::fstat(fd, &before) == 0;
#if defined(__linux__)
    ok = ok && ::fallocate(fd, 0x01 /* KEEP_SIZE */ | 0x02 /* PUNCH_HOLE */, 0, 768 * 1024) == 0;
#elif defined(__APPLE__)
    fpunchhole_t hole{};
    hole.fp_offset = 0;
    hole.fp_length = 768 * 1024;
    ok = ok && ::fcntl(fd, F_PUNCHHOLE, &hole) == 0;
#else
    ok = false;
#endif
    ok = ok && ::fstat(fd, &after) == 0 && after.st_blocks < before.st_blocks;
    ::close(fd);
    ::unlink(f.c_str());
    return ok;
}

} // namespace

int main(int argc, char** argv) {
    unsigned port = 3030;
    std::string state_dir, cache_dir;
    std::uint64_t cache_mb = 256, upload_kbps = 512;
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string k = argv[i], v = argv[i + 1];
        if (k == "--port") port = static_cast<unsigned>(std::strtoul(v.c_str(), nullptr, 10));
        else if (k == "--state") state_dir = v;
        else if (k == "--cache") cache_dir = v;
        else if (k == "--cache-mb") cache_mb = std::strtoull(v.c_str(), nullptr, 10);
        else if (k == "--upload-kbps") upload_kbps = std::strtoull(v.c_str(), nullptr, 10);
    }
    if (state_dir.empty() || cache_dir.empty()) {
        std::fprintf(stderr, "usage: nuvio-bridge --port 3030 --state DIR --cache DIR --cache-mb N [--upload-kbps K]\n");
        return 2;
    }
    if (!can_punch_holes(cache_dir)) {
        logf("this filesystem can't punch holes in files (%s): the streaming window can't free played pieces; refusing to start", cache_dir.c_str());
        return 3;
    }
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGTERM, on_signal);
    std::signal(SIGINT, on_signal);

    nuvio_engine_config c;
    nuvio_engine_config_init(&c);
    c.data_directory = state_dir.c_str();
    c.cache_directory = cache_dir.c_str();
    c.memory_cache_capacity_bytes = 16ull * 1024 * 1024;                // verified pieces kept in RAM
    c.disk_cache_capacity_bytes = cache_mb * 1024 * 1024;
    c.streaming_window_bytes = cache_mb * 1024 * 1024;                  // bounded payload on flash
    c.upload_mode = NUVIO_ENGINE_UPLOAD_LIMITED;
    c.upload_limit_bytes_per_second = upload_kbps * 1024;
    c.torrent_profile = NUVIO_ENGINE_TORRENT_PROFILE_SOFT;              // 35 peers / 35 connects per s
    // No idle timers. By default the engine retires a stream after 30 s without reads and pauses
    // the torrent 60 s later: a player PAUSED longer than that came back to a dead stream URL and
    // failed. The helper owns the lifetime instead (delete on stop, engine stopped 5 min after the
    // player's keepalive pings end).
    c.stream_inactivity_timeout_milliseconds = 0;
    c.warm_torrent_timeout_milliseconds = 0;
    auto st = nuvio_engine_create(&c, &engine);
    if (st != NUVIO_ENGINE_STATUS_OK || !engine) {
        logf("engine create failed: %s", nuvio_engine_status_message(st));
        return 1;
    }
    logf("%s / libtorrent %s, cache %llu MB", nuvio_engine_version_string(), nuvio_engine_protocol_backend_version(), static_cast<unsigned long long>(cache_mb));

    int srv = ::socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(static_cast<std::uint16_t>(port));
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(srv, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(srv, 32) != 0) {
        logf("cannot listen on 127.0.0.1:%u", port);
        nuvio_engine_destroy(engine);
        return 1;
    }
    std::thread events(event_loop);
    std::thread acceptor([srv] {
        while (!stopping.load()) {
            int fd = ::accept(srv, nullptr, nullptr);
            if (fd < 0) { if (stopping.load()) break; continue; }
            std::thread(handle, fd).detach();
        }
    });
    logf("listening on 127.0.0.1:%u", port);
    while (!stopping.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    logf("stopping");
    ::shutdown(srv, SHUT_RDWR);
    ::close(srv);
    events.join();
    acceptor.detach();
    nuvio_engine_destroy(engine); // stops the writers; the helper wipes the cache folder after
    logf("stopped");
    return 0;
}
