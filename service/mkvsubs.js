// Instant embedded subtitles for Matroska, without reading the movie.
//
// The old path ran ffmpeg over the whole stream from the playhead: to reach the subtitle
// packets it had to download every video/audio byte in between, which on debrid competes
// with playback and on P2P asks the torrent for the entire file. This reads only what the
// subtitles need:
//   1. the head of the file (one 64 KB Range): SeekHead, Info, Tracks;
//   2. the Cues index (usually at the end). ffmpeg and mkvmerge write one CuePoint per
//      subtitle block, with CueRelativePosition (where the block sits in its Cluster) and
//      CueDuration;
//   3. one small Range per subtitle block (neighbours in the same Cluster share one),
//      nearest the playhead first, a few requests per second, over one kept-alive
//      connection. About 0.1 % of the file.
// Same design as Nuvio Native Legacy's mkvass.c (github.com/iqui27/nuvio-native-legacy).
//
// Anything unexpected (not Matroska, no Cues, no CuePoint for the track, a codec that is
// not text, a server that ignores Range) makes the caller fall back to the ffmpeg path.
// Runs on the TV's Node 0.12: ES5 only.
'use strict';
var http = require('http');
var https = require('https');
var urlmod = require('url');
var zlib = require('zlib');

// ---- tuning ----
var HEAD_BYTES = 64 * 1024;        // first read: SeekHead, Info and Tracks live here
var CUES_FIRST = 256 * 1024;       // first read of the Cues; a 2 h film's index is ~100-400 KB
var CUES_MAX = 8 * 1024 * 1024;
var BLOCK_BYTES = 512;             // a BlockGroup header + one line of dialogue
var MERGE_BYTES = 256 * 1024;      // blocks this close in one Cluster share one Range
var AHEAD_S = 90;                  // harvest window ahead of the playhead...
var BEHIND_S = 8;                  // ...and behind it (a long line that began before a seek)
var P2P_AHEAD_S = 120;             // P2P: only what playback downloads anyway
var RATE = 3;                      // Ranges per second in the background
var RATE_URGENT = 8;               // ...while the window around the playhead is still missing
var FULL_TRACK_MAX = 8000;         // above this many lines, harvest only around the playhead
// Memory (a TV has ~40 MB free): tracks that are NOT chosen keep only the lines around the
// playhead; pruned lines are fetched again if the playhead comes back. The chosen track keeps
// everything unless it is enormous (karaoke-heavy ASS), then it is windowed too.
var KEEP_BEHIND_S = 60, KEEP_AHEAD_S = 150;      // tracks not chosen
var SEL_MAX = 20000;                              // chosen track: lines kept before windowing
var SEL_BEHIND_S = 600, SEL_AHEAD_S = 900;        // ...and the window it is cut down to
var PRUNE_EVERY_MS = 15000;
var SCANNED_MAX = 3000;                           // scan mode: Clusters remembered as read
var DEFAULT_DUR_S = 3;             // block without BlockDuration/CueDuration
// Scan mode (no CuePoint for a text track, or no index at all): read the Clusters near the
// playhead and keep only the text blocks. It costs about the video's bitrate for the scanned
// span, so it stays in a short window, runs slowly and pauses while the player's buffer is low.
var SCAN_CHUNK = 512 * 1024;
var SCAN_AHEAD_S = 60;
var SCAN_RATE = 2;                 // chunk reads per second (~1 MB/s at most)
var SCAN_MIN_BUFFER_S = 15;        // below this much buffered video, the scan waits
var TIMEOUT_MS = 15000;
var UA = 'Mozilla/5.0 (Web0S; Linux) StremioBrew';
var TEXT_CODECS = { 'S_TEXT/UTF8': 'text', 'S_TEXT/ASCII': 'text', 'S_TEXT/WEBVTT': 'text', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ass', 'S_ASS': 'ass', 'S_SSA': 'ass' };

// ---- EBML ----
var ID = {
  EBML: 0x1A45DFA3, SEGMENT: 0x18538067, SEEKHEAD: 0x114D9B74, SEEK: 0x4DBB, SEEKID: 0x53AB, SEEKPOS: 0x53AC,
  INFO: 0x1549A966, TSCALE: 0x2AD7B1, DURATION: 0x4489, TRACKS: 0x1654AE6B, TRACKENTRY: 0xAE,
  TRACKNUM: 0xD7, TRACKTYPE: 0x83, CODECID: 0x86, CODECPRIV: 0x63A2, LANG: 0x22B59C, LANGBCP: 0x22B59D,
  NAME: 0x536E, FLAGDEFAULT: 0x88, FLAGFORCED: 0x55AA, FLAGHI: 0x55AB,
  ENCODINGS: 0x6D80, ENCODING: 0x6240, COMPRESSION: 0x5034, COMPALGO: 0x4254, COMPSETTINGS: 0x4255,
  CUES: 0x1C53BB6B, CUEPOINT: 0xBB, CUETIME: 0xB3, CUETRACKPOS: 0xB7, CUETRACK: 0xF7, CUECLUSTER: 0xF1,
  CUEREL: 0xF0, CUEDUR: 0xB2, CLUSTER: 0x1F43B675, TIMESTAMP: 0xE7,
  BLOCKGROUP: 0xA0, BLOCK: 0xA1, SIMPLEBLOCK: 0xA3, BLOCKDUR: 0x9B,
  CHAPTERS: 0x1043A770, EDITION: 0x45B9, EDHIDDEN: 0x45BD, EDDEFAULT: 0x45DB, ATOM: 0xB6, CHSTART: 0x91, CHEND: 0x92, CHHIDDEN: 0x98, CHENABLED: 0x4598, CHDISPLAY: 0x80, CHSTRING: 0x85
};

// Element ID at buf[o]: { id, len } or null when it doesn't fit / is invalid.
function readId(buf, o) {
  if (o >= buf.length) return null;
  var c = buf[o], l = c & 0x80 ? 1 : c & 0x40 ? 2 : c & 0x20 ? 3 : c & 0x10 ? 4 : 0;
  if (!l || o + l > buf.length) return null;
  var v = 0;
  for (var i = 0; i < l; i++) v = v * 256 + buf[o + i];
  return { id: v, len: l };
}
// Element size vint at buf[o]: { size, len }; size -1 = unknown (all ones).
function readSize(buf, o) {
  if (o >= buf.length) return null;
  var c = buf[o], l = 1, m = 0x80;
  while (l <= 8 && !(c & m)) { l++; m >>= 1; }
  if (l > 8 || o + l > buf.length) return null;
  var v = c & (m - 1), ones = v === m - 1;
  for (var i = 1; i < l; i++) { v = v * 256 + buf[o + i]; if (buf[o + i] !== 0xff) ones = false; }
  return { size: ones ? -1 : v, len: l };
}
function readUint(buf, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + buf[o + i]; return v; }
function readFloat(buf, o, n) { return n === 4 ? buf.readFloatBE(o) : n === 8 ? buf.readDoubleBE(o) : 0; }
function readStr(buf, o, n) { return buf.toString('utf8', o, o + n).replace(/\0+$/, ''); }
// Walks the children in buf[start, end). fn(id, dataStart, size, elemStart); returning true stops.
// Returns the offset where it stopped (an element that doesn't fit ends the walk there).
function each(buf, start, end, fn) {
  var o = start;
  while (o < end) {
    var e = readId(buf, o); if (!e) break;
    var s = readSize(buf, o + e.len); if (!s) break;
    var d = o + e.len + s.len;
    if (s.size < 0 || d + s.size > end) { if (fn(e.id, d, -1, o) === true) return o; break; }
    if (fn(e.id, d, s.size, o) === true) return o;
    o = d + s.size;
  }
  return o;
}

// ---- HTTP Range client: one kept-alive connection per URL, follows redirects ----
var agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 1 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 1 })
};
// Node 0.12 frees Buffers only when V8's own small heap gets collected: reading video at its bitrate (scan mode)
// piled up a hundred MB of dead Buffers between collections (helper 71 -> 170 MB in a minute; the TV then killed
// the app). A full collection after every ~16 MB read keeps it flat (a few ms here, in the helper, not the app).
var gcBytes = 0, GC_EVERY = 16 * 1024 * 1024;
function readBytes(n) { gcBytes += n; if (gcBytes >= GC_EVERY && global.gc) { gcBytes = 0; try { global.gc(); } catch (e) {} } }
function Fetcher(url) { this.url = url; this.target = url; this.requests = 0; this.bytes = 0; this.req = null; this.dead = false; }
// cb(err, buf, total). err: 'norange' (server ignored Range), 'http404'..., 'busy' (429/5xx),
// 'timeout', 'net'. A short read (server cut the response) returns what came.
Fetcher.prototype.range = function (start, len, cb, depth) {
  var self = this, done = false, chunks = [], got = 0, total = -1;
  depth = depth || 0;
  if (self.dead) return cb('dead');
  if (depth > 5) return cb('redirects');
  var pu = urlmod.parse(self.target), lib = pu.protocol === 'https:' ? https : http;
  var opts = {
    protocol: pu.protocol, hostname: pu.hostname, port: pu.port, path: pu.path, method: 'GET',
    agent: agents[pu.protocol] || undefined,
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Range': 'bytes=' + start + '-' + (start + len - 1) }
  };
  if (pu.protocol === 'https:' && https.globalAgent.options.ca) opts.ca = https.globalAgent.options.ca;
  function finish(err, buf) {
    if (done) return; done = true; self.req = null;
    if (to) clearTimeout(to);
    chunks = null;
    cb(err, buf, total);
    readBytes(got);
  }
  var req, to = null;
  self.requests++;
  try { req = lib.request(opts); } catch (e) { return finish('net'); }
  self.req = req;
  req.on('response', function (r) {
    var sc = r.statusCode;
    if (sc >= 300 && sc < 400 && r.headers.location) {
      r.resume(); if (to) clearTimeout(to); done = true; self.req = null;
      self.target = urlmod.resolve(self.target, r.headers.location);
      return self.range(start, len, cb, depth + 1);
    }
    var cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(r.headers['content-range'] || '');
    if (cr && cr[3] !== '*') total = parseInt(cr[3], 10);
    if (sc === 200) {
      if (start !== 0) { r.resume(); try { req.abort(); } catch (e) {} return finish('norange'); }
      var cl = parseInt(r.headers['content-length'] || '-1', 10); if (cl > 0) total = cl;
    } else if (sc === 206) {
      if (cr && parseInt(cr[1], 10) !== start) { r.resume(); return finish('norange'); }
    } else {
      r.resume();
      return finish(sc === 429 || sc >= 500 ? 'busy' : 'http' + sc);
    }
    r.on('data', function (d) {
      if (done) return;
      var need = len - got;
      if (d.length >= need) {
        chunks.push(d.slice(0, need)); got += need; self.bytes += need;
        // had what we asked for: a 200 for the whole file must not keep downloading
        if (sc === 200) { try { req.abort(); } catch (e) {} }
        return finish(null, Buffer.concat(chunks, got));
      }
      chunks.push(d); got += d.length; self.bytes += d.length;
    });
    // a server that drops the connection mid-body: newer Node ends the response, Node 0.12
    // only reports 'aborted'/'close'. Either way, keep what came.
    function cut() { finish(got ? null : 'net', Buffer.concat(chunks, got)); }
    r.on('end', cut); r.on('error', cut); r.on('aborted', cut); r.on('close', cut);
  });
  req.on('error', function () { finish('net'); });
  to = setTimeout(function () { try { req.abort(); } catch (e) {} finish('timeout'); }, TIMEOUT_MS);
  req.end();
};
Fetcher.prototype.close = function () { this.dead = true; if (this.req) { try { this.req.abort(); } catch (e) {} } };
// Reads exactly [start, start+len). Some CDNs end a response early (Real-Debrid was seen
// cutting at ~77 KB while the video plays): ask for the rest as long as each follow-up
// brings bytes, and stop after 3 that bring none.
Fetcher.prototype.rangeFull = function (start, len, cb) {
  var self = this, parts = [], have = 0, empty = 0, total = -1;
  (function next() {
    self.range(start + have, len - have, function (err, buf, tot) {
      if (tot > 0) total = tot;
      if (buf && buf.length) { parts.push(buf); have += buf.length; empty = 0; } else empty++;
      if (have >= len || (total > 0 && start + have >= total)) return cb(null, Buffer.concat(parts, have), total);
      if (err && err !== 'net' && err !== 'timeout') return cb(have ? null : err, have ? Buffer.concat(parts, have) : null, total);
      if (empty >= 3 || self.dead) return cb(have ? null : (err || 'short'), have ? Buffer.concat(parts, have) : null, total);
      next();
    });
  })();
};

// ---- header: Segment, SeekHead, Info, Tracks ----
function parseTrack(buf, d, size) {
  var t = { num: 0, type: 0, codec: '', lang: 'eng', name: '', def: true, forced: false, sdh: false, priv: null, comp: null };
  each(buf, d, d + size, function (id, cd, cs) {
    if (cs < 0) return;
    if (id === ID.TRACKNUM) t.num = readUint(buf, cd, cs);
    else if (id === ID.TRACKTYPE) t.type = readUint(buf, cd, cs);
    else if (id === ID.CODECID) t.codec = readStr(buf, cd, cs);
    else if (id === ID.CODECPRIV) t.priv = buf.slice(cd, cd + cs);
    else if (id === ID.LANG) t.lang = readStr(buf, cd, cs) || 'eng';
    else if (id === ID.LANGBCP) t.bcp = readStr(buf, cd, cs);
    else if (id === ID.NAME) t.name = readStr(buf, cd, cs);
    else if (id === ID.FLAGDEFAULT) t.def = readUint(buf, cd, cs) !== 0;
    else if (id === ID.FLAGFORCED) t.forced = readUint(buf, cd, cs) !== 0;
    else if (id === ID.FLAGHI) t.sdh = readUint(buf, cd, cs) !== 0;
    else if (id === ID.ENCODINGS) {
      // ContentCompression: zlib (old mkvmerge compressed subtitle tracks by default) or
      // header stripping. Encryption is not supported (the track is skipped).
      each(buf, cd, cd + cs, function (eid, ed, es) {
        if (eid !== ID.ENCODING || es < 0) return;
        each(buf, ed, ed + es, function (cid, ccd, ccs) {
          if (cid !== ID.COMPRESSION || ccs < 0) { if (cid === 0x5035) t.encrypted = true; return; }
          var c = { algo: 0, settings: null };
          each(buf, ccd, ccd + ccs, function (k, kd, ks) {
            if (ks < 0) return;
            if (k === ID.COMPALGO) c.algo = readUint(buf, kd, ks);
            else if (k === ID.COMPSETTINGS) c.settings = buf.slice(kd, kd + ks);
          });
          t.comp = c;
        });
      });
    }
  });
  if (t.bcp && (!t.lang || t.lang === 'und')) t.lang = t.bcp.split('-')[0];
  if (t.lang === 'und') t.lang = '';
  return t;
}
function parseTracks(info, buf, d, size) {
  info.tracks = [];
  each(buf, d, d + size, function (id, td, ts) { if (id === ID.TRACKENTRY && ts >= 0) info.tracks.push(parseTrack(buf, td, ts)); });
}
// Parses what the first bytes hold. info.need = { id, pos } when Tracks lies past them.
function parseHead(buf) {
  var e = readId(buf, 0);
  if (!e || e.id !== ID.EBML) return null;
  var s = readSize(buf, e.len); if (!s || s.size < 0) return null;
  var o = e.len + s.len + s.size;
  e = readId(buf, o); if (!e || e.id !== ID.SEGMENT) return null;
  s = readSize(buf, o + e.len); if (!s) return null;
  var info = { segStart: o + e.len + s.len, segEnd: s.size < 0 ? -1 : o + e.len + s.len + s.size, tscale: 1000000, duration: 0, tracks: null, cuesPos: -1, tracksPos: -1, chapPos: -1, chapters: null, firstCluster: -1, need: null };
  each(buf, info.segStart, buf.length, function (id, d, size, at) {
    if (id === ID.CLUSTER) { info.firstCluster = at; return true; }
    if (size < 0) { if (id === ID.TRACKS && info.tracksPos < 0) info.tracksPos = at; return true; }
    if (id === ID.SEEKHEAD) {
      each(buf, d, d + size, function (sid, sd, ss) {
        if (sid !== ID.SEEK || ss < 0) return;
        var which = 0, pos = -1;
        each(buf, sd, sd + ss, function (k, kd, ks) {
          if (ks < 0) return;
          if (k === ID.SEEKID) which = readUint(buf, kd, ks);
          else if (k === ID.SEEKPOS) pos = readUint(buf, kd, ks);
        });
        if (pos < 0) return;
        if (which === ID.CUES) info.cuesPos = info.segStart + pos;
        else if (which === ID.TRACKS && info.tracksPos < 0) info.tracksPos = info.segStart + pos;
        else if (which === ID.CHAPTERS && info.chapPos < 0) info.chapPos = info.segStart + pos;
      });
    } else if (id === ID.INFO) {
      each(buf, d, d + size, function (k, kd, ks) {
        if (ks < 0) return;
        if (k === ID.TSCALE) info.tscale = readUint(buf, kd, ks) || 1000000;
        else if (k === ID.DURATION) info.duration = readFloat(buf, kd, ks);
      });
    } else if (id === ID.TRACKS) {
      parseTracks(info, buf, d, size);
    } else if (id === ID.CHAPTERS) {
      info.chapters = parseChapters(buf, d, size);
    } else if (id === ID.CUES && info.cuesPos < 0) {
      info.cuesPos = at; // index written at the front (cues_to_front)
    }
  });
  info.duration = info.duration * info.tscale / 1e9;
  if (!info.tracks && info.tracksPos >= 0) info.need = { id: ID.TRACKS, pos: info.tracksPos };
  return info;
}

// ---- Chapters (the file's own markers: "Intro", "Opening", "Recap", "End Credits"...) ----
// [{ s, e, name }] in seconds from the default (else first visible) edition; e = -1 when unknown
function parseChapters(buf, d, size) {
  var eds = [];
  each(buf, d, d + size, function (id, ed, es) {
    if (id !== ID.EDITION || es < 0) return;
    var e = { hidden: false, def: false, list: [] };
    each(buf, ed, ed + es, function (k, kd, ks) {
      if (ks < 0) return;
      if (k === ID.EDHIDDEN) e.hidden = readUint(buf, kd, ks) !== 0;
      else if (k === ID.EDDEFAULT) e.def = readUint(buf, kd, ks) !== 0;
      else if (k === ID.ATOM) {
        var c = { s: 0, e: -1, name: '', hidden: false, on: true };
        each(buf, kd, kd + ks, function (a, ad, as) {
          if (as < 0) return;
          if (a === ID.CHSTART) c.s = readUint(buf, ad, as) / 1e9;
          else if (a === ID.CHEND) c.e = readUint(buf, ad, as) / 1e9;
          else if (a === ID.CHHIDDEN) c.hidden = readUint(buf, ad, as) !== 0;
          else if (a === ID.CHENABLED) c.on = readUint(buf, ad, as) !== 0;
          else if (a === ID.CHDISPLAY && !c.name) each(buf, ad, ad + as, function (x, xd, xs) { if (x === ID.CHSTRING && xs >= 0 && !c.name) c.name = readStr(buf, xd, xs); });
        });
        if (!c.hidden && c.on) e.list.push({ s: c.s, e: c.e, name: c.name });
      }
    });
    if (!e.hidden && e.list.length) eds.push(e);
  });
  var pick = null;
  for (var i = 0; i < eds.length; i++) if (eds[i].def) { pick = eds[i]; break; }
  if (!pick) pick = eds[0];
  if (!pick) return [];
  var l = pick.list.sort(function (a, b) { return a.s - b.s; });
  for (var j = 0; j < l.length; j++) if (l[j].e < 0 && j + 1 < l.length) l[j].e = l[j + 1].s;
  return l;
}
// chapters(url, cb(err, list)): the head is already read by probe(); Chapters past it is one Range
function chapters(url, cb, maxPos) { // maxPos: don't read Chapters stored further into the file (a torrent would fetch pieces there)
  probe(url, function (err, info) {
    if (err || !info) return cb(err || 'noinfo');
    if (info.chapters) return cb(null, info.chapters);
    if (info.chapPos < 0) { info.chapters = []; return cb(null, []); }
    if (maxPos && info.chapPos > maxPos) return cb(null, []);
    var c = probes[url], f = (c && c.fetcher) || new Fetcher(url);
    f.rangeFull(info.chapPos, HEAD_BYTES, function (err2, b) {
      if (err2 || !b) return cb(err2 || 'nochapters');
      var e = readId(b, 0), sz = e && readSize(b, e.len);
      if (!e || e.id !== ID.CHAPTERS || !sz || sz.size < 0) { info.chapters = []; return cb(null, []); }
      var d = e.len + sz.len;
      info.chapters = parseChapters(b, d, Math.min(sz.size, b.length - d));
      cb(null, info.chapters);
    });
  });
}

// probe(url, cb(err, info)): reads the head (and Tracks if it lies further). info.subs lists
// the subtitle TrackEntries in file order: that order is ffmpeg's 0:s:N, so the ffmpeg
// fallback and this path agree on N.
var probes = {}; // url -> { at, info, fetcher }
function probe(url, cb) {
  var c = probes[url];
  if (c && c.info && Date.now() - c.at < 30 * 60000) return cb(null, c.info);
  var f = new Fetcher(url);
  f.rangeFull(0, HEAD_BYTES, function (err, buf, total) {
    if (err || !buf) return cb(err || 'empty');
    var info = parseHead(buf);
    if (!info) return cb('notmkv');
    info.size = total;
    info.head = buf;
    function done() {
      if (!info.tracks) return cb('notracks');
      info.subs = [];
      for (var i = 0; i < info.tracks.length; i++) {
        var t = info.tracks[i];
        if (t.type !== 17) continue;
        t.n = info.subs.length;
        t.kind = t.encrypted ? '' : (TEXT_CODECS[t.codec] || '');
        info.subs.push(t);
      }
      probes[url] = { at: Date.now(), info: info, fetcher: f };
      var keys = Object.keys(probes);
      if (keys.length > 4) delete probes[keys[0]];
      cb(null, info);
    }
    if (!info.need) return done();
    f.rangeFull(info.need.pos, HEAD_BYTES, function (err2, b2) {
      if (err2 || !b2) return cb(err2 || 'notracks');
      var e = readId(b2, 0), s = e && readSize(b2, e.len);
      if (!e || e.id !== ID.TRACKS || !s || s.size < 0) return cb('notracks');
      var d = e.len + s.len;
      function parse(b) { parseTracks(info, b, d, s.size); done(); }
      if (d + s.size <= b2.length) return parse(b2);
      f.rangeFull(info.need.pos, d + s.size, function (err3, b3) { if (err3 || !b3) return cb('notracks'); parse(b3); });
    });
  });
}

// ---- Cues ----
// loadCues(info, fetcher, cb(err)) fills info.points[trackNumber] = [{ t, d, cl, rel }]
// (seconds, seconds, absolute Cluster offset, CueRelativePosition or -1), sorted by time.
function loadCues(info, f, cb) {
  if (info.points) return cb(null);
  if (info.cuesLoading) { info.cuesLoading.push(cb); return; }
  if (info.cuesPos < 0) return cb('nocues');
  info.cuesLoading = [cb];
  // every waiting session copies the points into its own list right in its callback; then they
  // are let go (the probe cache would otherwise keep several MB per file; a later session reads
  // the index again)
  function out(err) { var w = info.cuesLoading; info.cuesLoading = null; for (var i = 0; i < w.length; i++) w[i](err); if (!err) info.points = null; }
  var want = {};
  for (var i = 0; i < info.subs.length; i++) if (info.subs[i].kind) want[info.subs[i].num] = true;
  var first = CUES_FIRST;
  if (info.size > 0 && info.cuesPos + first > info.size) first = info.size - info.cuesPos;
  f.rangeFull(info.cuesPos, first, function (err, buf) {
    if (err || !buf) return out(err || 'nocues');
    var e = readId(buf, 0);
    if (!e || e.id !== ID.CUES) return out(e && e.id === ID.EBML ? 'norange' : 'nocues');
    var s = readSize(buf, e.len);
    if (!s || s.size <= 0 || s.size > CUES_MAX) return out('nocues');
    var d = e.len + s.len;
    function parse(b) {
      var pts = {}, scale = info.tscale / 1e9, clusters = {};
      each(b, d, d + s.size, function (id, pd, ps) {
        if (id !== ID.CUEPOINT || ps < 0) return;
        var time = -1, poss = [];
        each(b, pd, pd + ps, function (k, kd, ks) {
          if (ks < 0) return;
          if (k === ID.CUETIME) time = readUint(b, kd, ks);
          else if (k === ID.CUETRACKPOS) {
            var p = { trk: 0, cl: -1, rel: -1, dur: -1 };
            each(b, kd, kd + ks, function (q, qd, qs) {
              if (qs < 0) return;
              if (q === ID.CUETRACK) p.trk = readUint(b, qd, qs);
              else if (q === ID.CUECLUSTER) p.cl = readUint(b, qd, qs);
              else if (q === ID.CUEREL) p.rel = readUint(b, qd, qs);
              else if (q === ID.CUEDUR) p.dur = readUint(b, qd, qs);
            });
            poss.push(p);
          }
        });
        if (time < 0) return;
        for (var j = 0; j < poss.length; j++) {
          var p = poss[j];
          if (p.cl >= 0 && clusters[p.cl] == null) clusters[p.cl] = time * scale;
          if (!want[p.trk] || p.cl < 0) continue;
          (pts[p.trk] || (pts[p.trk] = [])).push({ t: time * scale, d: p.dur >= 0 ? p.dur * scale : -1, cl: info.segStart + p.cl, rel: p.rel });
        }
      });
      for (var k in pts) pts[k].sort(function (a, z) { return a.t - z.t || a.cl - z.cl || a.rel - z.rel; });
      info.points = pts;
      info.clusters = Object.keys(clusters).map(function (k) { return { cl: info.segStart + (+k), t: clusters[k] }; }).sort(function (a, z) { return a.cl - z.cl; });
      out(null);
    }
    if (d + s.size <= buf.length) return parse(buf);
    f.rangeFull(info.cuesPos, d + s.size, function (err2, b2) {
      if (err2 || !b2 || b2.length < d + s.size) return out('nocues');
      parse(b2);
    });
  });
}

// ---- ASS ----
// Styles and PlayRes from the track's CodecPrivate (the script header).
function parseAssHeader(priv) {
  var h = { resX: 0, resY: 0, styles: {}, fmt: null, main: '' };
  if (!priv) return h;
  var lines = priv.toString('utf8').split(/\r?\n/), sec = '';
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim(), m;
    if (/^\[.*\]$/.test(l)) { sec = l.toLowerCase(); continue; }
    if ((m = /^PlayResX\s*:\s*(\d+)/i.exec(l))) h.resX = parseInt(m[1], 10);
    else if ((m = /^PlayResY\s*:\s*(\d+)/i.exec(l))) h.resY = parseInt(m[1], 10);
    else if (sec.indexOf('styles') >= 0 && /^Format\s*:/i.test(l)) h.fmt = l.replace(/^Format\s*:/i, '').split(',').map(function (x) { return x.trim().toLowerCase(); });
    else if (sec.indexOf('styles') >= 0 && /^Style\s*:/i.test(l) && h.fmt) {
      var v = l.replace(/^Style\s*:/i, '').split(','), st = {};
      for (var j = 0; j < h.fmt.length && j < v.length; j++) st[h.fmt[j]] = v[j].trim();
      var align = parseInt(st.alignment || '2', 10);
      if (sec.indexOf('v4+') < 0) align = legacyAlign(align); // SSA v4 numbering
      if (!h.main) h.main = (st.name || '').toLowerCase();
      h.styles[(st.name || '').toLowerCase()] = {
        an: align >= 1 && align <= 9 ? align : 2,
        b: st.bold && st.bold !== '0', i: st.italic && st.italic !== '0',
        c: assColor(st.primarycolour || st.primarycolor || '')
      };
    }
  }
  // libass defaults when only one or neither is given
  if (!h.resX && !h.resY) { h.resX = 384; h.resY = 288; }
  else if (!h.resY) h.resY = h.resX === 1280 ? 1024 : Math.round(h.resX * 3 / 4);
  else if (!h.resX) h.resX = h.resY === 1024 ? 1280 : Math.round(h.resY * 4 / 3);
  return h;
}
function legacyAlign(a) { // \a: 1-3 bottom, +4 top, +8 middle -> numpad
  var col = a & 3 || 2; if (a & 4) return col + 6; if (a & 8) return col + 3; return col;
}
// "&H00FFFFFF" / "&HFFFFFF&" (AABBGGRR) -> "#rrggbb"; '' when unparsable
function assColor(s) {
  var m = /&?H?([0-9a-fA-F]{1,8})/.exec(String(s || '').replace(/&$/, ''));
  if (!m) return '';
  var v = ('00000000' + m[1]).slice(-8);
  return '#' + v.slice(6, 8) + v.slice(4, 6) + v.slice(2, 4);
}
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// One ASS event -> cue { s, e, t (plain), h (safe HTML with <i>/<b>/colour spans), an?, x?, y?, l }.
// Block payload: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
function assCue(payload, s, e, hdr) {
  var f = payload.split(',');
  if (f.length < 9) return null;
  var layer = parseInt(f[1], 10) || 0, style = hdr.styles[(f[2] || '').trim().toLowerCase()] || hdr.styles['default'] || { an: 2 };
  var text = f.slice(8).join(',');
  var sname = (f[2] || '').trim().toLowerCase();
  // the dialogue style follows the viewer's colour setting; other styles (signs) keep theirs
  var baseCol = sname && sname !== 'default' && sname !== hdr.main && style.c && style.c !== '#ffffff' ? style.c : '';
  var an = style.an, x = -1, y = -1, it = !!style.i, bd = !!style.b, col = baseCol, drawing = false;
  var plain = '', html = '', openSpan = false;
  function flushStyle() {
    if (openSpan) html += '</span>';
    var css = (it ? 'font-style:italic;' : '') + (bd ? 'font-weight:bold;' : '') + (col ? 'color:' + col + ';' : '');
    openSpan = !!css;
    if (css) html += '<span style="' + css + '">';
  }
  var i = 0, styleOpen = false;
  if (it || bd || col) { flushStyle(); styleOpen = true; }
  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === '{') {
      var j = text.indexOf('}', i); if (j < 0) j = text.length;
      var tags = text.slice(i + 1, j), m, changed = false;
      var re = /\\(an|a|pos|move|i|b|1c|c|p|r)\s*(\([^)]*\)|&H[0-9a-fA-F]+&?|-?\d+)?/g;
      while ((m = re.exec(tags))) {
        var k = m[1], v = m[2] || '';
        if (k === 'an') { var n = parseInt(v, 10); if (n >= 1 && n <= 9) an = n; }
        else if (k === 'a') { var n2 = parseInt(v, 10); if (n2 > 0) an = legacyAlign(n2); }
        else if (k === 'pos' || k === 'move') { var p = v.replace(/[()]/g, '').split(','); if (p.length >= 2) { x = parseFloat(p[0]); y = parseFloat(p[1]); } }
        else if (k === 'i') { it = v === '1'; changed = true; }
        else if (k === 'b') { var w = parseInt(v, 10); bd = w === 1 || w >= 700; changed = true; }
        else if (k === 'c' || k === '1c') { col = v ? assColor(v) : ''; changed = true; }
        else if (k === 'p') drawing = parseInt(v, 10) > 0;
        else if (k === 'r') { it = !!style.i; bd = !!style.b; col = baseCol; changed = true; }
      }
      if (changed) { flushStyle(); styleOpen = true; }
      i = j + 1;
      continue;
    }
    if (drawing) { i++; continue; } // vector drawing commands, not text
    if (ch === '\\' && i + 1 < text.length) {
      var nx = text.charAt(i + 1);
      if (nx === 'N' || nx === 'n') { plain += '\n'; html += '<br>'; i += 2; continue; }
      if (nx === 'h') { plain += ' '; html += '&nbsp;'; i += 2; continue; }
    }
    plain += ch; html += escHtml(ch); i++;
  }
  if (openSpan) html += '</span>';
  plain = plain.replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '');
  if (!plain) return null;
  var cue = { s: s, e: e, t: plain, l: layer };
  if (styleOpen || html !== escHtml(plain)) cue.h = html.replace(/^(<br>|\s)+|(<br>|\s)+$/g, '');
  if (x >= 0 && y >= 0 && hdr.resX && hdr.resY) { cue.x = Math.round(x / hdr.resX * 1000) / 10; cue.y = Math.round(y / hdr.resY * 1000) / 10; cue.an = an; }
  else if (an !== 2) cue.an = an;
  return cue;
}
// S_TEXT/UTF8 (SubRip body with <i>/<b>/<font color>) -> cue
function textCue(payload, s, e) {
  var body = payload.replace(/\r/g, ''), an = 0;
  var am = /\{\\an(\d)\}/.exec(body); if (am) an = parseInt(am[1], 10);
  body = body.replace(/\{\\[^}]*\}/g, ''); // SubRip files sometimes carry ASS override blocks
  var plain = body.replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
  if (!plain) return null;
  var html = '', re = /<(\/?)(i|b|u|font)([^>]*)>|([^<]+)|(<)/gi, m, stack = [];
  while ((m = re.exec(body))) {
    if (m[4] != null) { html += escHtml(m[4]).replace(/\n/g, '<br>'); continue; }
    if (m[5] != null) { html += '&lt;'; continue; }
    var tag = m[2].toLowerCase();
    if (m[1]) { if (stack.length) { stack.pop(); html += '</span>'; } continue; }
    var css = tag === 'i' ? 'font-style:italic' : tag === 'b' ? 'font-weight:bold' : tag === 'u' ? 'text-decoration:underline' : '';
    if (tag === 'font') { var cm = /color\s*=\s*["']?(#?[0-9a-zA-Z]+)/i.exec(m[3]); if (cm) css = 'color:' + (/^[0-9a-fA-F]{6}$/.test(cm[1]) ? '#' + cm[1] : cm[1].replace(/[^#0-9a-zA-Z]/g, '')); }
    stack.push(tag); html += '<span style="' + css + '">';
  }
  while (stack.length) { stack.pop(); html += '</span>'; }
  var cue = { s: s, e: e, t: plain };
  html = html.replace(/^(<br>|\s)+|(<br>|\s)+$/g, '');
  if (html !== escHtml(plain).replace(/\n/g, '<br>')) cue.h = html;
  if (an && an !== 2) cue.an = an;
  return cue;
}

// ---- blocks ----
function decodePayload(track, data) {
  var c = track.comp;
  if (!c) return data;
  if (c.algo === 3) return c.settings ? Buffer.concat([c.settings, data]) : data; // header stripping
  if (c.algo === 0) { try { return zlib.inflateSync(data); } catch (e) { return null; } }
  return null;
}
// Parses the BlockGroup/SimpleBlock at buf[o]. Returns { len, payload, dur, ts } with len < 0
// = the element needs -len more bytes than buf holds; null = not a block of this track.
function readBlock(buf, o, trackNum) {
  var e = readId(buf, o);
  if (!e || (e.id !== ID.BLOCKGROUP && e.id !== ID.SIMPLEBLOCK)) return null;
  var s = readSize(buf, o + e.len);
  if (!s || s.size <= 0 || s.size > 4 * 1024 * 1024) return null;
  var d = o + e.len + s.len, end = d + s.size;
  if (end > buf.length) return { len: -1, total: end - o };
  var bl = -1, blN = 0, dur = -1;
  if (e.id === ID.BLOCKGROUP) {
    each(buf, d, end, function (id, cd, cs) {
      if (cs < 0) return;
      if (id === ID.BLOCK) { bl = cd; blN = cs; } else if (id === ID.BLOCKDUR) dur = readUint(buf, cd, cs);
    });
  } else { bl = d; blN = s.size; }
  if (bl < 0 || blN < 4) return null;
  var tv = readSize(buf, bl); // track number is a vint coded like a size
  if (!tv || tv.size !== trackNum) return null;
  var flags = buf[bl + tv.len + 2];
  if (flags & 0x06) return { len: end - o, payload: null }; // laced subtitle blocks: not seen in practice
  return { len: end - o, payload: buf.slice(bl + tv.len + 3, end > bl + blN ? bl + blN : end), dur: dur, ts: buf.readInt16BE(bl + tv.len) };
}

// ---- harvesting session: one per stream, every text track at once ----
// Muxers put the subtitle blocks of all tracks next to each other in each Cluster (the same
// line in several languages), so one Range per Cluster brings every track: harvesting all of
// them costs about what one costs. The session starts when the player lists the tracks and
// keeps the window around the playhead filled for EVERY text track, so choosing one shows
// its lines at once. The chosen track is also harvested in full in the background (debrid);
// on P2P only the window is ever read (each Range makes the torrent fetch a whole piece).
//
// new Session(url, { t, p2p, onState }) ; .select(n) ; .setPos(t) ; .cuesFor(n) (lines kept
// now) ; .cuesSince(n, since, ep) ; .trackState(n) = 'pending'|'harvesting'|'complete'|'fallback'
// ; .stop(). Lines far from the playhead are dropped (prune) so a long film stays small.
function Session(url, opts) {
  opts = opts || {};
  this.url = url; this.p2p = !!opts.p2p; this.onState = opts.onState || function () {};
  this.pos = Math.max(0, opts.t || 0); this.posAt = Date.now();
  this.state = 'starting'; this.err = ''; this.dead = false;
  this.fetcher = null; this.info = null; this.tracks = {}; this.byN = {};
  this.all = null; this.status = null; this.sel = -1; this.wantN = null;
  this.inflight = false; this.sent = []; this.backoffUntil = 0; this.backoffMs = 0; this.fails = 0;
  this.hdrLen = {}; this.hdrLenBest = 0; this.timer = null;
  this.startedAt = Date.now(); this.firstCueAt = 0;
  this.buf = -1; this.scanCur = null; this.scanned = {}; this.scannedN = 0; this.seen = {}; this.scanSent = [];
  this.prunedAt = Date.now(); this.jumpAt = 0;
  this.start(0);
}
Session.prototype.setState = function (st, err) { this.state = st; if (err) this.err = err; this.onState(this); };
Session.prototype.start = function (attempt) {
  var self = this;
  probe(self.url, function (err, info) {
    if (self.dead) return;
    // a network hiccup (debrid CDN, an engine still starting) is retried before giving up
    if (err && (err === 'net' || err === 'timeout' || err === 'busy' || err === 'empty') && attempt < 4) {
      self.timer = setTimeout(function () { self.start(attempt + 1); }, [500, 1500, 3000, 5000][attempt]);
      return;
    }
    if (err) return self.setState('fallback', err);
    self.info = info;
    self.fetcher = new Fetcher(self.url);
    if (probes[self.url]) self.fetcher.target = probes[self.url].fetcher.target;
    var any = false;
    for (var i = 0; i < info.subs.length; i++) {
      var tr = info.subs[i];
      self.byN[tr.n] = tr;
      if (!tr.kind) continue;
      any = true;
      // cues[k] goes with pidx[k] (its index point, -1 = scanned) and skey[k] (its scan key);
      // q numbers the lines (the player asks for q >= since), ep changes when the chosen
      // track loses lines (the player then takes the whole list again)
      self.tracks[tr.num] = { tr: tr, cues: [], pidx: [], skey: [], q: 0, ep: 0, hdr: tr.kind === 'ass' ? parseAssHeader(tr.priv) : null, state: 'pending', total: 0, done: 0 };
    }
    if (!any) return self.setState('fallback', 'notext');
    (function cues(a) {
      loadCues(info, self.fetcher, function (err2) {
        if (self.dead) return;
        if (err2 && (err2 === 'net' || err2 === 'timeout' || err2 === 'busy') && a < 4) {
          info.points = null;
          self.timer = setTimeout(function () { cues(a + 1); }, [500, 1500, 3000, 5000][a]);
          return;
        }
        if (err2 && err2 !== 'nocues') return self.setState('fallback', err2);
        if (err2) { info.points = {}; info.clusters = null; } // no usable index: scan near the playhead
        var all = [];
        self.scanNums = {}; self.hasScan = false;
        for (var num in self.tracks) {
          var t = self.tracks[num], pts = info.points[num];
          if (!pts || !pts.length) { t.state = 'harvesting'; t.scan = true; self.scanNums[num] = true; self.hasScan = true; continue; }
          t.state = 'harvesting'; t.total = pts.length;
          for (var k = 0; k < pts.length; k++) all.push({ t: pts[k].t, d: pts[k].d, cl: pts[k].cl, rel: pts[k].rel, num: +num });
        }
        all.sort(function (a2, z) { return a2.t - z.t || a2.cl - z.cl || a2.rel - z.rel; });
        self.all = all; self.status = new Array(all.length);
        for (var j = 0; j < all.length; j++) self.status[j] = 0;
        if (self.wantN != null) { var w = self.byN[self.wantN]; self.sel = w && self.tracks[w.num] ? w.num : -1; }
        self.setState('harvesting');
        self.pump();
      });
    })(0);
  });
};
Session.prototype.stop = function () {
  this.dead = true;
  if (this.timer) clearTimeout(this.timer);
  if (this.fetcher) this.fetcher.close();
};
Session.prototype.select = function (n) {
  this.wantN = n; // applied once the tracks are known if the head is still being read
  var tr = this.byN[n];
  this.sel = tr && this.tracks[tr.num] ? tr.num : -1;
  this.kick();
};
Session.prototype.track = function (n) { var tr = this.byN[n]; return tr ? this.tracks[tr.num] || null : null; };
// What the caller should do with ordinal n: 'pending' (wait), 'harvesting'/'complete' (cues
// come from here) or 'fallback' (use ffmpeg).
Session.prototype.trackState = function (n) {
  if (this.state === 'fallback') return 'fallback';
  if (this.state === 'starting') return 'pending';
  var t = this.track(n);
  return t ? t.state : 'fallback';
};
Session.prototype.cuesFor = function (n) { var t = this.track(n); return t ? t.cues : []; };
// Lines of ordinal n the player doesn't have: q >= since, or all of them (reset) when its
// epoch is stale. -> { cues, ep, reset }
Session.prototype.cuesSince = function (n, since, ep) {
  var t = this.track(n);
  if (!t) return { cues: [], ep: 0, reset: false };
  if (ep !== t.ep) return { cues: t.cues, ep: t.ep, reset: true };
  var cs = t.cues, out = [];
  for (var i = cs.length - 1; i >= 0 && cs[i].q >= since; i--) out.push(cs[i]); // q grows with k: newest at the end
  out.reverse();
  return { cues: out, ep: t.ep, reset: false };
};
// Drops lines far from the playhead (see KEEP_*): their index points become pending again,
// scan keys are forgotten, so a later pass fetches them anew.
Session.prototype.prune = function () {
  this.prunedAt = Date.now();
  var now = this.now(), seen = {};
  for (var num in this.tracks) {
    var t = this.tracks[num], sel = (+num === this.sel), lo, hi;
    if (sel) {
      if (t.cues.length <= SEL_MAX) { for (var a = 0; a < t.skey.length; a++) if (t.skey[a]) seen[t.skey[a]] = 1; continue; }
      lo = now - SEL_BEHIND_S; hi = now + SEL_AHEAD_S;
    } else {
      lo = now - KEEP_BEHIND_S; hi = now + KEEP_AHEAD_S;
    }
    var cs = [], pi = [], sk = [], dropped = 0;
    for (var k = 0; k < t.cues.length; k++) {
      var c = t.cues[k];
      if (c.e >= lo && c.s <= hi) { cs.push(c); pi.push(t.pidx[k]); sk.push(t.skey[k]); if (t.skey[k]) seen[t.skey[k]] = 1; continue; }
      dropped++;
      var i = t.pidx[k];
      if (i >= 0 && this.status[i] === 2) { this.status[i] = 0; t.done--; }
    }
    if (!dropped) continue;
    t.cues = cs; t.pidx = pi; t.skey = sk;
    if (t.state === 'complete') t.state = 'harvesting';
    if (sel) t.ep++;
  }
  this.seen = seen;
  // scan mode: Clusters whose lines were let go must be read again when the playhead returns
  // (re-reading one is harmless: `seen` drops the lines still kept)
  if (this.hasScan || this.scannedN) {
    var klo = now - KEEP_BEHIND_S, khi = now + KEEP_AHEAD_S, left = {}, n = 0;
    if (this.scannedN <= SCANNED_MAX) for (var cl in this.scanned) { var e = this.scanned[cl]; if (e.t >= klo && e.t <= khi) { left[cl] = e; n++; } }
    this.scanned = left; this.scannedN = n;
  }
};
Session.prototype.setPos = function (t) {
  if (!(t >= 0)) return;
  var jumped = Math.abs(t - this.now()) > 20;
  this.pos = t; this.posAt = Date.now();
  if (jumped) { this.jumpAt = Date.now(); this.scanCur = null; if (this.all || this.hasScan) this.prune(); this.kick(); }
};
// Seconds of video the player has buffered ahead (-1 unknown): the scan waits while it's low.
Session.prototype.setBuf = function (b) { this.buf = b >= 0 ? b : -1; };
Session.prototype.kick = function () {
  if (this.inflight || this.dead || this.state !== 'harvesting') return;
  if (this.timer) clearTimeout(this.timer);
  this.timer = null;
  this.pump();
};
// Playhead estimate between reports (the player reports every few seconds).
Session.prototype.now = function () { return this.pos + Math.min(30, (Date.now() - this.posAt) / 1000); };
// Next pending point: the window [now-BEHIND, now+AHEAD] for every text track, in time order;
// then (debrid) the rest of the chosen track: ahead first, then behind, nearest first.
Session.prototype.pick = function () {
  var all = this.all, st = this.status, now = this.now(), i;
  var lo = now - BEHIND_S, hi = now + (this.p2p ? P2P_AHEAD_S : AHEAD_S);
  var a = 0, z = all.length;
  while (a < z) { var mid = (a + z) >> 1; if (all[mid].t < lo) a = mid + 1; else z = mid; }
  for (i = a; i < all.length && all[i].t <= hi; i++) if (!st[i]) return { i: i, urgent: true };
  if (this.p2p || this.sel < 0) return null;
  var sel = this.tracks[this.sel];
  if (!sel || sel.total > FULL_TRACK_MAX) return null;
  for (; i < all.length; i++) if (!st[i] && all[i].num === this.sel) return { i: i, urgent: false };
  for (i = a - 1; i >= 0; i--) if (!st[i] && all[i].num === this.sel) return { i: i, urgent: false };
  return null;
};
// Points sharing the Range of point i: same Cluster, any track, within MERGE_BYTES.
Session.prototype.group = function (i) {
  var all = this.all, st = this.status, g = [i], p0 = all[i];
  // neighbours in time are neighbours in the file: scan outwards a little, not the whole list
  for (var dir = -1; dir <= 1; dir += 2) {
    for (var j = i + dir; j >= 0 && j < all.length && g.length < 96; j += dir) {
      var p = all[j];
      if (Math.abs(p.t - p0.t) > 30) break;
      if (st[j] || p.cl !== p0.cl) continue;
      if (p0.rel < 0 || p.rel < 0) { if (p0.rel < 0 && p.rel < 0) g.push(j); continue; }
      if (Math.abs(p.rel - p0.rel) <= MERGE_BYTES) g.push(j);
    }
  }
  return g;
};
Session.prototype.rateOk = function (urgent) {
  var now = Date.now(), lim = urgent ? RATE_URGENT : RATE;
  while (this.sent.length && now - this.sent[0] > 1000) this.sent.shift();
  return this.sent.length < lim ? 0 : 1000 - (now - this.sent[0]) + 5;
};
Session.prototype.checkComplete = function () {
  for (var num in this.tracks) {
    var t = this.tracks[num];
    if (t.state === 'harvesting' && t.total && t.done >= t.total) { t.state = 'complete'; this.setState('harvesting'); }
  }
};
Session.prototype.pump = function () {
  var self = this;
  if (self.dead || self.inflight || self.state !== 'harvesting') return;
  self.timer = null;
  if (Date.now() - self.prunedAt > PRUNE_EVERY_MS) self.prune();
  var wait = self.backoffUntil - Date.now();
  if (wait > 0) { self.timer = setTimeout(function () { self.pump(); }, wait); return; }
  var next = self.pick();
  if (!next) {
    if (self.hasScan) return self.scanStep();
    self.timer = setTimeout(function () { self.pump(); }, 1000); // wait for the playhead
    return;
  }
  wait = self.rateOk(next.urgent);
  if (wait > 0) { self.timer = setTimeout(function () { self.pump(); }, wait); return; }
  var g = self.group(next.i);
  for (var k = 0; k < g.length; k++) self.status[g[k]] = 1;
  self.inflight = true; self.sent.push(Date.now());
  var askedAt = Date.now();
  self.fetchGroup(g, function (err) {
    self.inflight = false;
    if (self.dead) return;
    if (self.jumpAt >= askedAt) self.prune(); // the playhead moved while this was in flight
    if (err) {
      for (var k2 = 0; k2 < g.length; k2++) if (self.status[g[k2]] === 1) self.status[g[k2]] = 0;
      self.fails++;
      if (err === 'norange' || /^http(401|403|404|410|416)$/.test(err)) {
        var have = 0; for (var num in self.tracks) have += self.tracks[num].cues.length;
        if (!have || self.fails > 6) return self.setState('fallback', err);
      }
      // the server asks for calm (429/5xx/timeout): pause 10 s doubling to 60 s; else 0.5..8 s
      var calm = err === 'busy' || err === 'timeout';
      self.backoffMs = calm ? Math.min(60000, Math.max(10000, self.backoffMs * 2)) : Math.min(8000, Math.max(500, self.backoffMs * 2));
      self.backoffUntil = Date.now() + self.backoffMs;
    } else { self.fails = 0; self.backoffMs = 0; }
    self.checkComplete();
    self.pump();
  });
};
Session.prototype.markDone = function (i, gotCue) {
  if (this.status[i] >= 2) return;
  this.status[i] = gotCue ? 2 : 3;
  var t = this.tracks[this.all[i].num]; if (t) t.done++;
};
// Fetches one group and turns its blocks into cues. cb(err)
Session.prototype.fetchGroup = function (g, cb) {
  var self = this, all = self.all, p0 = all[g[0]];
  if (p0.rel < 0) return self.fetchCluster(g, cb);
  var lo = p0.rel, hi = p0.rel;
  for (var k = 1; k < g.length; k++) { lo = Math.min(lo, all[g[k]].rel); hi = Math.max(hi, all[g[k]].rel); }
  // CueRelativePosition counts from the Cluster's DATA start: Cluster ID (4) + size vint (1-8).
  // Read from 7 bytes early and find the header length (learned once per file).
  var start = p0.cl + 5 + lo, slack = 7;
  self.fetcher.range(start, (hi - lo) + slack + BLOCK_BYTES, function (err, buf) {
    if (self.dead) return;
    if (err || !buf || !buf.length) return cb(err || 'net');
    var pending = [];
    for (var k = 0; k < g.length; k++) {
      var i = g[k], p = all[i], r = self.findBlock(buf, p.rel - lo, p.num);
      if (!r) { self.markDone(i, false); continue; }
      if (r.blk.len < 0) { pending.push({ i: i, abs: start + r.off, total: r.blk.total }); continue; }
      self.addCue(i, r.blk);
    }
    if (!pending.length) return cb(null);
    // a long event (karaoke, vector sign) that didn't fit in BLOCK_BYTES: one more read each
    (function more(j) {
      if (j >= pending.length || self.dead) return cb(null);
      var q = pending[j];
      self.fetcher.rangeFull(q.abs, q.total, function (e2, b2) {
        var blk = (!e2 && b2) ? readBlock(b2, 0, all[q.i].num) : null;
        if (blk && blk.len > 0) self.addCue(q.i, blk); else self.markDone(q.i, false);
        more(j + 1);
      });
    })(0);
  });
};
// The block of a point begins at buf[base + h - 5] for the file's Cluster header length h
// (5..12). Tries the learned length first.
Session.prototype.findBlock = function (buf, base, num) {
  var order = [], h;
  if (this.hdrLenBest) order.push(this.hdrLenBest);
  for (h = 5; h <= 12; h++) if (h !== this.hdrLenBest) order.push(h);
  for (var k = 0; k < order.length; k++) {
    h = order[k];
    var off = base + (h - 5);
    if (off < 0) continue;
    var blk = readBlock(buf, off, num);
    if (blk) {
      this.hdrLen[h] = (this.hdrLen[h] || 0) + 1;
      if (!this.hdrLenBest || this.hdrLen[h] > (this.hdrLen[this.hdrLenBest] || 0)) this.hdrLenBest = h;
      return { off: off, blk: blk };
    }
  }
  return null;
};
// No CueRelativePosition: read the Cluster (bounded) and take every text block in it.
Session.prototype.fetchCluster = function (g, cb) {
  var self = this, all = self.all, cl = all[g[0]].cl;
  self.fetcher.range(cl, 16, function (err, head) {
    if (self.dead) return;
    if (err || !head) return cb(err || 'net');
    var e = readId(head, 0), s = e && readSize(head, e.len);
    if (!e || e.id !== ID.CLUSTER || !s || s.size < 0 || s.size > 16 * 1024 * 1024) { for (var k = 0; k < g.length; k++) self.markDone(g[k], false); return cb(null); }
    var d = e.len + s.len;
    self.fetcher.rangeFull(cl, d + s.size, function (err2, buf) {
      if (self.dead) return;
      if (err2 || !buf) return cb(err2 || 'net');
      var clTs = 0, scale = self.info.tscale / 1e9;
      each(buf, d, buf.length, function (id, cd, cs, at) {
        if (cs < 0) return true;
        if (id === ID.TIMESTAMP) { clTs = readUint(buf, cd, cs); return; }
        if (id !== ID.BLOCKGROUP && id !== ID.SIMPLEBLOCK) return;
        for (var j = 0; j < g.length; j++) {
          var i = g[j];
          if (self.status[i] !== 1) continue;
          var b = readBlock(buf, at, all[i].num);
          if (!b || !b.payload) continue;
          if (Math.abs((clTs + b.ts) * scale - all[i].t) < 0.002) { self.addCue(i, b); break; }
        }
      });
      for (var j2 = 0; j2 < g.length; j2++) if (self.status[g[j2]] === 1) self.markDone(g[j2], false);
      cb(null);
    });
  });
};
Session.prototype.addCue = function (i, blk) {
  var p = this.all[i], t = this.tracks[p.num];
  var cue = t && blk.payload ? this.makeCue(t, blk, p.t, p.d) : null;
  this.markDone(i, !!cue);
  if (!cue) return;
  cue.q = t.q++; t.cues.push(cue); t.pidx.push(i); t.skey.push(null);
  if (!this.firstCueAt) this.firstCueAt = Date.now();
};
Session.prototype.makeCue = function (t, blk, s, cueDur) {
  var scale = this.info.tscale / 1e9, data = decodePayload(t.tr, blk.payload);
  if (!data) return null;
  var dur = blk.dur >= 0 ? blk.dur * scale : (cueDur >= 0 ? cueDur : DEFAULT_DUR_S);
  var e = s + (dur > 0 ? dur : 0.5), txt = data.toString('utf8');
  var cue = t.tr.kind === 'ass' ? assCue(txt, s, e, t.hdr) : textCue(txt, s, e);
  if (!cue) return null;
  cue.s = Math.round(cue.s * 1000) / 1000; cue.e = Math.round(cue.e * 1000) / 1000;
  return cue;
};
// ---- scan mode ----
Session.prototype.scanRateOk = function (lim) {
  var now = Date.now();
  while (this.scanSent.length && now - this.scanSent[0] > 1000) this.scanSent.shift();
  return this.scanSent.length < lim ? 0 : 1000 - (now - this.scanSent[0]) + 5;
};
Session.prototype.idle = function (ms) { var self = this; self.timer = setTimeout(function () { self.pump(); }, ms); };
// One step: locate a Cluster near the playhead, or read the next chunk from the cursor.
// The cursor is { pos (next byte to parse), inCl (inside a Cluster), clStart, end, raw, ts }.
Session.prototype.scanStep = function () {
  var self = this, now = self.now(), lo = now - BEHIND_S, hi = now + SCAN_AHEAD_S, cur = self.scanCur;
  if (cur && (cur.ts >= 0 && cur.ts < lo - 120 || cur.ts > hi + 120)) cur = self.scanCur = null; // the playhead went elsewhere
  if (cur && !cur.inCl && cur.ts > hi) return self.idle(1000); // next Cluster starts past the window
  // the lines at the playhead are urgent; beyond that, scan gently and never while buffering is low
  var urgent = !cur || cur.ts < 0 || cur.ts < now + 10;
  if (!urgent && self.buf >= 0 && self.buf < SCAN_MIN_BUFFER_S) return self.idle(1000);
  var wait = self.scanRateOk(urgent ? RATE_URGENT : SCAN_RATE);
  if (wait > 0) return self.idle(wait);
  self.inflight = true; self.scanSent.push(Date.now());
  var askedAt = Date.now();
  function done(err) {
    self.inflight = false;
    if (self.dead) return;
    if (self.jumpAt >= askedAt) self.prune(); // the playhead moved while this was in flight
    if (err) { self.backoffMs = Math.min(8000, Math.max(1000, self.backoffMs * 2)); self.backoffUntil = Date.now() + self.backoffMs; }
    else self.backoffMs = 0;
    self.pump();
  }
  if (!cur) return self.scanLocate(Math.max(0, now - 4), done);
  self.scanRead(cur, hi, done);
};
// Puts the scan cursor on the last Cluster that starts at or before `target`.
Session.prototype.scanLocate = function (target, cb) {
  var self = this, info = self.info, list = info.clusters;
  if (list && list.length) {
    var a = 0, z = list.length;
    while (a < z) { var m = (a + z) >> 1; if (list[m].t <= target) a = m + 1; else z = m; }
    var c = list[Math.max(0, a - 1)];
    self.scanCur = { pos: c.cl, inCl: false, ts: c.t };
    return cb(null);
  }
  // no index: jump by bitrate, then find the next Cluster in the bytes
  var segEnd = info.segEnd > 0 ? info.segEnd : info.size, first = info.firstCluster;
  function startAt(pos) { self.scanCur = { pos: pos, inCl: false, ts: -1 }; cb(null); }
  function haveFirst() {
    if (!(info.duration > 0) || !(segEnd > first) || target < 30) return startAt(first);
    var rate = (segEnd - first) / info.duration, tries = 0;
    (function probeAt(byte) {
      byte = Math.max(first, Math.min(segEnd - 1024, Math.floor(byte)));
      self.fetcher.range(byte, 256 * 1024, function (err, buf) {
        if (self.dead) return;
        if (err || !buf) return cb(err || 'net');
        var hit = findCluster(buf);
        if (hit < 0) return ++tries < 6 ? probeAt(byte + buf.length - 16) : startAt(first);
        var c = readId(buf, hit), sz = readSize(buf, hit + 4), ts = -1;
        each(buf, hit + 4 + sz.len, buf.length, function (id, d, size) { if (id === ID.TIMESTAMP && size > 0) ts = readUint(buf, d, size) * info.tscale / 1e9; return true; });
        var pos = byte + hit;
        if (ts < 0 || ++tries >= 5) return startAt(pos);
        if (ts > target + 1) return probeAt(pos - (ts - target) * rate - 512 * 1024);
        if (ts < target - 90) return probeAt(pos + (target - ts) * rate - 256 * 1024);
        self.scanCur = { pos: pos, inCl: false, ts: ts };
        cb(null);
      });
    })(first + (target - 10) * rate);
  }
  if (first >= 0) return haveFirst();
  // the head was all attachments (fonts): walk the top-level elements to the first Cluster
  var o = info.segStart, steps = 0;
  (function walk() {
    self.fetcher.range(o, 16, function (err, b) {
      if (self.dead) return;
      var e = !err && b && readId(b, 0), sz = e && readSize(b, e.len);
      if (!e || !sz || sz.size < 0 || ++steps > 32) return cb(err || 'nocluster');
      if (e.id === ID.CLUSTER) { first = info.firstCluster = o; return haveFirst(); }
      o += e.len + sz.len + sz.size;
      walk();
    });
  })();
};
// Offset of a plausible Cluster start in buf (ID, then a size, then a Timestamp child), or -1.
function findCluster(buf) {
  for (var i = 0; i + 12 < buf.length; i++) {
    if (buf[i] !== 0x1F || buf[i + 1] !== 0x43 || buf[i + 2] !== 0xB6 || buf[i + 3] !== 0x75) continue;
    var sz = readSize(buf, i + 4);
    if (!sz) continue;
    var c = readId(buf, i + 4 + sz.len);
    if (c && (c.id === ID.TIMESTAMP || c.id === 0xBF /* CRC-32 */)) return i;
  }
  return -1;
}
// Reads one chunk from the cursor and takes the text blocks of the scanned tracks, through as
// many Clusters as the chunk holds (streamed MKVs use Clusters of a few tens of KB).
Session.prototype.scanRead = function (cur, hi, cb) {
  var self = this, info = self.info, scale = info.tscale / 1e9;
  var start = cur.pos, len = cur.need || SCAN_CHUNK;
  cur.need = 0;
  if (info.size > 0) len = Math.min(len, info.size - start);
  if (len <= 0) { self.scanCur = null; self.hasScan = false; return cb(null); } // end of file
  self.fetcher.range(start, len, function (err, buf) {
    if (self.dead) return;
    if (err || !buf || !buf.length) return cb(err || 'net');
    var o = 0;
    while (o < buf.length) {
      var abs = start + o;
      if (cur.inCl && abs >= cur.end) { if (!self.scanned[cur.clStart]) self.scannedN++; self.scanned[cur.clStart] = { t: cur.ts }; cur.inCl = false; cur.ts = -1; continue; }
      var el = readId(buf, o), es = el && readSize(buf, o + el.len);
      if (!el || !es) break; // header cut by the chunk: the next read starts here
      var hdr = el.len + es.len, total = hdr + es.size, d = o + hdr;
      if (!cur.inCl) {
        if (el.id === ID.CLUSTER && es.size >= 0) {
          if (self.scanned[abs]) { o += total; continue; } // read before: skip it (no download if it runs past the chunk)
          cur.inCl = true; cur.clStart = abs; cur.end = abs + total; cur.raw = -1; cur.ts = -1;
          o = d; continue;
        }
        if (es.size < 0 || el.id === ID.EBML || el.id === ID.SEGMENT) { self.scanCur = null; return cb(null); } // lost: relocate
        o += total; continue; // Cues, Tags, Void... between Clusters
      }
      if (es.size < 0) { self.scanCur = null; return cb(null); }
      if (el.id === ID.TIMESTAMP) {
        if (d + es.size > buf.length) break;
        cur.raw = readUint(buf, d, es.size); cur.ts = cur.raw * scale;
        if (cur.ts > hi) { cur.pos = cur.clStart; cur.inCl = false; return cb(null); } // past the window: wait at this Cluster
      } else if (el.id === ID.BLOCKGROUP || el.id === ID.SIMPLEBLOCK) {
        var num = blockTrack(buf, o, el, es);
        if (num > 0 && self.scanNums[num]) {
          if (o + total > buf.length) { // a text block cut by the chunk: read exactly it next
            if (total <= 1024 * 1024) { cur.pos = abs; cur.need = total; return cb(null); }
          } else {
            var blk = readBlock(buf, o, num);
            if (blk && blk.payload && cur.raw >= 0) self.scanCue(num, blk, (cur.raw + blk.ts) * scale);
          }
        }
      }
      o += total; // a video/audio block running past the chunk is skipped: the next read starts after it
    }
    cur.pos = start + o;
    cb(null);
  });
};
// Track number of the block element at buf[o] (from its first bytes), or -1.
function blockTrack(buf, o, el, es) {
  var d = o + el.len + es.len;
  if (el.id === ID.BLOCKGROUP) {
    var c = readId(buf, d), cs = c && readSize(buf, d + c.len);
    if (!c || c.id !== ID.BLOCK || !cs) return -1;
    d += c.len + cs.len;
  }
  var tv = readSize(buf, d);
  return tv ? tv.size : -1;
}
Session.prototype.scanCue = function (num, blk, s) {
  var key = num + ':' + Math.round(s * 1000);
  if (this.seen[key]) return;
  this.seen[key] = 1;
  var t = this.tracks[num];
  var cue = t ? this.makeCue(t, blk, s, -1) : null;
  if (!cue) return;
  cue.q = t.q++; t.cues.push(cue); t.pidx.push(-1); t.skey.push(key);
  if (!this.firstCueAt) this.firstCueAt = Date.now();
};
Session.prototype.stats = function (n) {
  var t = n != null ? this.track(n) : null;
  return { state: this.state, track: t ? t.state : '', cues: t ? t.cues.length : 0, points: t ? t.total : 0, done: t ? t.done : 0,
    requests: this.fetcher ? this.fetcher.requests : 0, bytes: this.fetcher ? this.fetcher.bytes : 0, firstCueMs: this.firstCueAt ? this.firstCueAt - this.startedAt : -1 };
};

module.exports = { probe: probe, chapters: chapters, Session: Session };
