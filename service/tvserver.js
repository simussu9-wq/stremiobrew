// StremioBrew local helper service. Runs on the TV's own Node (webOS 4.x ships v0.12, so
// this file is strict ES5 + Node 0.12 APIs), started by the app via the Homebrew Channel
// exec; listens on 127.0.0.1:8080 only.
//
// It does what a file:// webview can't do on its own:
//   - CORS-free fetches (/meta, /subs, /sub, /trailer)
//   - P2P: supervises the nuvio-engine runner (bin/nuvio-bridge) and proxies its streams (/p2p*)
//   - a Range-aware /proxy for debrid CDN URLs that need it
//   - ffmpeg helpers: media info for /embtracks, the embedded-subtitle fallback
//   - embedded subtitles: /embtracks|/embstart|/embcues (mkvsubs.js reads only the subtitle
//     blocks of a Matroska; ffmpeg extraction is the fallback)
var http = require('http');
var https = require('https');
var path = require('path');
var zlib = require('zlib');
var urlmod = require('url');
var spawn = require('child_process').spawn;
var net = require('net');
var mkvsubs = require('./mkvsubs.js');

var fs = require('fs');
var DIR = __dirname;

function dbg(m) { try { fs.appendFileSync(path.join(DIR, 'tvserver.log'), new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} }
dbg('tvserver starting, uid=' + (process.getuid ? process.getuid() : '?'));
process.on('uncaughtException', function (e) { dbg('UNCAUGHT: ' + (e && e.stack || e)); });

// Runs on the TV's own Node (webOS 4.x ships v0.12), whose built-in root store dates
// from ~2017 and lacks newer roots (ISRG X1, Amazon...). Use the current Mozilla CA
// bundle shipped next to this file for every HTTPS request (all go via globalAgent).
try {
  var CAS = fs.readFileSync(path.join(DIR, 'cacert.pem'), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (CAS && CAS.length) { https.globalAgent.options.ca = CAS; dbg('CA bundle: ' + CAS.length + ' roots'); }
} catch (e) { dbg('CA bundle missing, using built-in roots: ' + e.message); }

var PORT = +process.env.SB_PORT || 8080; // SB_PORT: tests only

// ---- helpers for meta/subtitle fetching ----
function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
var LANGS = { eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', ara: 'Arabic', dut: 'Dutch', nld: 'Dutch', pol: 'Polish', tur: 'Turkish', swe: 'Swedish', rum: 'Romanian', ron: 'Romanian', gre: 'Greek', heb: 'Hebrew', hin: 'Hindi', kor: 'Korean', jpn: 'Japanese', chi: 'Chinese', zho: 'Chinese', cze: 'Czech', dan: 'Danish', fin: 'Finnish', nor: 'Norwegian', hun: 'Hungarian', bul: 'Bulgarian', ukr: 'Ukrainian', srp: 'Serbian', hrv: 'Croatian', slo: 'Slovak', slv: 'Slovenian', spl: 'Spanish (LA)', pob: 'Portuguese (BR)' };
function langName(l) { return LANGS[l] || (l ? l.toUpperCase() : 'Unknown'); }
function guessLang(name, url) {
  var u = String(url || '').toLowerCase();
  var m = u.match(/\/([a-z]{2,3})[-_]/);
  if (m) {
    var c = m[1];
    if (c === 'en') return 'eng';
    if (c === 'es') return 'spa';
    if (c === 'fr') return 'fre';
    if (c === 'de') return 'ger';
    if (c === 'it') return 'ita';
    if (c === 'pt') return 'por';
    if (c === 'ru') return 'rus';
    if (c === 'ar') return 'ara';
    if (c === 'nl') return 'dut';
    if (c === 'pl') return 'pol';
    if (c === 'tr') return 'tur';
    if (c === 'sv') return 'swe';
    if (c === 'ro') return 'rum';
    if (c === 'el') return 'gre';
    if (c === 'he') return 'heb';
    if (c === 'hi') return 'hin';
    if (c === 'ko') return 'kor';
    if (c === 'ja') return 'jpn';
    if (c === 'zh') return 'chi';
    if (c.length === 3) return c;
  }
  var nm = String(name || '').toLowerCase();
  for (var k in LANGS) { if (LANGS[k].toLowerCase() === nm) return k; }
  return 'eng';
}
var FETCH_MAX = 16 * 1024 * 1024;
function fetchUrl(u, cb0, depth) {
  depth = depth || 0;
  var called = false;
  function cb(v) { if (!called) { called = true; cb0(v); } }
  if (!u || depth > 5) return cb(null);
  var lib = u.indexOf('https:') === 0 ? https : http;
  var pu = urlmod.parse(u);
  var opts = {
    protocol: pu.protocol,
    hostname: pu.hostname,
    port: pu.port,
    path: pu.path,
    headers: {
      'User-Agent': /(^|\.)(youtube\.com|googlevideo\.com|ytimg\.com)$/.test(pu.hostname || '') ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)' : 'Mozilla/5.0 (Web0S; Linux) StremioBrew',
      'Accept': '*/*'
    }
  };
  var req;
  try { req = lib.get(opts, onres); } catch (e) { return cb(null); }
  function onres(r) {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      var loc = r.headers.location;
      if (loc.indexOf('http') !== 0) { var pu = urlmod.parse(u); loc = pu.protocol + '//' + pu.host + (loc.charAt(0) === '/' ? '' : '/') + loc; }
      return fetchUrl(loc, cb, depth + 1);
    }
    // whatever comes through here is JSON, a playlist or a subtitle file: anything bigger is a
    // wrong URL, and buffering it whole would take the TV's last free RAM
    var chunks = [], got = 0, over = false;
    r.on('data', function (d) {
      if (over) return;
      got += d.length;
      if (got > FETCH_MAX) { over = true; chunks = []; try { req.abort(); } catch (e) {} return cb(null); }
      chunks.push(d);
    });
    r.on('end', function () {
      if (over) return;
      var buf = Buffer.concat(chunks);
      if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
      cb(buf);
    });
  }
  req.on('error', function () { cb(null); });
  req.setTimeout(12000, function () { try { req.abort(); } catch (e) {} });
}
function fetchJson(u, cb) { fetchUrl(u, function (buf) { if (!buf) return cb(null); try { cb(JSON.parse(buf.toString('utf8'))); } catch (e) { cb(null); } }); }

// ---- a stream's file size for the player's info line: one 1-byte range request (debrid links and the P2P
// engine both answer "Content-Range: bytes 0-0/<total>"), redirects followed; remembered per URL ----
var sizeMem = {}, sizeMemN = 0;
function streamSize(u, cb0, depth) {
  depth = depth || 0; var done = false;
  function cb(v) { if (!done) { done = true; cb0(v); } }
  if (!/^https?:\/\//.test(u || '') || depth > 5) return cb(0);
  var pu = urlmod.parse(u), lib = pu.protocol === 'https:' ? https : http, req;
  try {
    req = lib.get({ hostname: pu.hostname, port: pu.port, path: pu.path, headers: { 'User-Agent': 'Mozilla/5.0 (Web0S; Linux) StremioBrew', 'Range': 'bytes=0-0', 'Accept-Encoding': 'identity' } }, function (r) {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); var loc = urlmod.resolve(u, r.headers.location); return streamSize(loc, cb, depth + 1); }
      var cr = /\/(\d+)\s*$/.exec(r.headers['content-range'] || ''), n = cr ? +cr[1] : (r.statusCode === 200 ? +(r.headers['content-length'] || 0) : 0);
      try { req.abort(); } catch (e) {} // never read the body (a 200 would be the whole film)
      cb(n || 0);
    });
  } catch (e) { return cb(0); }
  req.on('error', function () { cb(0); });
  req.setTimeout(10000, function () { try { req.abort(); } catch (e) {} cb(0); });
}

// ---- byte proxy for ffmpeg ----
// The bundled ffmpeg is a minimal static build with no TLS (and static libcs can't
// always resolve DNS on the TV). So ffmpeg never touches the network directly: it talks plain HTTP to us on
// 127.0.0.1 and node (which resolves DNS fine) does the real HTTPS fetch, follows
// debrid redirects, and streams the bytes back, honouring Range so ffmpeg can seek.
function localProxy(u) { return 'http://127.0.0.1:' + PORT + '/proxy?u=' + encodeURIComponent(u); }
var resolveCache = {}; // original debrid url -> { url: resolved-CDN-url, at: ts }
var activeProxy = 0;   // video streams piping through this helper right now (memory watchdog)
function proxyStream(target, range, method, clientRes, orig, depth, triedFresh) {
  depth = depth || 0;
  if (!target || depth > 6) { try { if (!clientRes.headersSent) clientRes.writeHead(502); clientRes.end(); } catch (e) {} return; }
  var pu;
  try { pu = urlmod.parse(target); } catch (e) { try { clientRes.writeHead(502); clientRes.end(); } catch (x) {} return; }
  var lib = pu.protocol === 'https:' ? https : http;
  var hdrs = { 'User-Agent': 'Stremio-TV/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  if (range) hdrs.Range = range;
  var opts = { protocol: pu.protocol, hostname: pu.hostname, port: pu.port, path: pu.path, method: method === 'HEAD' ? 'HEAD' : 'GET', headers: hdrs };
  var upReq;
  try { upReq = lib.request(opts, onUp); } catch (e) { try { clientRes.writeHead(502); clientRes.end(); } catch (x) {} return; }
  function onUp(up) {
    var sc = up.statusCode;
    if (sc >= 300 && sc < 400 && up.headers.location) {
      up.resume();
      var loc = up.headers.location;
      if (loc.indexOf('http') !== 0) loc = pu.protocol + '//' + pu.host + (loc.charAt(0) === '/' ? '' : '/') + loc;
      return proxyStream(loc, range, method, clientRes, orig, depth + 1, triedFresh);
    }
    // A cached signed CDN url likely expired — restart from the original once.
    if ((sc === 403 || sc === 410 || sc === 404) && !triedFresh && target !== orig) {
      up.resume(); delete resolveCache[orig];
      return proxyStream(orig, range, method, clientRes, orig, 0, true);
    }
    if (orig) resolveCache[orig] = { url: target, at: Date.now() }; // remember the working CDN url
    var h = {};
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach(function (k) {
      if (up.headers[k] != null) h[k] = up.headers[k];
    });
    if (!h['accept-ranges']) h['accept-ranges'] = 'bytes';
    h['access-control-allow-origin'] = '*';
    h['access-control-allow-headers'] = 'Range, Origin, Content-Type, Accept';
    h['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges';
    try { clientRes.writeHead(sc, h); } catch (e) { try { up.destroy(); } catch (x) {} return; }
    activeProxy++;
    var counted = true;
    function unc() { if (counted) { counted = false; activeProxy--; } }
    clientRes.on('close', unc); clientRes.on('finish', unc);
    up.pipe(clientRes);
    up.on('error', function () { try { clientRes.end(); } catch (e) {} });
  }
  upReq.on('error', function () { try { if (!clientRes.headersSent) clientRes.writeHead(502); clientRes.end(); } catch (x) {} });
  upReq.setTimeout(20000, function () { try { upReq.abort(); } catch (e) {} });
  clientRes.on('close', function () { try { upReq.abort(); } catch (e) {} }); // ffmpeg drops the connection on every seek
  upReq.end();
}
function decodeHtmlEntities(t) {
  return String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n+/g, ' ').trim();
}
function parseSrt(srt) {
  if (!srt) return [];
  // YouTube timedtext XML support (both srv3 <p t="ms" d="ms"> and classic <text start="s" dur="s">)
  if (srt.indexOf('<timedtext') >= 0 || srt.indexOf('<transcript') >= 0 || srt.indexOf('<text ') >= 0 || srt.indexOf('<p ') >= 0) {
    var xcues = [];
    var pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g, pm;
    while ((pm = pRe.exec(srt)) !== null) {
      var ps = parseInt(pm[1], 10) / 1000, pd = parseInt(pm[2], 10) / 1000;
      var ptxt = decodeHtmlEntities(pm[3].replace(/<[^>]+>/g, ''));
      if (ptxt) xcues.push({ s: ps, e: ps + pd, t: ptxt });
    }
    if (xcues.length) return xcues;
    var tRe = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g, tm;
    while ((tm = tRe.exec(srt)) !== null) {
      var ts = parseFloat(tm[1]), td = parseFloat(tm[2]);
      var ttxt = decodeHtmlEntities(tm[3]);
      if (ttxt) xcues.push({ s: ts, e: ts + td, t: ttxt });
    }
    if (xcues.length) return xcues;
  }
  srt = srt.replace(/\r/g, '');
  var blocks = srt.split(/\n\n+/), cues = [];
  function toSec(h, m, s, ms) { return (h ? (+h) : 0) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000; }
  for (var b = 0; b < blocks.length; b++) {
    var lines = blocks[b].split('\n'), tc = -1;
    for (var i = 0; i < lines.length; i++) { if (lines[i].indexOf('-->') >= 0) { tc = i; break; } }
    if (tc < 0) continue;
    var m = lines[tc].match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    var s = toSec(m[1], m[2], m[3], m[4]);
    var e = toSec(m[5], m[6], m[7], m[8]);
    var txt = lines.slice(tc + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (txt) cues.push({ s: s, e: e, t: txt });
  }
  return cues;
}

// ---- ffmpeg: media info and the embedded-subtitle fallback ----
// This TV's native player never hands embedded subtitle cues to JS. Matroska subtitles come
// from mkvsubs.js (subtitle blocks only); ffmpeg reads them only when that can't (MP4...).
var FFMPEG = process.env.TV_FFMPEG || (process.platform === 'darwin' && fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : path.join(DIR, 'bin', 'ffmpeg'));
var IMG_SUB = { hdmv_pgs_subtitle: 1, dvd_subtitle: 1, dvb_subtitle: 1, xsub: 1, dvb_teletext: 1 };

// ---- media info WITHOUT ffprobe (saves ~30MB on the TV) ----
// `ffmpeg -i <url>` with no output prints the same stream table ffprobe reads (to stderr)
// and exits. Parsed into exactly the fields /embtracks uses.
// One probe at a time, single-threaded: probing decodes a few video frames, and a 4K HEVC
// frame-threaded decoder (one context per core) can take far more RAM than this TV has free
// while its own player is decoding the same film.
var ffInfoBusy = false, ffInfoQueue = [];
function ffInfo(u, timeoutMs, cb) {
  if (ffInfoBusy) {
    if (ffInfoQueue.length >= 3) return cb({ streams: [], err: 'busy' });
    return ffInfoQueue.push([u, timeoutMs, cb]);
  }
  ffInfoBusy = true;
  ffInfoRun(u, timeoutMs, function (r) {
    ffInfoBusy = false;
    var nx = ffInfoQueue.shift();
    if (nx) ffInfo(nx[0], nx[1], nx[2]);
    cb(r);
  });
}
function ffInfoRun(u, timeoutMs, cb) {
  var err = [], done = false, pr, to;
  function finish() {
    if (done) return; done = true; clearTimeout(to);
    cb(parseFfInfo(Buffer.concat(err).toString('utf8')));
  }
  try { pr = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-threads', '1', '-i', localProxy(u)]); } catch (e) { return cb({ streams: [], err: 'ffmpeg missing' }); }
  to = setTimeout(function () { try { pr.kill(); } catch (e) {} finish(); }, timeoutMs);
  pr.stderr.on('data', function (d) { err.push(d); });
  pr.on('error', function (e) { if (done) return; done = true; clearTimeout(to); cb({ streams: [], err: 'ffmpeg error: ' + (e && e.code || e) }); });
  pr.on('close', finish);
}
function chanCount(lay) { // "5.1(side)" -> 6, "7.1" -> 8, "stereo" -> 2, "mono" -> 1, "3 channels" -> 3
  var m = /^(\d+) channels/.exec(lay); if (m) return parseInt(m[1], 10);
  if (lay === 'mono') return 1; if (lay === 'stereo') return 2;
  m = /^(\d+)\.(\d+)/.exec(lay); return m ? parseInt(m[1], 10) + parseInt(m[2], 10) : 0;
}
function parseFfInfo(txt) {
  var lines = txt.split('\n'), info = { streams: [], duration: 0, bitrate: 0, err: '' }, cur = null, m;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\s*Duration: /.test(l)) {
      cur = null;
      if ((m = /Duration: (\d+):(\d+):([\d.]+)/.exec(l))) info.duration = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      if ((m = /bitrate: (\d+) kb\/s/.exec(l))) info.bitrate = parseInt(m[1], 10) * 1000;
    } else if ((m = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/.exec(l))) {
      var desc = m[3];
      cur = { type: m[2].toLowerCase(), lang: (m[1] || '').toLowerCase(), codec: desc.split(/[ ,]/)[0], desc: desc, title: '', dovi: false };
      if (cur.lang === 'und') cur.lang = '';
      if (cur.type === 'video') {
        var hm = /, (\d{2,5})x(\d{2,5})/.exec(desc); cur.height = hm ? parseInt(hm[2], 10) : 0;
        cur.trc = /smpte2084/.test(desc) ? 'smpte2084' : (/arib-std-b67/.test(desc) ? 'arib-std-b67' : '');
        if (/\((dvh[e1]|dav1) \//.test(desc)) cur.dovi = true;
        cur.attached = /\(attached pic\)/.test(desc);
      } else if (cur.type === 'audio') {
        var am = /Hz, ([^,]+)/.exec(desc); cur.channels = am ? chanCount(am[1].trim()) : 0;
      }
      info.streams.push(cur);
    } else if (/^\s*(Chapter #|Input #|Output #)/.test(l)) {
      cur = null;
    } else if (cur && (m = /^\s+title\s*: (.*)$/.exec(l))) {
      if (!cur.title) cur.title = m[1].trim();
    } else if (cur && /DOVI configuration record/i.test(l)) {
      cur.dovi = true;
    }
  }
  if (!info.streams.length) { // surface the reason (404, unsupported, timeout) like ffprobe's stderr did
    for (var k = lines.length - 1; k >= 0; k--) {
      var t = lines[k].trim();
      if (t && t !== 'At least one output file must be specified') { info.err = t.slice(0, 160); break; }
    }
  }
  return info;
}

function embTracks(u, t, res, lazy) {
  if (!u) return sendJson(res, { tracks: [] });
  // Matroska: one 64 KB read lists the tracks; the index is fetched right behind it so that
  // picking a track starts on the subtitle blocks at once
  mkvsubs.probe(u, function (err, info) {
    // not Matroska: listing means ffmpeg reading the file's index (an MP4's can sit at the END: over a torrent
    // that pulls far pieces in while the film starts, with the TV short of memory) - only when asked for
    if (err || !info) { if (lazy) { console.log('[embtracks] not mkv: listed when Subtitles opens'); return sendJson(res, { tracks: [], later: true }); }
      console.log('[embtracks] mkv probe: ' + err + ' -> ffmpeg'); return embTracksFf(u, res); }
    var tracks = [], ti = 0;
    for (var i = 0; i < info.subs.length; i++) {
      var st = info.subs[i];
      if (!st.kind) continue; // image (PGS/VobSub) or encrypted: not text
      var nm = langName(st.lang);
      if (st.name && st.name.toLowerCase() !== nm.toLowerCase()) nm += ' — ' + st.name;
      if (st.forced && !/forced/i.test(nm)) nm += ' (Forced)';
      tracks.push({ n: st.n, ti: ti, name: nm, lang: st.lang || '', forced: st.forced || undefined, ass: st.kind === 'ass' || undefined });
      ti++;
    }
    console.log('[embtracks] mkv found=' + tracks.length + ' of ' + info.subs.length + ' subtitle tracks');
    if (tracks.length) subSession(u, t, true); // harvest every text track around the playhead now
    sendJson(res, { tracks: tracks, err: '' });
  });
}
function embTracksFf(u, res) {
  ffInfo(u, 20000, function (inf) {
    var tracks = [], n = 0, ti = 0;
    for (var i = 0; i < inf.streams.length; i++) {
      var st = inf.streams[i];
      if (st.type !== 'subtitle') continue;
      var sn = n++; // ffmpeg 0:s:N index counts every subtitle stream, image ones included
      if (IMG_SUB[st.codec]) continue; // image subs can't render as text
      var nm = langName(st.lang); if (st.title) nm += ' — ' + st.title;
      tracks.push({ n: sn, ti: ti, name: nm, lang: st.lang || '' }); // n=ffmpeg 0:s:n index; ti=index among TEXT tracks (native textTracks[])
      ti++;
    }
    console.log('[embtracks] found=' + tracks.length + (inf.err ? ' err=' + inf.err : ''));
    sendJson(res, { tracks: tracks, err: tracks.length ? '' : (inf.err || '') });
  });
}

// ---- embedded subtitles: cache, index-based sessions, ffmpeg fallback ----
// Finished tracks are cached on disk (keyed by title + track + file name) so a file is only
// ever read once. The ffmpeg fallback is ONE sequential read from the playhead to EOF, cues
// parsed as they stream out, polled by the player.
var crypto = require('crypto');
var SUBCACHE = path.join(DIR, 'subcache');
try { fs.mkdirSync(SUBCACHE); } catch (e) {}
function subKey(q) {
  var tail = String(q.u || '').split('/').pop().slice(0, 48);
  return crypto.createHash('sha1').update((q.id || '') + '|' + (q.vid || '') + '|' + (q.n || 0) + '|' + tail).digest('hex');
}
function pruneSubcache() {
  try {
    var fl = fs.readdirSync(SUBCACHE);
    if (fl.length <= 40) return;
    var st = [];
    for (var i = 0; i < fl.length; i++) { try { st.push({ f: fl[i], m: fs.statSync(path.join(SUBCACHE, fl[i])).mtimeMs }); } catch (e) {} }
    st.sort(function (a, b) { return a.m - b.m; });
    for (var j = 0; j < st.length - 40; j++) { try { fs.unlinkSync(path.join(SUBCACHE, st[j].f)); } catch (e) {} }
  } catch (e) {}
}
var embJob = null; // the ffmpeg fallback: one at a time (low-RAM TV)
function killJob() {
  if (!embJob) return;
  try { if (embJob.pr) embJob.pr.kill('SIGKILL'); } catch (e) {}
  embJob = null;
}
// P2P URLs (the engine or the helper's /p2p): every Range makes the torrent fetch the whole
// piece around it, so subtitles are harvested only around the playhead
function isP2pStreamUrl(u) { return /^http:\/\/127\.0\.0\.1:(3030\/torrents|8080\/p2p)/.test(String(u || '')); }
function saveSubCache(key, cues) {
  try { fs.writeFileSync(path.join(SUBCACHE, key + '.json'), JSON.stringify({ v: 1, cues: cues })); pruneSubcache(); } catch (e) {}
}
// Index-based subtitle sessions (mkvsubs.js), one per stream URL: created when the player
// lists the tracks, they keep EVERY text track harvested around the playhead, so choosing a
// track shows its lines at once. Up to 3 streams at a time (two players never cancel each
// other); idle ones are closed after 3 min. What a session can't read (not MKV, no index,
// no Range) goes to the ffmpeg job below.
var subSessions = {}; // url -> { s: Session, used: ts, saved: { key: 1 } }
function subSession(u, t, create) {
  var e = subSessions[u];
  if (e && !e.s.dead) {
    // a verdict of 'fallback' is kept a minute, then the next player gets a fresh try
    if (e.s.state !== 'fallback' || Date.now() - e.used < 60000) { e.used = Date.now(); if (t > 0) e.s.setPos(t); return e; }
    e.s.stop();
  }
  if (!create) return null;
  var urls = Object.keys(subSessions);
  if (urls.length >= 3) {
    urls.sort(function (a, b) { return subSessions[a].used - subSessions[b].used; });
    subSessions[urls[0]].s.stop(); delete subSessions[urls[0]];
  }
  var tag = crypto.createHash('sha1').update(u).digest('hex').slice(0, 8);
  e = { used: Date.now(), saved: {}, tag: tag };
  e.s = new mkvsubs.Session(u, { t: t, p2p: isP2pStreamUrl(u), onState: function (ss) {
    var st = ss.stats();
    if (ss.state === 'fallback') console.log('[subs ' + tag + '] index path unavailable (' + ss.err + ') -> ffmpeg on demand');
    else if (ss.state === 'harvesting' && !e.logged) {
      e.logged = true;
      var idx = 0, scan = 0;
      for (var num in ss.tracks) { if (ss.tracks[num].scan) scan++; else idx++; }
      console.log('[subs ' + tag + '] harvesting ' + idx + ' indexed + ' + scan + ' scanned text tracks' + (ss.p2p ? ' (p2p: window only)' : '') + ', ready after ' + (Date.now() - ss.startedAt) + 'ms');
    }
  } });
  subSessions[u] = e;
  return e;
}
setInterval(function () {
  for (var u in subSessions) {
    if (Date.now() - subSessions[u].used > 180000) { subSessions[u].s.stop(); delete subSessions[u]; console.log('[subs] idle session closed'); }
  }
}, 30000);
function spawnJobProc(job, fromT) {
  job.baseT = fromT;
  job.tail = '';
  job.startedAt = Date.now();
  // Small probesize/analyzeduration: ffmpeg's defaults (5MB / 5s) make it read megabytes
  // before emitting ANY cue. Extraction is bandwidth-bound (it must read the container to
  // find subtitle packets), so cutting the upfront read is the biggest time-to-first-cue win.
  var args = ['-nostdin', '-threads', '1', '-probesize', '600000', '-analyzeduration', '1000000'];
  if (fromT > 0) args.push('-ss', String(fromT));
  // -copyts: keep ORIGINAL absolute timestamps. Without it, -ss output may be seek-relative
  // or absolute depending on the file, which silently desynced mid-file extractions.
  args.push('-i', localProxy(job.u), '-copyts', '-map', '0:s:' + job.n, '-f', 'srt', 'pipe:1');
  var pr;
  try { pr = spawn(FFMPEG, args); } catch (e) { job.done = true; job.err = 'spawn failed'; return; }
  job.pr = pr;
  pr.stdout.on('data', function (d) {
    if (embJob !== job || job.pr !== pr) return;
    job.tail += d.toString('utf8');
    // parse only COMPLETE srt blocks; keep the trailing partial block for the next chunk
    var cut = job.tail.lastIndexOf('\n\n');
    if (cut < 0) return;
    var ready = job.tail.slice(0, cut);
    job.tail = job.tail.slice(cut + 2);
    var cues = parseSrt(ready);
    for (var i = 0; i < cues.length; i++) {
      // -copyts => timestamps are already absolute; no offset arithmetic
      cues[i].q = job.cues.length; job.cues.push(cues[i]);
      if (cues[i].e > job.frontier) job.frontier = cues[i].e;
    }
  });
  pr.stderr.on('data', function (d) { job.errTail = (job.errTail + d.toString('utf8')).slice(-400); });
  pr.on('error', function () { if (embJob === job && job.pr === pr) { job.done = true; job.err = 'ffmpeg error'; } });
  pr.on('close', function (code) {
    if (embJob !== job || job.pr !== pr) return;
    var last = parseSrt(job.tail); // flush the final block (timestamps already absolute via -copyts)
    for (var i = 0; i < last.length; i++) { last[i].q = job.cues.length; job.cues.push(last[i]); }
    job.tail = ''; job.pr = null; job.done = true;
    var secs = ((Date.now() - job.startedAt) / 1000) | 0;
    console.log('[embjob] done key=' + job.key.slice(0, 8) + ' cues=' + job.cues.length + ' base=' + job.baseT + ' took=' + secs + 's code=' + code);
    // cache only full-coverage runs (started at the very beginning) that yielded cues
    if (code === 0 && job.baseT <= 5 && job.cues.length) {
      try { fs.writeFileSync(path.join(SUBCACHE, job.key + '.json'), JSON.stringify({ v: 1, cues: job.cues })); pruneSubcache(); } catch (e) {}
    }
  });
}
function embStart(q, res) {
  if (!q.u) return sendJson(res, { err: 'no url' });
  var key = subKey(q), n = parseInt(q.n || '0', 10) || 0, t = Math.max(0, Math.floor(parseFloat(q.t || '0') || 0));
  // instant path: already extracted this track before
  try {
    var cachedRaw = fs.readFileSync(path.join(SUBCACHE, key + '.json'), 'utf8');
    var cached = JSON.parse(cachedRaw);
    if (cached && cached.cues && cached.cues.length) {
      console.log('[embjob] cache hit key=' + key.slice(0, 8) + ' cues=' + cached.cues.length);
      return sendJson(res, { cached: true, done: true, cues: cached.cues });
    }
  } catch (e) {}
  // index path: usually already harvested around the playhead when the track is chosen
  var e = subSession(q.u, t, true), st = e.s.trackState(n);
  if (st !== 'fallback') {
    e.s.select(n);
    var r0 = e.s.cuesSince(n, 0, null); // whole list + its epoch
    console.log('[subs ' + e.tag + '] track ' + n + ' chosen at ' + t + 's: ' + r0.cues.length + ' cues ready (' + st + ')');
    return sendJson(res, { started: true, cues: r0.cues, ep: r0.ep, done: st === 'complete' });
  }
  if (embJob && embJob.key === key && !embJob.err) {
    return sendJson(res, { started: true, cues: embJob.cues, ep: 0, done: embJob.done });
  }
  killJob();
  // ffmpeg: start slightly behind the playhead; if they later rewind past this, we restart from 0
  var from = Math.max(0, t - 30);
  embJob = { key: key, u: q.u, n: n, cues: [], frontier: from, baseT: from, done: false, err: '', errTail: '', lastPoll: Date.now(), pr: null, tail: '' };
  spawnJobProc(embJob, from);
  console.log('[embjob] ffmpeg start key=' + key.slice(0, 8) + ' n=' + n + ' from=' + from);
  sendJson(res, { started: true, cues: [], ep: 0, done: false });
}
function embCues(q, res) {
  // since = the next line number the player needs (q), ep = the epoch of what it holds
  var key = subKey(q), since = parseInt(q.since || '0', 10) || 0, ep = parseInt(q.ep || '0', 10) || 0, t = parseFloat(q.t || '0') || 0;
  if (!embJob || embJob.key !== key) {
    var e = subSession(q.u, t, false), n = parseInt(q.n || '0', 10) || 0;
    if (e && q.b != null) e.s.setBuf(parseFloat(q.b));
    var st = e ? e.s.trackState(n) : 'fallback';
    if (st === 'fallback') return sendJson(res, { cues: [], done: true, gone: true }); // re-kick: embstart picks ffmpeg
    if (e.s.sel < 0 || e.s.track(n) !== e.s.tracks[e.s.sel]) e.s.select(n);
    if (st === 'complete' && !e.saved[key]) { var cs = e.s.cuesFor(n); e.saved[key] = 1; saveSubCache(key, cs); console.log('[subs ' + e.tag + '] track ' + n + ' complete: ' + cs.length + ' cues, ' + e.s.stats().requests + ' requests'); }
    var r = e.s.cuesSince(n, since, ep);
    return sendJson(res, { cues: r.cues, ep: r.ep, reset: r.reset, done: st === 'complete' });
  }
  var job = embJob;
  job.lastPoll = Date.now();
  // user rewound before our start point -> restart from 0 (keeps already-parsed cues)
  if (!job.done && job.baseT > 5 && t > 0 && t < job.baseT - 5 && !job.restarted0) {
    job.restarted0 = true;
    try { if (job.pr) job.pr.kill('SIGKILL'); } catch (e) {}
    console.log('[embjob] rewind -> restart from 0');
    spawnJobProc(job, 0);
  }
  // user jumped far past the extraction frontier -> hop the reader forward
  else if (!job.done && t > job.frontier + 300 && !job.hopped) {
    job.hopped = true; // one hop per job keeps it simple; cache is skipped anyway once baseT>5
    try { if (job.pr) job.pr.kill('SIGKILL'); } catch (e) {}
    console.log('[embjob] far seek -> hop to ' + ((t - 30) | 0));
    spawnJobProc(job, Math.max(0, Math.floor(t - 30)));
  }
  sendJson(res, { cues: job.cues.slice(since), ep: 0, done: job.done, err: job.err }); // ffmpeg lines: q = index
}
// reap the job if the player stopped polling (left playback)
setInterval(function () {
  if (embJob && (Date.now() - embJob.lastPoll) > 90000) { console.log('[embjob] idle reap'); killJob(); }
}, 30000);

// ---- YouTube trailer resolver ----
// Innertube ANDROID first (direct googlevideo mp4 when Google allows it), then
// public Piped instances (they proxy the stream themselves, so their URL plays
// from anywhere). The final URL is wrapped in our localhost /proxy so the TV's
// old TLS/CA stack never talks to the outside world.
var ytCache = {}; // videoId -> { lo, hi, at }  (lo=360p-ish, hi=720p-ish)
var PIPED = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.ducks.party',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.adminforge.de'
];
var pipedGood = -1; // remember the instance that worked last
var pipedBad = {};   // instance idx -> last-failure ts (3min cooldown)
var ytFail = {};     // videoId -> ts (10min negative cache; stop hammering dead videos)
function postJsonUpstream(host, path, headers, body, cb) {
  var req = https.request({ hostname: host, path: path, method: 'POST', headers: headers }, function (r) {
    var chunks = [];
    r.on('data', function (d) { chunks.push(d); });
    r.on('end', function () {
      var buf = Buffer.concat(chunks);
      if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
      try { cb(JSON.parse(buf.toString('utf8'))); } catch (e) { cb(null); }
    });
  });
  req.on('error', function () { cb(null); });
  req.setTimeout(10000, function () { try { req.abort(); } catch (e) {} });
  req.end(body);
}
function ytInnertube(vid, cb) {
  var ver = '20.10.38';
  var body = JSON.stringify({
    videoId: vid,
    context: { client: { clientName: 'ANDROID', clientVersion: ver, androidSdkVersion: 34, hl: 'en', gl: 'US' } },
    contentCheckOk: true, racyCheckOk: true
  });
  postJsonUpstream('www.youtube.com', '/youtubei/v1/player?prettyPrint=false', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'com.google.android.youtube/' + ver + ' (Linux; U; Android 14)',
    'X-Youtube-Client-Name': '3',
    'X-Youtube-Client-Version': ver
  }, body, function (j) {
    if (!j) return cb(null);
    var fm = (j.streamingData && j.streamingData.formats) || [];
    var out = { lo: '', hi: '', subs: [] };
    out.len = +((j.videoDetails && j.videoDetails.lengthSeconds) || 0); // to match it against IMDb's cuts
    for (var i = 0; i < fm.length; i++) {
      var f = fm[i];
      if (!f.url || String(f.mimeType || '').indexOf('video/mp4') !== 0) continue;
      if (f.itag === 22) out.hi = f.url;
      else if (f.itag === 18) out.lo = f.url;
      else if (!out.lo) out.lo = f.url;
    }
    var ct = (j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    for (var s = 0; s < ct.length; s++) {
      if (ct[s] && ct[s].baseUrl) {
        var snm = (ct[s].name && ct[s].name.runs && ct[s].name.runs[0] && ct[s].name.runs[0].text) || (ct[s].name && ct[s].name.simpleText) || 'English';
        var lc = String(ct[s].languageCode || '').toLowerCase();
        out.subs.push({
          name: snm,
          lang: lc === 'en' ? 'eng' : (lc.length === 2 ? guessLang(snm, '') : lc),
          url: ct[s].baseUrl
        });
      }
    }
    cb((out.lo || out.hi || out.subs.length) ? out : null);
  });
}
function ytPiped(vid, idx, cb) {
  var now = Date.now(), fresh = [], cooling = [];
  function push(i) { ((pipedBad[i] && now - pipedBad[i] < 180000) ? cooling : fresh).push(i); }
  if (pipedGood >= 0) push(pipedGood);
  for (var i = 0; i < PIPED.length; i++) if (i !== pipedGood) push(i);
  var order = fresh.concat(cooling); // throttled instances only as a last resort
  function tryOne(k) {
    if (k >= order.length) return cb(null);
    var ii = order[k];
    var u = PIPED[ii] + '/streams/' + encodeURIComponent(vid);
    fetchJson(u, function (j) {
      var vs = (j && j.videoStreams) || [];
      var out = { lo: '', hi: '' };
      for (var s = 0; s < vs.length; s++) {
        var v = vs[s];
        if (v.videoOnly || !v.url || String(v.mimeType || '').indexOf('video/mp4') !== 0) continue;
        var q = parseInt(v.quality, 10) || 0;
        if (q >= 480) { if (!out.hi) out.hi = v.url; }
        else if (!out.lo) out.lo = v.url;
      }
      if (out.lo || out.hi) { pipedGood = ii; delete pipedBad[ii]; dbg('[yt] piped ok via ' + PIPED[ii]); return cb(out); }
      if (!j) pipedBad[ii] = Date.now(); // network/parse fail -> cool this instance down
      tryOne(k + 1);
    });
  }
  tryOne(0);
}
function ytResolve(vid, lq, cb) {
  if (!/^[\w-]{6,16}$/.test(vid)) return cb('', 'bad id');
  function pick(cc) {
    var u = lq ? (cc.lo || cc.hi) : (cc.hi || cc.lo);
    return u ? localProxy(u) : ''; // play through our proxy: node's TLS, Range honoured
  }
  var c = ytCache[vid];
  if (c && (Date.now() - c.at) < 2 * 3600 * 1000) { var u0 = pick(c); return cb(u0, u0 ? '' : 'no format'); }
  if (ytFail[vid] && (Date.now() - ytFail[vid]) < 180000) return cb('', 'unavailable'); // retry after 3min (mirror outages recover)
  ytInnertube(vid, function (a) {
    if (a) { a.at = Date.now(); ytCache[vid] = a; return cb(pick(a), ''); }
    ytPiped(vid, 0, function (b) {
      if (b) { b.at = Date.now(); ytCache[vid] = b; return cb(pick(b), ''); }
      ytFail[vid] = Date.now();
      dbg('[yt] ' + vid + ' unresolved');
      cb('', 'unavailable');
    });
  });
}

// ---- IMDb trailers ----------------------------------------------------------------
// YouTube extraction is dead in waves (every Piped mirror answers "Sign in to confirm
// you're not a bot"; Innertube needs PoTokens). IMDb hosts its OWN trailer MP4s on its CDN,
// every title we show already has an IMDb id, and api.graphql.imdb.com answers with plain
// signed MP4 links (480p/720p/1080p). Browser calls are refused (403, no CORS) so it has to
// be resolved here. Signed URLs live ~2 days -> cache 3h per title.
var imdbCache = {}, imdbFail = {};
function imdbTrailers(id, cb) {
  if (!/^tt\d{5,10}$/.test(id)) return cb(null);
  var c = imdbCache[id];
  if (c && Date.now() - c.at < 3 * 3600 * 1000) return cb(c.list);
  if (imdbFail[id] && Date.now() - imdbFail[id] < 10 * 60 * 1000) return cb(null);
  var body = JSON.stringify({ query: 'query{title(id:"' + id + '"){primaryVideos(first:10){edges{node{name{value} runtime{value} contentType{id} playbackURLs{url mimeType videoDefinition} timedTextTracks{url type displayName{value}}}}}}}' });
  var imdbTry = 0;
  (function imdbAsk() {
  postJsonUpstream('api.graphql.imdb.com', '/', {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'x-imdb-client-name': 'imdb-web-next', 'User-Agent': 'Mozilla/5.0'
  }, body, function (j) {
    if (!j && ++imdbTry < 2) return setTimeout(imdbAsk, 1200); // a dropped request: ask once more
    var edges = (((j && j.data && j.data.title) || {}).primaryVideos || {}).edges || [];
    var list = [];
    for (var i = 0; i < edges.length; i++) {
      var n = edges[i] && edges[i].node; if (!n) continue;
      var ct = String((n.contentType && n.contentType.id) || '');
      var ttt = n.timedTextTracks || [];
      var subs = [];
      for (var s = 0; s < ttt.length; s++) {
        if (ttt[s] && ttt[s].url) {
          var snm = (ttt[s].displayName && ttt[s].displayName.value) || 'English';
          subs.push({
            name: snm,
            lang: guessLang(snm, ttt[s].url),
            url: ttt[s].url
          });
        }
      }
      var v = { name: (n.name && n.name.value) || 'Trailer', run: (n.runtime && n.runtime.value) || 0,
                trailer: ct.indexOf('trailer') >= 0, lo: '', hi: '', full: '', hls: '', subs: subs };
      var pu = n.playbackURLs || [];
      for (var k = 0; k < pu.length; k++) {
        var d = String(pu[k].videoDefinition || ''), m = String(pu[k].mimeType || '');
        // IMDb's newer MP4 encodes mark only ~2 keyframes per trailer (e.g. 0s and 82s): the TV's
        // decoder can only start at a marked keyframe, so every seek restarted the trailer. Their HLS
        // stream is cut into ~12s segments that each start on a keyframe, and webOS plays HLS natively
        // (measured: seeks land within one segment, in ~0.4s). HLS first, MP4 as the fallback.
        if (m === 'application/x-mpegurl' && pu[k].url) { v.hls = pu[k].url; continue; }
        if (m !== 'video/mp4' || !pu[k].url) continue;
        if (d === 'DEF_480p' || (d === 'DEF_SD' && !v.lo)) v.lo = pu[k].url;
        else if (d === 'DEF_720p') v.hi = pu[k].url;
        else if (d === 'DEF_1080p') v.full = pu[k].url;
        else if (d === 'DEF_240p' && !v.lo) v.lo = pu[k].url;
      }
      if (v.lo || v.hi || v.full) list.push(v);
    }
    // best first: real trailers, "official" ones, subtitles available, then a sane length (skip 15s teasers)
    function score(v) { return (v.trailer ? 100 : 0) + (/official/i.test(v.name) ? 20 : 0) + (/trailer/i.test(v.name) ? 10 : 0) + (v.run >= 50 ? 5 : 0) + (v.subs && v.subs.length ? 15 : 0); }
    list.sort(function (a, b) { return score(b) - score(a); });
    if (list.length) { imdbCache[id] = { at: Date.now(), list: list }; delete imdbFail[id]; }
    else if (j && j.data && j.data.title) { imdbFail[id] = Date.now(); } // a real "no videos", not a failed request
    dbg('[trailer] imdb ' + id + ' -> ' + list.length + ' video(s)' + (list[0] ? ' best="' + list[0].name + '"' : ''));
    cb(list.length ? list : null);
  });
  })();
}
// every YouTube trailer Cinemeta knows for a title (movie or series), newest list cached
var cinemetaYtCache = {};
function lookupCinemetaYt(id, cb) {
  if (!id || !/^tt\d+$/.test(id)) return cb([]);
  if (cinemetaYtCache[id]) return cb(cinemetaYtCache[id]);
  var types = ['movie', 'series'], ti = 0;
  (function next() {
    if (ti >= types.length) return cb([]);
    fetchJson('https://v3-cinemeta.strem.io/meta/' + types[ti++] + '/' + encodeURIComponent(id) + '.json', function (j) {
      var m = (j && j.meta) || {}, trs = (m.trailers || []).concat(m.trailerStreams || []), ids = [];
      for (var i = 0; i < trs.length && ids.length < 5; i++) {
        var t = trs[i] && (trs[i].source || trs[i].ytId);
        if (t && /^[\w-]{6,16}$/.test(t) && ids.indexOf(t) < 0) ids.push(t);
      }
      if (!ids.length) return next();
      cinemetaYtCache[id] = ids; cb(ids);
    });
  })();
}
// YouTube cuts that have captions: [{id,len,subs}] (parallel, 6s cap, 1h cache — the caption
// URLs are signed and expire)
var ytCapCache = {};
function ytCaptioned(ids, cb) {
  var out = [], left = ids.length, fired = false;
  function fin() { if (!fired) { fired = true; cb(out); } }
  if (!left) return fin();
  setTimeout(fin, 6000);
  ids.forEach(function (id) {
    var c = ytCapCache[id];
    if (c && Date.now() - c.at < 3600000) { if (c.v) out.push(c.v); if (--left === 0) fin(); return; }
    ytInnertube(id, function (yd) {
      var v = (yd && yd.subs && yd.subs.length && yd.len) ? { id: id, len: yd.len, subs: yd.subs } : null;
      ytCapCache[id] = { at: Date.now(), v: v };
      if (v) out.push(v);
      if (--left === 0) fin();
    });
  });
}
// /trailer?id=tt..&lq=1[&yt=ytId] -> {url,name,runtime,source,subs}. IMDb first; the YouTube
// resolver is only a fallback. Hard deadline so the UI never hangs on a dead upstream.
// IMDb's HLS master lists 360p FIRST and the TV starts on the first variant (blurry for seconds,
// sometimes for good). Hand the player the best variant's own playlist instead: resolution first,
// then bitrate. Segments still come straight from the CDN, so seeking is unaffected.
function hlsTop(master, cb) {
  var fired = false; function once(v) { if (!fired) { fired = true; cb(v); } }
  setTimeout(function () { once(''); }, 4000);
  fetchUrl(master, function (buf) {
    if (!buf) return once('');
    var lines = buf.toString('utf8').split(/\r?\n/), best = -1, url = '';
    for (var i = 0; i < lines.length; i++) {
      var m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]); if (!m) continue;
      var bw = +((/(?:^|,)BANDWIDTH=(\d+)/.exec(m[1]) || [])[1] || 0);
      var r = /RESOLUTION=(\d+)x(\d+)/.exec(m[1]), px = r ? (+r[1]) * (+r[2]) : 0;
      var nx = ''; for (var k = i + 1; k < lines.length; k++) { var L = lines[k].trim(); if (L && L.charAt(0) !== '#') { nx = L; break; } }
      var score = px * 1e5 + bw / 1000;
      if (nx && score > best) { best = score; url = urlmod.resolve(master, nx); }
    }
    once(url);
  });
}

// /trailer?id=tt..&lq=1[&yt=ytId] -> {url,hls,alt,name,runtime,source,subs}
var trailerCache = {}; // resolved trailers, 30 min (pressing Trailer again is instant)
function trailerRoute(q, res) {
  var done = false, tkey = String(q.id || '') + '|' + String(q.yt || '') + '|' + (q.lq ? 1 : 0);
  var tc = trailerCache[tkey];
  if (tc && Date.now() - tc.at < 1800000) return sendJson(res, tc.o);
  function send(o) {
    if (done) return; done = true; clearTimeout(dl);
    if (o && o.url) trailerCache[tkey] = { at: Date.now(), o: o };
    sendJson(res, o);
  }
  function reply(o) {
    if (done) return;
    if (o && o.hls && !lq) return hlsTop(o.hls, function (top) { if (top) { o.master = o.hls; o.hls = top; } send(o); });
    send(o);
  }
  var dl = setTimeout(function () { send({ err: 'timeout' }); }, 20000); // the TV can be busy (app boot): slow beats failed
  var lq = !!q.lq;
  var yt = String(q.yt || '');
  var imdbId = String(q.id || '');

  function imdbReply(v, subs) {
    var u = lq ? (v.lo || v.hi || v.full) : (v.full || v.hi || v.lo);
    reply({ url: u, hls: v.hls || '', alt: localProxy(u), name: v.name, runtime: v.run, source: 'imdb', subs: subs || [] });
  }
  function withYt(ytIds) {
    // IMDb and the YouTube caption lookup run in parallel (they used to run back to back)
    var imdbList, caps, got = 0;
    if (ytIds.length && !lq) ytCaptioned(ytIds.slice(0, 5), function (c) { caps = c; if (++got === 2) decide(); });
    else { caps = []; got++; }
    imdbTrailers(imdbId, function (list) { imdbList = list; if (++got === 2) decide(); });
    function decide() {
      var list = imdbList;
      if (list && list.length) {
        if ((list[0].subs && list[0].subs.length) || !caps.length) return imdbReply(list[0], list[0].subs);
        // IMDb trailers carry no captions. A YouTube cut's captions only fit the IMDb TRAILER of the
        // same length (+-2s): take IMDb's best-ranked trailer that matches a captioned YouTube cut.
        for (var i = 0; i < list.length; i++) {
          if (!list[i].trailer || !list[i].run) continue;
          for (var c = 0; c < caps.length; c++) if (Math.abs(list[i].run - caps[c].len) <= 2) return imdbReply(list[i], caps[c].subs);
        }
        return imdbReply(list[0], []);
      }
      if (!ytIds.length) return reply({ err: 'unavailable' });
      ytResolve(ytIds[0], lq, function (url, err) {
        var c = ytCache[ytIds[0]];
        reply(url ? { url: url, name: 'Trailer', source: 'youtube', subs: (c && c.subs) || [] } : { err: err || 'unavailable' });
      });
    }
  }

  var given = yt ? yt.split(',').filter(function (x) { return /^[\w-]{6,16}$/.test(x); }) : [];
  if (given.length || !imdbId) withYt(given);
  else lookupCinemetaYt(imdbId, withYt);
}

// ---- external subtitles (OpenSubtitles via Stremio's addon): cached per video, retried ----
// They used to come back empty when asked exactly while a torrent was ramping up (the home line
// was saturated), and the player never asked again. Cache 1 h; retry twice on a failed request.
var subsCache = {};
function subsList(type, vid, cb) {
  var key = type + '|' + vid, c = subsCache[key];
  if (c && c.out && Date.now() - c.at < 3600000) return cb(c.out);
  if (c && c.waiters) return c.waiters.push(cb);
  var waiters = [cb];
  subsCache[key] = { waiters: waiters };
  var tries = 0;
  (function attempt() {
    fetchJson('https://opensubtitles-v3.strem.io/subtitles/' + encodeURIComponent(type) + '/' + encodeURIComponent(vid) + '.json', function (j) {
      if (!j && ++tries < 3) return setTimeout(attempt, 2500);
      var subs = (j && j.subtitles) || [], out = [], per = {};
      for (var i = 0; i < subs.length; i++) {
        var lang = (subs[i].lang || '').toLowerCase();
        if (!lang || !subs[i].url) continue;
        per[lang] = (per[lang] || 0) + 1;
        if (per[lang] > 12) continue; // cap per language
        out.push({ lang: lang, name: langName(lang), u: subs[i].url, n: per[lang] });
      }
      out.sort(function (a, b) { if (a.lang === 'eng' && b.lang !== 'eng') return -1; if (b.lang === 'eng' && a.lang !== 'eng') return 1; if (a.name !== b.name) return a.name < b.name ? -1 : 1; return a.n - b.n; });
      subsCache[key] = j ? { at: Date.now(), out: out } : null; // only a real answer is cached
      for (var w = 0; w < waiters.length; w++) waiters[w](out);
    });
  })();
}

// ---- P2P streaming engine supervisor ----
// nuvio-engine (libtorrent 2.0) behind tools/nuvio/nuvio-bridge.cpp: serves blocks as they land,
// re-asks a faster peer for a stalled block, deadline-scheduled pieces, and a disk window so a
// 100 GB torrent plays inside the P2P buffer (tools/build-nuvio.sh). It speaks a small HTTP API
// on 127.0.0.1:3030 (add, files, stream with Range, stats, limits, delete).
// On a Mac (dev) the native build is used; the TV binary is armv7 Linux.
var ENGINE_BIN = process.env.TV_NUVIO || (process.platform === 'darwin' ? path.join(DIR, '..', '.build-nuvio', 'nuvio-bridge-mac') : path.join(DIR, 'bin', 'nuvio-bridge'));
var ENGINE_PORT = 3030;
// Torrent data goes in the helper's own folder on flash: /tmp is tmpfs (RAM) on the TV and a
// multi-GB download there would starve the whole system. Wiped at every engine start and stop.
var ENGINE_DIR = process.env.TV_P2P_DIR || path.join(DIR, 'p2p');
function rmTree(d) {
  var ents; try { ents = fs.readdirSync(d); } catch (e) { return; }
  for (var i = 0; i < ents.length; i++) {
    var f = path.join(d, ents[i]), st; try { st = fs.lstatSync(f); } catch (e) { continue; }
    if (st.isDirectory()) { rmTree(f); try { fs.rmdirSync(f); } catch (e) {} } else { try { fs.unlinkSync(f); } catch (e) {} }
  }
}
var engineProc = null;
var engineStarting = false;
var engineStartCbs = [];
var engineIdleTimer = null;
var engineActiveStreams = 0;

function isEngineUp(cb) {
  var s = net.connect(ENGINE_PORT, '127.0.0.1');
  var settled = false;
  function finish(v) { if (!settled) { settled = true; try { s.destroy(); } catch (e) {} cb(v); } }
  s.on('connect', function () { finish(true); });
  s.on('error', function () { finish(false); });
  setTimeout(function () { finish(false); }, 350);
}

function stopEngine() {
  clearTimeout(engineIdleTimer);
  engineIdleTimer = null;
  if (engineProc) {
    dbg('stopping the P2P engine pid=' + engineProc.pid);
    var pr = engineProc;
    try { pr.kill('SIGTERM'); } catch (e) {}
    setTimeout(function () { try { pr.kill('SIGKILL'); } catch (e) {} }, 4000); // never leave a stuck engine behind
    engineProc = null;
  }
  // its downloads go with it (unlinked files are freed as the engine lets go of them): a helper that exited for
  // memory left 190 MB behind, the app partition filled up and the next app install failed
  rmTree(ENGINE_DIR);
}
rmTree(ENGINE_DIR); // a helper starting: nothing of ours can be using a download left by the last one

function resetEngineIdleTimer() {
  clearTimeout(engineIdleTimer);
  engineIdleTimer = setTimeout(function () {
    if (engineActiveStreams <= 0) {
      dbg('P2P engine idle for 2 min - stopping it');
      stopEngine();
    } else resetEngineIdleTimer(); // a stream still open (ffmpeg reading a file): ask again later
  }, 120000);
}

process.on('exit', function () { stopEngine(); });
process.on('SIGTERM', function () { stopEngine(); process.exit(0); });
process.on('SIGINT', function () { stopEngine(); process.exit(0); });

// ---- bounded streaming: the P2P buffer on flash ----
// The engine keeps at most this many MB of the file on flash: pieces far from the playhead are
// punched out of the payload file and fetched again on a seek back. Sized automatically from the
// free space (a TV's app partition has ~250 MB, so a user setting could only ask for the impossible).
// the buffer sizes itself to each TV: what the partition can spare (re-checked at every start), 64-512 MB.
// 64 MB still streams 1080p and most 4K; only below that is the storage really full
var P2P_RING_MIN = 64, P2P_RING_MAX = 512;
// Settings > P2P speed limit: -1 = Auto (full speed to start, then paced to the video's bitrate once
// it plays), 0 = unlimited, else MB/s. Applied live through the engine's /torrents/limits.
var p2pFileLen = {}; // info hash -> length of the file being played (for Auto pacing)
function setP2pLimit(bps) {
  var body = JSON.stringify({ upload_bps: 1048576, download_bps: bps > 0 ? Math.round(bps) : null });
  engineRequest('POST', '/torrents/limits', body, function (e, code) {
    dbg('p2p download limit -> ' + (bps > 0 ? (bps / 1048576).toFixed(2) + ' MB/s' : 'unlimited') + (e ? ' (failed: ' + e.message + ')' : ''));
  });
}
function startLimit() { p2pPaceGentle = false; return 0; } // every stream starts at full speed
// Auto, the only mode: full speed at the start, after a seek and while the player waits for data; once
// playback has run smoothly for 15 s, a gentle cap (2x the file's average bitrate, at least 1 MB/s) leaves
// the rest of the home line free. The engine's window bounds how far ahead it downloads either way.
var p2pPaceGentle = false;
function p2pPace(q) {
  var ih = String(q.ih || '').toLowerCase(), len = p2pFileLen[ih] || 0, dur = parseFloat(q.dur) || 0, calm = parseFloat(q.calm);
  if (isNaN(calm)) return;
  var gentle = calm >= 15 && len > 0 && dur > 60;
  if (gentle === p2pPaceGentle) return;
  p2pPaceGentle = gentle;
  setP2pLimit(gentle ? Math.max(1048576, 2 * len / dur) : 0);
}
// free MB on the filesystem holding dir (busybox and coreutils df; wrapped lines handled)
function freeMb(dir, cb) {
  require('child_process').exec('df -k "' + dir + '"', { timeout: 5000 }, function (err, out) {
    if (err || !out) return cb(-1);
    var lines = String(out).trim().split('\n');
    var nums = lines[lines.length - 1].trim().split(/\s+/).filter(function (x) { return /^\d+$/.test(x); });
    var kb = nums.length >= 3 ? +nums[2] : -1;
    cb(kb >= 0 ? Math.floor(kb / 1024) : -1);
  });
}

function ensureEngine(cb) {
  resetEngineIdleTimer();
  isEngineUp(function (up) {
    if (up) return cb(null);
    engineStartCbs.push(cb);
    if (engineStarting) return;
    engineStarting = true;
    startEngine();
  });
}

function finishEngineStart(err) {
  engineStarting = false;
  var cbs = engineStartCbs; engineStartCbs = [];
  for (var i = 0; i < cbs.length; i++) cbs[i](err || null);
}

function startEngine() {
  try {
    rmTree(ENGINE_DIR);
    if (!fs.existsSync(ENGINE_DIR)) fs.mkdirSync(ENGINE_DIR);
    fs.mkdirSync(path.join(DIR, 'cache'));
  } catch (e) {}
  try { fs.mkdirSync(path.join(DIR, 'cache', 'nuvio')); } catch (e) {}
  freeMb(ENGINE_DIR, function (free) {
    // leave room for everything else on the partition (app installs, other apps, the engine's own state): a quarter
    // of what is free, 48-96 MB (24-48 filled it to the last MB: "No space left" from the engine, installs failing)
    var keep = Math.round(Math.max(48, Math.min(96, free * 0.25))), ring = free < 0 ? P2P_RING_MAX : Math.min(P2P_RING_MAX, Math.floor(free - keep));
    if (ring < P2P_RING_MIN) {
      dbg('p2p: not enough storage (free=' + free + 'MB)');
      var se = new Error('Not enough free storage for the P2P buffer (' + Math.max(0, free) + ' MB free)');
      se.code = 'storage';
      return finishEngineStart(se);
    }
    var args = [
      '--port', String(ENGINE_PORT),
      // DHT table + resume data kept between engine starts (never inside the wiped cache folder)
      '--state', path.join(DIR, 'cache', 'nuvio'),
      '--cache', ENGINE_DIR,
      '--cache-mb', String(ring),
      '--upload-kbps', '1024' // seeding costs this TV's CPU; 1 MB/s is plenty of give-back
    ];
    dbg('spawning the P2P engine: ' + ENGINE_BIN + ' buffer=' + ring + 'MB free=' + free + 'MB');
    var logFd = 'ignore';
    try { logFd = fs.openSync(path.join(DIR, 'engine.log'), 'w'); } catch (e) {}
    var started = Date.now();
    try {
      engineProc = spawn(ENGINE_BIN, args, { stdio: ['ignore', logFd, logFd] });
    } catch (e) {
      dbg('failed to spawn the P2P engine: ' + e.message);
      return finishEngineStart(e);
    } finally {
      if (typeof logFd === 'number') try { fs.closeSync(logFd); } catch (e) {}
    }
    var proc = engineProc;
    proc.on('exit', function (code, sig) {
      dbg('P2P engine exit code=' + code + ' sig=' + sig + (code === 3 ? ' (this storage cannot free played pieces)' : ''));
      if (engineProc === proc) engineProc = null;
      if (!engineProc && !engineStarting) rmTree(ENGINE_DIR); // free the flash as soon as playback is over
    });
    var tries = 0;
    (function checkReady() {
      isEngineUp(function (ready) {
        if (ready && engineProc === proc) {
          dbg('P2P engine ready on :' + ENGINE_PORT + ' after ' + (Date.now() - started) + 'ms');
          return finishEngineStart(null);
        }
        if (engineProc !== proc || ++tries > 80) {
          dbg('P2P engine did not start (' + (engineProc !== proc ? 'exited' : 'timeout 8s') + ')');
          if (engineProc === proc) { try { proc.kill('SIGKILL'); } catch (e) {} engineProc = null; }
          return finishEngineStart(new Error('Couldn’t start the torrent engine'));
        }
        setTimeout(checkReady, 100);
      });
    })();
  });
}

function engineRequest(method, reqPath, body, cb) {
  var opts = {
    hostname: '127.0.0.1',
    port: ENGINE_PORT,
    path: reqPath,
    method: method || 'GET',
    headers: {}
  };
  if (body) {
    opts.headers['Content-Type'] = body.charAt(0) === '{' ? 'application/json' : 'text/plain';
    opts.headers['Content-Length'] = Buffer.byteLength(body);
  }
  var req = http.request(opts, function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      var buf = Buffer.concat(chunks).toString('utf8');
      var json = null;
      try { json = JSON.parse(buf); } catch (e) {}
      cb(null, res.statusCode, json, buf);
    });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(35000, function () {
    try { req.abort(); } catch (e) {}
    cb(new Error('P2P engine request timeout'));
  });
  if (body) req.write(body);
  req.end();
}

function pickBestVideoFile(files, requestedIdx) {
  if (!files || !files.length) return requestedIdx || 0;
  var videoExts = /\.(mp4|mkv|avi|ts|m4v|webm|mov)$/i;
  if (requestedIdx >= 0 && requestedIdx < files.length) {
    var reqName = files[requestedIdx].name || '';
    if (videoExts.test(reqName)) return requestedIdx;
  }
  var maxLen = 0, best = 0;
  for (var i = 0; i < files.length; i++) {
    var fn = files[i].name || '';
    var len = files[i].length || 0;
    if (videoExts.test(fn) && len > maxLen) {
      maxLen = len;
      best = i;
    }
  }
  if (maxLen > 0) return best;
  for (var j = 0; j < files.length; j++) {
    var jlen = files[j].length || 0;
    if (jlen > maxLen) {
      maxLen = jlen;
      best = j;
    }
  }
  return best;
}

// large, currently-alive public trackers (openbittorrent is long dead); used on top of the addon's own
var PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce'
];

// One metadata fetch per torrent: a resolve that arrives while the same torrent is still being added
// (play pressed twice, or the player's direct /p2p request racing the resolve) waits for that add
// instead of starting a second one.
var addingTorrent = {};
function addTorrent(ih, magnet, done) {
  if (addingTorrent[ih]) return addingTorrent[ih].push(done);
  var waiters = addingTorrent[ih] = [done];
  function finish(err, details) {
    delete addingTorrent[ih];
    for (var i = 0; i < waiters.length; i++) waiters[i](err, details);
  }
  engineRequest('GET', '/torrents/' + ih, null, function (gErr, gCode, gJson) {
    if (!gErr && gCode === 200 && gJson && gJson.files && gJson.files.length) return finish(null, gJson);
    engineRequest('POST', '/torrents?overwrite=true', magnet, function (pErr, pCode, pJson) {
      if (!pErr && pJson && pJson.details && pJson.details.files && pJson.details.files.length) return finish(null, pJson.details);
      var tries = 0;
      var pollTimer = setInterval(function () {
        tries++;
        engineRequest('GET', '/torrents/' + ih, null, function (err, code, json) {
          if (!err && code === 200 && json && json.files && json.files.length) {
            clearInterval(pollTimer);
            return finish(null, json);
          }
          if (tries >= 35) {
            clearInterval(pollTimer);
            finish(new Error('Torrent metadata timeout — no peers responded'));
          }
        });
      }, 1000);
    });
  });
}

function resolveEngineStream(rawU, rawIh, rawIdx, cb, extraTr) {
  var ih = '';
  // no fileIdx from the addon -> -1 = pick the largest video file (never a sample)
  var targetIdx = (rawIdx === '' || rawIdx == null || isNaN(parseInt(rawIdx, 10))) ? -1 : parseInt(rawIdx, 10);
  var magnet = '';

  if (rawIh && /^[0-9a-fA-F]{40}$/.test(rawIh)) {
    ih = rawIh.toLowerCase();
    magnet = 'magnet:?xt=urn:btih:' + ih;
  } else if (rawU) {
    var m11470 = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):11470\/([a-fA-F0-9]{40})(?:\/(\d+))?/i.exec(rawU);
    if (m11470) {
      ih = m11470[1].toLowerCase();
      if (m11470[2] != null) targetIdx = parseInt(m11470[2], 10);
      magnet = 'magnet:?xt=urn:btih:' + ih;
    } else {
      var mmag = /xt=urn:btih:([a-fA-F0-9]{40})/i.exec(rawU);
      if (mmag) {
        ih = mmag[1].toLowerCase();
        magnet = rawU;
      } else if (/^[0-9a-fA-F]{40}$/.test(rawU.trim())) {
        ih = rawU.trim().toLowerCase();
        magnet = 'magnet:?xt=urn:btih:' + ih;
      }
    }
  }

  if (!ih) return cb(new Error('Invalid torrent link or infoHash'));

  // the addon's own trackers first (Torrentio etc. send them as sources), then public ones
  var given = [].concat(extraTr || []);
  for (var g = 0; g < given.length && g < 12; g++) {
    if (/^(udp|https?|wss?):\/\//i.test(String(given[g]))) magnet += '&tr=' + encodeURIComponent(given[g]);
  }
  // Ensure high-availability public trackers if missing
  if (magnet.indexOf('&tr=') < 0 || given.length) {
    for (var t = 0; t < PUBLIC_TRACKERS.length; t++) {
      magnet += '&tr=' + encodeURIComponent(PUBLIC_TRACKERS[t]);
    }
  }

  ensureEngine(function (err) {
    if (err) return cb(err);

    function onMetadataFound(details) {
      var files = (details && details.files) || [];
      var bestIdx = pickBestVideoFile(files, targetIdx);
      p2pFileLen[ih] = (files[bestIdx] && files[bestIdx].length) || 0;
      p2pKeepaliveAt = Date.now(); // the player has 2 min from here to start checking in
      setP2pLimit(startLimit());
      cb(null, { ih: ih, fileIdx: bestIdx, files: files, details: details });
    }

    addTorrent(ih, magnet, function (aerr, details) {
      if (aerr) return cb(aerr);
      onMetadataFound(details);
    });
  });
}

function handleP2pStream(req, res, q) {
  resetEngineIdleTimer();
  resolveEngineStream(q.u, q.ih, q.idx, function (err, info) {
    if (err) {
      dbg('p2p resolve error: ' + err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('P2P Error: ' + err.message);
      return;
    }

    var targetStream = 'http://127.0.0.1:' + ENGINE_PORT + '/torrents/' + info.ih + '/stream/' + info.fileIdx;
    dbg('p2p stream ready: ih=' + info.ih + ' idx=' + info.fileIdx + ' -> ' + targetStream);

    if (q.redirect === '1') {
      res.writeHead(302, { 'Location': targetStream, 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }

    engineActiveStreams++;
    function onEnd() {
      engineActiveStreams = Math.max(0, engineActiveStreams - 1);
      resetEngineIdleTimer();
    }
    res.on('finish', onEnd);
    res.on('close', onEnd);

    proxyStream(targetStream, req.headers.range, req.method, res, targetStream, 0, false);
  }, q.tr);
}

function handleP2pResolve(res, q) {
  resolveEngineStream(q.u, q.ih, q.idx, function (err, info) {
    if (err) {
      sendJson(res, { ok: false, err: err.message, code: err.code || '' });
      return;
    }
    sendJson(res, {
      ok: true,
      ih: info.ih,
      fileIdx: info.fileIdx,
      files: (info.files || []).map(function (f, i) { return { idx: i, name: f.name, length: f.length }; }),
      streamUrl: 'http://127.0.0.1:' + PORT + '/p2p?ih=' + info.ih + '&idx=' + info.fileIdx,
      directUrl: 'http://127.0.0.1:' + ENGINE_PORT + '/torrents/' + info.ih + '/stream/' + info.fileIdx
    });
  }, q.tr);
}

// Playback ended: delete every torrent and its data (ring files) but keep the engine itself warm
// (DHT table + connections policy) for the next play; the idle timer stops it after 5 min.
// the app was killed (crash, memory) and never said stop: a torrent no player has checked in on for 2 min is
// removed, so nothing downloads for a film nobody watches. A paused player keeps checking in (every 10 s).
setInterval(function () {
  if (!Object.keys(p2pFileLen).length || engineActiveStreams > 0 || !p2pKeepaliveAt || Date.now() - p2pKeepaliveAt < 120000) return;
  dbg('p2p: no player for 2 min - removing its torrent');
  clearP2pTorrents();
}, 20000);
function clearP2pTorrents() {
  p2pFileLen = {};
  isEngineUp(function (up) {
    if (!up) return rmTree(ENGINE_DIR);
    engineRequest('GET', '/torrents', null, function (err, code, json) {
      var list = (json && json.torrents) || [], left = list.length;
      if (!left) return rmTree(ENGINE_DIR);
      list.forEach(function (t) {
        engineRequest('POST', '/torrents/' + t.info_hash + '/delete', null, function () {
          if (--left === 0 && !engineActiveStreams) rmTree(ENGINE_DIR);
        });
      });
      dbg('p2p stop: deleted ' + list.length + ' torrent(s), engine kept warm');
    });
  });
  resetEngineIdleTimer();
}

// the speed shown to the user: bytes actually received between two polls (the engine's own figure is an
// instant rate that jumps), smoothed a little; the engine's rate only until there are two samples
var p2pRateSeen = {};
function p2pRateOf(ih, j) {
  var n = j && j.nuvio, now = Date.now(), b = n ? n.downloaded : null, r = n ? n.down_bps || 0 : 0, s0 = p2pRateSeen[ih];
  if (b == null) return r;
  if (s0 && b >= s0.b && now - s0.t >= 700) {
    var inst = (b - s0.b) * 1000 / (now - s0.t);
    s0.r = s0.r == null ? inst : s0.r * 0.4 + inst * 0.6; s0.b = b; s0.t = now;
  } else if (!s0 || b < s0.b) { p2pRateSeen = {}; s0 = p2pRateSeen[ih] = { b: b, t: now, r: null }; }
  return Math.round(s0.r == null ? r : s0.r);
}
function handleP2pStats(res, q) {
  if (q.keepalive) { resetEngineIdleTimer(); p2pKeepaliveAt = Date.now(); if (q.calm != null) p2pPace(q); } // the player streams straight from the engine and pings here (paused too)
  isEngineUp(function (up) {
    if (!up) {
      sendJson(res, { running: false, activeStreams: engineActiveStreams });
      return;
    }
    var statPath = q.ih ? ('/torrents/' + encodeURIComponent(q.ih) + '/stats/v1') : '/stats';
    engineRequest('GET', statPath, null, function (err, code, json) {
      if (err || !json) {
        sendJson(res, { running: true, activeStreams: engineActiveStreams, err: (err && err.message) || 'stats error' });
      } else {
        json.running = true;
        json.activeStreams = engineActiveStreams;
        json.rate_bps = p2pRateOf(q.ih || '', json);
        sendJson(res, json);
      }
    });
  });
}

// ---- a title's logo for the app's colour picker: the bytes as they are (PNG with transparency),
// with CORS so a canvas may read them. Small, cached, logos only (capped at 1.5 MB) ----
var imgxCache = {}, imgxOrder = [];
function imgxRoute(q, res) {
  var u = String(q.u || '');
  if (!/^https:\/\/(images\.metahub\.space|episodes\.metahub\.space|image\.tmdb\.org|assets\.fanart\.tv|m\.media-amazon\.com)\//.test(u)) { res.writeHead(404); res.end(); return; }
  function send(c) { res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' }); res.end(c.buf); }
  if (imgxCache[u]) return send(imgxCache[u]);
  fetchUrl(u, function (buf) {
    if (!buf || buf.length < 100 || buf.length > 3 * 1048576) { try { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end(); } catch (e) {} return; }
    var type = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x52 ? 'image/webp' : 'image/svg+xml';
    var c = { buf: buf, type: type };
    // only small pictures (logos, small art) stay here; backdrops are kept by the page's HTTP cache
    if (buf.length < 160 * 1024) { imgxCache[u] = c; imgxOrder.push(u); while (imgxOrder.length > 30) delete imgxCache[imgxOrder.shift()]; }
    send(c);
  });
}

// ---- type from the phone: Search shows a QR to http://<TV LAN address>:8099/t/<token>; that page
// sends what is typed, the app (on 127.0.0.1) picks it up. The network side serves ONLY that page and
// that one action, behind a random token, and only while Search has asked for it (15 min idle: off).
var os = require('os');
var phoneTok = crypto.randomBytes(8).toString('hex'), phoneTyped = { seq: 0, text: '' }, phoneSrv = null, phoneOffT = null, PHONE_PORT = 8099;
// the phone pages speak the TV's language: the app sends its own translations of these strings (and the
// text direction) with each QR request; English until it has
var phoneStr = { lang: 'en', rtl: false, t: {} };
function pt(k) { var v = phoneStr.t[k]; return String(v == null || v === '' ? k : v); }
function hx(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function js(x) { return JSON.stringify(String(x)).replace(/</g, '\\u003c'); }
function phoneSetStr(q) {
  if (!q.s) return;
  try { var o = JSON.parse(q.s), t = {}; for (var k in o) if (o.hasOwnProperty(k) && typeof o[k] === 'string') t[k] = o[k].slice(0, 300); phoneStr = { lang: /^[a-z]{2}$/.test(q.lang || '') ? q.lang : 'en', rtl: q.rtl === '1', t: t }; } catch (e) {}
}
function phoneHead(title) {
  return '<!doctype html><html lang="' + phoneStr.lang + '" dir="' + (phoneStr.rtl ? 'rtl' : 'ltr') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + hx(title) + '</title><style>body{margin:0;background:#0c0b11;color:#fff;font:17px -apple-system,Segoe UI,Roboto,"Noto Sans Arabic",Tahoma,sans-serif;display:flex;flex-direction:column;align-items:center;padding:52px 20px;text-align:center}' +
    'h1{font-size:22px;margin:0 0 6px}p{margin:0 0 24px;color:#a9a3c0;max-width:520px;line-height:1.5}a{color:#b794ff}input{width:100%;max-width:520px;box-sizing:border-box;font-size:19px;padding:16px 18px;border-radius:14px;border:2px solid #8c5cff;background:#16131f;color:#fff;outline:none}' +
    'button{margin-top:14px;font-size:18px;font-weight:700;padding:14px 34px;border:0;border-radius:14px;background:#8c5cff;color:#fff}small{margin-top:14px;color:#a9a3c0}</style></head><body>';
}
function phoneSearchHtml() {
  return phoneHead(pt('Search on TV')) + '<h1>' + hx(pt('Search on your TV')) + '</h1><p>' + hx(pt('What you type shows up on the TV as you type.')) + '</p>' +
    '<input id="q" autofocus autocomplete="off" placeholder="' + hx(pt('Film or series')) + '"><small id="s"></small><script>' +
    'var q=document.getElementById("q"),s=document.getElementById("s"),t=null;function send(){var x=new XMLHttpRequest();x.open("GET",location.pathname+"/q?text="+encodeURIComponent(q.value));' +
    'x.onload=function(){s.textContent=' + js(pt('Sent')) + ';};x.onerror=function(){s.textContent=' + js(pt('Can’t reach the TV')) + ';};x.send();}' +
    'q.addEventListener("input",function(){clearTimeout(t);t=setTimeout(send,250);});q.addEventListener("keydown",function(e){if(e.keyCode===13){clearTimeout(t);send();q.blur();}});</script></body></html>';
}
function phoneTmdbHtml() {
  return phoneHead(pt('Titles and descriptions')) + '<h1>' + hx(pt('Titles and descriptions in your language')) + '</h1><p>' + hx(pt('Paste your TMDB API key (or API Read Access Token). Get one free at')) +
    ' <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener" dir="ltr">themoviedb.org/settings/api</a>. ' + hx(pt('It stays on your TV.')) + '</p>' +
    '<input id="k" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + hx(pt('API key')) + '"><button id="b">' + hx(pt('Save')) + '</button><small id="s"></small><script>' +
    'var k=document.getElementById("k"),s=document.getElementById("s");document.getElementById("b").onclick=function(){s.textContent=' + js(pt('Checking…')) + ';var x=new XMLHttpRequest();' +
    'x.open("GET",location.pathname+"/set?key="+encodeURIComponent(k.value.trim()));x.onload=function(){s.textContent=x.status===204?' + js(pt('Saved. You can close this page.')) + ':' + js(pt('TMDB didn’t accept this key.')) + ';};' +
    'x.onerror=function(){s.textContent=' + js(pt('Can’t reach the TV')) + ';};x.send();};</script></body></html>';
}
function lanIp() { var n = os.networkInterfaces(); for (var k in n) for (var i = 0; i < n[k].length; i++) { var a = n[k][i]; if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address; /* Node 18.0-18.3 report 4 */ } return ''; }
function phoneOn() {
  clearTimeout(phoneOffT); phoneOffT = setTimeout(function () { if (phoneSrv) { try { phoneSrv.close(); } catch (e) {} phoneSrv = null; } }, 15 * 60000);
  if (phoneSrv) return;
  phoneSrv = http.createServer(function (req, res) {
    var u = urlmod.parse(req.url, true), m = /^\/t\/([0-9a-f]{16})(\/q|\/logs|\/tmdb|\/tmdb\/set)?$/.exec(u.pathname || '');
    if (req.method !== 'GET' || !m || m[1] !== phoneTok) { res.writeHead(404); res.end(); return; }
    if (m[2] === '/tmdb') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(phoneTmdbHtml()); return; }
    if (m[2] === '/tmdb/set') { tmdbSet(u.query.key, function (ok) { res.writeHead(ok ? 204 : 400, { 'Cache-Control': 'no-store' }); res.end(); }); return; }
    if (m[2] === '/logs') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(logBundle()); return; }
    if (m[2]) { phoneTyped = { seq: phoneTyped.seq + 1, text: String(u.query.text || '').slice(0, 80).replace(/[\u0000-\u001f<>]/g, ' ') }; res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(phoneSearchHtml());
  });
  phoneSrv.on('error', function () { phoneSrv = null; });
  phoneSrv.listen(PHONE_PORT, '0.0.0.0');
}

// ---- titles, descriptions, genres, episode names and artwork in the app's language, from TMDB with
// the user's own key (set from the phone: the TV keyboard is no place for 32 characters). Cinemeta is
// English only. One find + one details call per title (+ one per season for series), kept 3 days on
// disk so a title costs nothing the second time. Anything TMDB has no translation for stays empty and
// the app keeps the English. ----
var TMDB_API = process.env.SB_TMDB || 'https://api.themoviedb.org/3'; // SB_TMDB: tests only
var TMDB_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 }); // a row of titles = one TLS handshake, not forty
var TMDB_KEYF = path.join(DIR, 'tmdb.key'), LOC_DIR = path.join(DIR, 'cache', 'loc'), locMem = {}, locWait = {}, locMemN = 0;
function tmdbKey() { try { return fs.readFileSync(TMDB_KEYF, 'utf8').replace(/\s+/g, ''); } catch (e) { return ''; } }
function tmdbGet(p, key, cb) {
  var bearer = key.length > 40, u = TMDB_API + p + (bearer ? '' : (p.indexOf('?') < 0 ? '?' : '&') + 'api_key=' + encodeURIComponent(key));
  var pu = urlmod.parse(u), done = false, hd = { 'Accept': 'application/json', 'User-Agent': 'StremioBrew' }, req;
  if (bearer) hd.Authorization = 'Bearer ' + key; // a v4 "API Read Access Token"
  function fin(st, j) { if (!done) { done = true; cb(st, j); } }
  try {
    req = (pu.protocol === 'http:' ? http : https).get({ hostname: pu.hostname, port: pu.port, path: pu.path, headers: hd, agent: pu.protocol === 'http:' ? undefined : TMDB_AGENT }, function (r) {
      var ch = [], n = 0;
      r.on('data', function (d) { n += d.length; if (n < 4194304) ch.push(d); });
      r.on('end', function () { var j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) {} fin(r.statusCode, j); });
    });
  } catch (e) { return fin(0, null); }
  req.on('error', function () { fin(0, null); });
  req.setTimeout(12000, function () { try { req.abort(); } catch (e) {} fin(0, null); });
}
function locBest(list, lang) { // the most voted image in that language, PNG before SVG (the TV draws logos on a canvas)
  var b = null;
  for (var i = 0; i < (list || []).length; i++) {
    var x = list[i]; if (x.iso_639_1 !== lang || /\.svg$/i.test(x.file_path || '')) continue;
    if (!b || (x.vote_average || 0) > (b.vote_average || 0) || ((x.vote_average || 0) === (b.vote_average || 0) && (x.vote_count || 0) > (b.vote_count || 0))) b = x;
  }
  return b ? b.file_path : '';
}
function locFetch(type, id, lang, cb, light) { // light: no episode lists (rows of posters)
  var key = tmdbKey(); if (!key) return cb({ err: 'nokey' });
  tmdbGet('/find/' + id + '?external_source=imdb_id', key, function (st, f) {
    if (st === 401) return cb({ err: 'badkey' });
    if (!f) return cb({ err: 'net' });
    var mv = (f.movie_results || [])[0], tv = (f.tv_results || [])[0], kind = type === 'series' ? (tv ? 'tv' : mv ? 'movie' : '') : (mv ? 'movie' : tv ? 'tv' : '');
    if (!kind) return cb({ none: 1 });
    var tid = (kind === 'tv' ? tv : mv).id;
    tmdbGet('/' + kind + '/' + tid + '?language=' + lang + '&append_to_response=images,translations&include_image_language=' + lang, key, function (st2, d) {
      if (!d || !d.id) return cb({ err: 'net' });
      var out = { name: '', overview: '', genres: [], logo: '', poster: '', eps: {} }, tr = (d.translations && d.translations.translations) || [];
      for (var i = 0; i < tr.length; i++) if (tr[i].iso_639_1 === lang && tr[i].data) {
        var td = tr[i].data;
        if (!out.name) out.name = td.title || td.name || '';
        if (!out.overview) out.overview = td.overview || '';
      }
      for (i = 0; i < (d.genres || []).length; i++) if (d.genres[i].name) out.genres.push(d.genres[i].name);
      var im = d.images || {}, lg = locBest(im.logos, lang), po = locBest(im.posters, lang);
      if (lg) out.logo = 'https://image.tmdb.org/t/p/w500' + lg;
      if (po) out.poster = 'https://image.tmdb.org/t/p/w500' + po;
      if (kind !== 'tv') return cb(out);
      if (light) { out.lt = 1; return cb(out); }
      var ss = [], k = 0, left;
      for (i = 0; i < (d.seasons || []).length && ss.length < 40; i++) if (d.seasons[i].episode_count) ss.push(d.seasons[i].season_number);
      left = ss.length; if (!left) return cb(out);
      function next() { // four seasons at a time: the TV's Node, and TMDB's rate limit
        if (k >= ss.length) return;
        var sn = ss[k++];
        tmdbGet('/tv/' + tid + '/season/' + sn + '?language=' + lang, key, function (st3, s) {
          var e = (s && s.episodes) || [];
          for (var j = 0; j < e.length; j++) if (e[j].name || e[j].overview) out.eps[sn + ':' + e[j].episode_number] = [e[j].name || '', e[j].overview || ''];
          if (--left === 0) cb(out); else next();
        });
      }
      for (i = 0; i < 4; i++) next();
    });
  });
}
function locFile(lang, id) { return path.join(LOC_DIR, lang + '_' + id + '.json'); }
function locRoute(q, res) {
  var type = q.type === 'series' ? 'series' : 'movie', id = String(q.id || ''), lang = String(q.lang || '').toLowerCase();
  if (!/^tt\d{5,10}$/.test(id) || !/^[a-z]{2}$/.test(lang) || lang === 'en') return sendJson(res, { none: 1 });
  locOne(type, id, lang, false, function (v) { sendJson(res, v); });
}
// many titles at once for rows of cards: ids=movie:tt1,series:tt2 (at most 40), light entries
function locsRoute(q, res) {
  var lang = String(q.lang || '').toLowerCase(), ids = String(q.ids || '').split(',').slice(0, 40), out = {}, left = 0, k = 0, done = false;
  if (!/^[a-z]{2}$/.test(lang) || lang === 'en') return sendJson(res, {});
  ids = ids.filter(function (x) { return /^(movie|series):tt\d{5,10}$/.test(x); });
  left = ids.length; if (!left) return sendJson(res, {});
  function fin() { if (!done) { done = true; sendJson(res, out); } }
  var tmo = setTimeout(fin, 20000); // whatever is ready by then; the rest is cached for next time
  function next() {
    if (k >= ids.length) return;
    var p2 = ids[k++].split(':');
    locOne(p2[0], p2[1], lang, true, function (v) { out[p2[1]] = v; if (--left === 0) { clearTimeout(tmo); fin(); } else next(); });
  }
  for (var i = 0; i < 4; i++) next();
}
function locOne(type, id, lang, light, cb) {
  var ck = lang + ':' + id, c = locMem[ck];
  function fresh(x) { return x && Date.now() - x.at < (x.v.err ? 300000 : 259200000) && (light || !x.v.lt); }
  if (fresh(c)) return cb(c.v);
  if (!c) { try { var fc = JSON.parse(fs.readFileSync(locFile(lang, id), 'utf8')); if (fresh(fc)) { locMem[ck] = fc; return cb(fc.v); } } catch (e) {} }
  var wk = ck + (light ? ':l' : '');
  if (locWait[wk]) { locWait[wk].push(cb); return; }
  locWait[wk] = [cb];
  locFetch(type, id, lang, function (v) {
    var w = locWait[wk] || []; delete locWait[wk];
    if (++locMemN > 300) { locMem = {}; locMemN = 0; }
    locMem[ck] = { at: Date.now(), v: v };
    if (!v.err) try {
      try { fs.mkdirSync(path.join(DIR, 'cache')); } catch (e) {}
      try { fs.mkdirSync(LOC_DIR); } catch (e) {}
      fs.writeFileSync(locFile(lang, id), JSON.stringify(locMem[ck]));
      if (Math.random() < 0.05) { // keep the folder small: oldest out past 800 titles
        var fl = fs.readdirSync(LOC_DIR); if (fl.length > 800) { fl.map(function (n) { var p2 = path.join(LOC_DIR, n); try { return { p: p2, t: fs.statSync(p2).mtime.getTime() }; } catch (e) { return { p: p2, t: 0 }; } }).sort(function (a, b) { return a.t - b.t; }).slice(0, 200).forEach(function (x) { try { fs.unlinkSync(x.p); } catch (e) {} }); }
      }
    } catch (e) {}
    for (var i = 0; i < w.length; i++) try { w[i](v); } catch (e) {}
  }, light);
}
function tmdbSet(key, cb) { // checked against TMDB before it is kept
  key = String(key || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9._-]{20,400}$/.test(key)) return cb(false);
  tmdbGet('/configuration', key, function (st) {
    if (st !== 200) return cb(false);
    try { fs.writeFileSync(TMDB_KEYF, key); } catch (e) { return cb(false); }
    locMem = {}; locMemN = 0; cb(true);
  });
}
function qrBits(u) { // the QR's modules, worked out here (in the TV's page the encoder took ~170 ms of its thread)
  var bits = '', n = 0;
  if (u) { try { var qq = require('./qrcode.js')(0, 'L'); qq.addData(u); qq.make(); n = qq.getModuleCount(); for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) bits += qq.isDark(r, c) ? '1' : '0'; } catch (e) { bits = ''; n = 0; } }
  return { url: u, n: n, bits: bits };
}

// ---- catalogs for the app, slimmed: a Cinemeta catalog is ~100 full metas (cast, trailers, links...) and
// parsing it took the TV's page 50-150 ms each (403 ms of a start); the app uses the first n with a few
// fields. Parsed here (another process), kept 10 min ----
var catMem = {}, catMemN = 0;
function catRoute(q, res) {
  var u = String(q.u || ''), n = Math.min(100, Math.max(1, parseInt(q.n, 10) || 16)), ck = n + ' ' + u, c = catMem[ck];
  if (!/^https?:\/\//.test(u)) return sendJson(res, { metas: [] });
  if (c && Date.now() - c.at < 600000) return sendJson(res, c.v);
  fetchJson(u, function (j) {
    var ms = (j && j.metas) || [], out = [];
    for (var i = 0; i < ms.length && out.length < n; i++) { var m = ms[i]; if (!m || !m.id) continue;
      out.push({ id: m.id, type: m.type, name: m.name, poster: m.poster, background: m.background, logo: m.logo, description: String(m.description || '').slice(0, 600),
        releaseInfo: m.releaseInfo, year: m.year, runtime: m.runtime, imdbRating: m.imdbRating, genres: m.genres ? m.genres.slice(0, 3) : undefined }); }
    var v = { metas: out, ok: !!j };
    if (j) { if (++catMemN > 120) { catMem = {}; catMemN = 0; } catMem[ck] = { at: Date.now(), v: v }; }
    sendJson(res, v);
  });
}

// ---- search suggestions as you type: IMDb's own autocomplete (prefix + popularity ranked, typo
// tolerant on the first letters), films and series only, mapped to the app's items. Cached 10 min ----
var sugCache = {};
function sugRoute(q, res) {
  var s = String(q.q || '').toLowerCase().replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 60);
  if (!s) return sendJson(res, { items: [] });
  var c = sugCache[s];
  if (c && Date.now() - c.at < 600000) return sendJson(res, c.out);
  var first = /[a-z0-9]/.test(s.charAt(0)) ? s.charAt(0) : 'x';
  fetchJson('https://v3.sg.media-imdb.com/suggestion/' + first + '/' + encodeURIComponent(s) + '.json', function (j) {
    var out = { items: [] }, d = (j && j.d) || [];
    for (var i = 0; i < d.length; i++) {
      var x = d[i], id = String(x.id || ''), qid = String(x.qid || '');
      if (!/^tt\d+$/.test(id)) continue;
      var type = /^(tvSeries|tvMiniSeries)$/.test(qid) ? 'series' : /^(movie|tvMovie|tvSpecial|short|video)$/.test(qid) ? 'movie' : '';
      if (!type) continue;
      var img = x.i && x.i.imageUrl ? String(x.i.imageUrl).replace(/\._V1_\.(jpg|png)$/, '._V1_QL75_UX300_.$1') : '';
      out.items.push({ id: id, type: type, name: x.l || '', year: x.yr || (x.y ? String(x.y) : ''), poster: img || 'https://images.metahub.space/poster/small/' + id + '/img', cast: x.s || '' });
    }
    if (j) { sugCache[s] = { at: Date.now(), out: out }; capKeys(sugCache, 100); }
    sendJson(res, out);
  });
}

// ---- intro / recap / credits for the player's skip prompts ----
// Sources, best first, merged per segment (like Nuvio): the file's own MKV chapters ("Opening",
// "Recap", "End Credits"...: exact for this very cut), TheIntroDB (api.theintrodb.org, by IMDb
// id, films too), IntroDB (api.introdb.app), and AniSkip for anime from Kitsu-based addons
// (TLS 1.3 only: unreachable from the TV's Node). A segment that doesn't fit this file's length
// (an intro in the second half, credits before the middle...) is dropped and the next source is
// used. Answer: { ok, intro: {s, e}, recap, outro, src } in seconds. API answers are cached 6 h,
// errors and rate limits are never cached.
var skipsApi = {}; // url -> { at, j }
function skipsFetch(u, cb) {
  var c = skipsApi[u];
  if (c && Date.now() - c.at < 6 * 3600000) return cb(c.j);
  var tries = 0;
  (function ask() {
    fetchJson(u, function (j) {
      var real = j && !j.error && (j.imdb_id || j.tmdb_id || j.found != null);
      var miss = j && j.error && /not found/i.test(String(j.error)); // a real "nothing for this title"
      if (!real && !miss && ++tries < 3) return setTimeout(ask, 1500);
      if (real || miss) { skipsApi[u] = { at: Date.now(), j: real ? j : {} }; capKeys(skipsApi, 120); }
      cb(real ? j : null);
    });
  })();
}
function chapterSegs(list) {
  var out = {};
  for (var i = 0; i < list.length; i++) {
    var c = list[i], n = String(c.name || '').toLowerCase(), g = c.e > c.s ? { s: c.s, e: c.e } : null;
    if (!g || /^(chapter|chapitre|kapitel|cap[ií]tulo|capitolo|hoofdstuk)?\s*\d+$/.test(n)) continue;
    if (/cold open|teaser/.test(n)) continue;
    if (/(^|\W)(intro|opening|op|title sequence|main titles?|theme song|g[ée]n[ée]rique( de d[ée]but)?|vorspann)(\W|$)/.test(n) && !out.intro) out.intro = g;
    else if (/(^|\W)(recap|previously|r[ée]sum[ée]|r[üu]ckblick|summary)(\W|$)/.test(n) && !out.recap) out.recap = g;
    else if (/(^|\W)(credits?|end ?credits|ending|ed|outro|closing|end titles?|g[ée]n[ée]rique de fin|abspann)(\W|$)/.test(n) && !out.outro) {
      out.outro = g;
      var nx = list[i + 1]; // credits followed by a preview / post-credits scene: stop there
      if (nx && /preview|next (episode|time)|post.?credits|stinger|bonus/.test(String(nx.name || '').toLowerCase())) out.outro.e = nx.s;
    }
  }
  return out;
}
function skipsRoute(q, res) {
  var type = String(q.type || ''), id = String(q.id || ''), vid = String(q.vid || id), dur = parseFloat(q.dur) || 0, file = String(q.u || '');
  function seg(a, b) { a = parseFloat(a); b = parseFloat(b); return (a >= 0 && b > a) ? { s: a, e: b } : null; }
  function fits(k, g) { // a segment that can't belong to this file
    if (!g) return false;
    if (!dur) return true;
    if (g.s >= dur || g.e > dur + 30) return false;
    if (k === 'outro') return g.s >= dur * 0.5;
    return g.s < dur * 0.4 && g.e - g.s >= 3 && g.e - g.s <= 420;
  }
  var srcs = [], pending = 1, sent = false; // 1 = still adding jobs (a cached answer comes back at once)
  function finish() {
    if (sent || pending > 0) return; sent = true;
    var out = { src: {} }, ks = ['intro', 'recap', 'outro'];
    for (var i = 0; i < ks.length; i++) {
      for (var j = 0; j < srcs.length; j++) { var g = srcs[j].segs[ks[i]]; if (fits(ks[i], g)) { out[ks[i]] = g; out.src[ks[i]] = srcs[j].name; break; } }
    }
    if (out.outro && dur && out.outro.e > dur) out.outro.e = dur;
    out.ok = !!(out.intro || out.recap || out.outro);
    sendJson(res, out);
  }
  var quickT = null;
  function add(rank, name, segs) {
    srcs.push({ rank: rank, name: name, segs: segs || {} }); srcs.sort(function (a, b) { return a.rank - b.rank; });
    // one source has answered: the others get 2.5 s more, not 14 (reading a torrent's chapters can take
    // long, and an intro at the very start would be over before the answer)
    if (!quickT && segs && (segs.intro || segs.recap || segs.outro)) quickT = setTimeout(function () { pending = 0; finish(); }, 2500);
  }
  function job(f) { pending++; f(function () { pending--; finish(); }); }
  var to = setTimeout(function () { pending = 0; finish(); }, 14000); // whatever answered in time
  res.on('finish', function () { clearTimeout(to); clearTimeout(quickT); });

  // 1. the file's own chapters
  if (file && !/\.m3u8(\?|$)/.test(file)) job(function (done) {
    mkvsubs.chapters(file, function (err, list) { if (!err && list && list.length) add(0, 'chapters', chapterSegs(list)); done(); }, q.p2p ? 64 * 1048576 : 0);
  });
  var km = /^kitsu:(\d+)(?::(\d+))?/.exec(vid);
  if (km) {
    var ep = parseInt(km[2] || '1', 10);
    job(function (done) {
      skipsFetch('https://kitsu.io/api/edge/anime/' + km[1] + '/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime', function (j) {
        var mal = j && j.data && j.data[0] && j.data[0].attributes && j.data[0].attributes.externalId;
        if (!mal) return done();
        skipsFetch('https://api.aniskip.com/v2/skip-times/' + encodeURIComponent(mal) + '/' + ep + '?types=op&types=ed&types=recap&types=mixed-op&types=mixed-ed&episodeLength=0', function (a) {
          var out = {}, r = (a && a.found && a.results) || [];
          for (var i = 0; i < r.length; i++) {
            var iv = r[i].interval || {}, sg = seg(iv.startTime, iv.endTime), t = r[i].skipType; if (!sg) continue;
            if ((t === 'op' || t === 'mixed-op') && !out.intro) out.intro = sg;
            else if ((t === 'ed' || t === 'mixed-ed') && !out.outro) out.outro = sg;
            else if (t === 'recap' && !out.recap) out.recap = sg;
          }
          add(3, 'aniskip', out); done();
        });
      });
    });
  }
  var im = /^(tt\d+)/.exec(id) || /^(tt\d+)/.exec(vid);
  if (im) {
    var p = vid.split(':'), isEp = type === 'series' && p.length > 2, se = isEp ? parseInt(p[p.length - 2], 10) : 0, en = isEp ? parseInt(p[p.length - 1], 10) : 0;
    // 2. TheIntroDB: lists of { start_ms, end_ms } (null start = from 0, null end = to the end)
    job(function (done) {
      skipsFetch('https://api.theintrodb.org/v3/media?imdb_id=' + im[1] + (isEp ? '&season=' + se + '&episode=' + en : ''), function (j) {
        if (!j || (isEp && j.episode != null && (j.season !== se || j.episode !== en))) return done(); // another episode: not ours
        function one(l, k) {
          var a = l && l[0]; if (!a) return null;
          var s0 = a.start_ms == null ? 0 : a.start_ms / 1000, e0 = a.end_ms == null ? (k === 'outro' ? (dur || s0 + 600) : -1) : a.end_ms / 1000;
          return seg(s0, e0);
        }
        add(1, 'theintrodb', { intro: one(j.intro, 'intro'), recap: one(j.recap, 'recap'), outro: one(j.credits, 'outro') }); done();
      });
    });
    // 3. IntroDB
    job(function (done) {
      skipsFetch('https://api.introdb.app/segments?imdb_id=' + im[1] + (isEp ? '&season=' + se + '&episode=' + en : '&is_movie=true'), function (j) {
        if (!j) return done();
        add(2, 'introdb', { intro: j.intro && seg(j.intro.start_sec, j.intro.end_sec), recap: j.recap && seg(j.recap.start_sec, j.recap.end_sec),
          outro: j.outro && seg(j.outro.start_sec, j.outro.end_sec == null ? (dur || j.outro.start_sec + 600) : j.outro.end_sec) });
        done();
      });
    });
  }
  pending--; finish();
}

// ---- memory watchdog ----
// This helper outlives the app (only a TV restart used to end it), so whatever it holds stays
// taken when the TV kills the app for memory, and every relaunch was killed again. Once a
// minute: above SOFT it drops idle subtitle sessions and every cache; above HARD, if no video
// goes through it or the P2P engine, it exits (the app and the player start a fresh one).
var MEM_SOFT_MB = +process.env.SB_MEM_SOFT || 64, MEM_HARD_MB = +process.env.SB_MEM_HARD || 150, p2pKeepaliveAt = 0; // env: tests only
function memMb() { // resident + swapped out: on this TV most of an idle process sits in swap
  try {
    var st = fs.readFileSync('/proc/self/status', 'utf8');
    var r = /VmRSS:\s+(\d+)/.exec(st), w = /VmSwap:\s+(\d+)/.exec(st);
    if (r) return Math.round((parseInt(r[1], 10) + (w ? parseInt(w[1], 10) : 0)) / 1024);
  } catch (e) {}
  return Math.round(process.memoryUsage().rss / 1048576);
}
// ---- subtitle auto-sync: an external subtitle (OpenSubtitles...) is lined up with a reference whose timing
// is right for THIS video: the file's own subtitle tracks (any language: only WHEN lines are spoken matters,
// read cheaply from the Matroska index), else the speech found in ~70 s of its audio (needs an ffmpeg with
// audio decoders). Every offset within +-30 s (50 ms steps) is tried at the usual frame-rate ratios; the best
// overlap wins only when it clearly beats the rest. -> { ok, d, f, by, score }  (new time = old * f + d)
var SYNC_SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
function syncAlign(X, R, center, edges) { // edges: R is a subtitle track, so line starts/ends count too
  var STEP = 0.05, lo = center - 180, hi = center + 260, i, k;
  R = R.filter(function (c) { return c.e > lo && c.s < hi; });
  if (R.length < 6) return null;
  var W0 = Math.min.apply(null, R.map(function (c) { return c.s; })), W1 = Math.max.apply(null, R.map(function (c) { return c.e; }));
  var N = Math.ceil((W1 - W0) / STEP) + 1, A = new Uint8Array(N), P = new Float64Array(N + 1);
  for (i = 0; i < R.length; i++) for (k = Math.max(0, Math.floor((R[i].s - W0) / STEP)); k <= Math.min(N - 1, Math.floor((R[i].e - W0) / STEP)); k++) A[k] = 1;
  for (i = 0; i < N; i++) P[i + 1] = P[i] + A[i];
  function cover(a, b) { // seconds of reference activity inside [a,b]
    var ia = Math.max(0, Math.min(N, (a - W0) / STEP)), ib = Math.max(0, Math.min(N, (b - W0) / STEP));
    if (ib <= ia) return 0; return (P[Math.floor(ib)] - P[Math.floor(ia)]) * STEP;
  }
  // against a subtitle track, overlap alone is a weak judge when someone talks nearly all the time (any shift
  // overlaps); where lines START and END is sharp: only the right shift puts most of them within 0.35 s
  var RS = R.map(function (c) { return c.s; }).sort(function (a, b) { return a - b; }), RE = R.map(function (c) { return c.e; }).sort(function (a, b) { return a - b; });
  function near(arr, v) { var l = 0, h = arr.length - 1; while (l < h) { var m = (l + h) >> 1; if (arr[m] < v) l = m + 1; else h = m; } return Math.min(Math.abs(arr[l] - v), l > 0 ? Math.abs(arr[l - 1] - v) : 1e9) < 0.35; }
  var best = { r: -1 }, all = [];
  function score(xs, dd) {
    var ov = 0, tot = 0, hit = 0, cnt = 0;
    for (var q = 0; q < xs.length; q++) { var s1 = xs[q][0] + dd, e1 = xs[q][1] + dd; if (e1 <= W0 || s1 >= W1) continue; tot += Math.min(e1, W1) - Math.max(s1, W0); ov += cover(s1, e1);
      if (edges) { cnt += 2; if (near(RS, s1)) hit++; if (near(RE, e1)) hit++; } }
    if (tot < 20) return -1;
    return edges ? 0.35 * ov / tot + 0.65 * hit / cnt : ov / tot;
  }
  // coarse (0.25 s) over the whole range, then 50 ms steps around the three best of each frame rate
  for (var si = 0; si < SYNC_SCALES.length; si++) {
    var f = SYNC_SCALES[si], c0 = 0, xs = []; // a subtitle timed for another frame rate is the right one stretched from 0: small offsets
    for (i = 0; i < X.length; i++) { var a = X[i].s * f + c0, b = X[i].e * f + c0; if (b > W0 - 40 && a < W1 + 40) xs.push([a, b]); }
    if (xs.length < 6) continue;
    var top = [];
    for (var dd = -30; dd <= 30.0001; dd += 0.25) {
      var r = score(xs, dd); if (r < 0) continue; all.push([r, f, c0 + dd]);
      top.push([r, dd]); if (top.length > 3) { top.sort(function (p1, p2) { return p2[0] - p1[0]; }); top.length = 3; }
    }
    for (k = 0; k < top.length; k++) for (var fd = top[k][1] - 0.25; fd <= top[k][1] + 0.2501; fd += STEP) {
      var rf = score(xs, fd); if (rf < 0) continue; all.push([rf, f, c0 + fd]);
      if (rf > best.r) best = { r: rf, f: f, d: c0 + fd };
    }
  }
  if (best.r < 0) return null;
  var second = 0; // the best answer that is not just a neighbour of the winner
  var bc = center * best.f + best.d; // where the winner puts the current scene; a rival must put it >1.5 s away
  for (i = 0; i < all.length; i++) if (Math.abs(center * all[i][1] + all[i][2] - bc) > 1.5 && all[i][0] > second) second = all[i][0];
  return { d: Math.round(best.d * 100) / 100, f: best.f, score: Math.round(best.r * 100) / 100, margin: Math.round((best.r - second) * 100) / 100 };
}
// the same words on both sides (the file's own track and the downloaded subtitle in one language, the usual
// case): every pair of matching lines votes for a shift, and the right shift collects nearly all the votes.
// Exact even when the two were split into lines differently or someone talks all the time. Different
// languages = no pairs = the timing-only matcher decides.
function syncWords(t) { return String(t || '').toLowerCase().replace(/<[^>]*>|\{[^}]*\}/g, ' ').replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff]+/g, ' ').replace(/^ | $/g, '').split(' ').filter(function (w) { return w.length > 1; }); }
function syncByText(X, R, center) {
  var Rn = R.filter(function (c) { return c.t && c.e > center - 180 && c.s < center + 260; }), pairs = [], i, j, k;
  if (Rn.length < 8) return null;
  var Xw = X.map(function (c) { var w = syncWords(c.t), o = {}; for (var q = 0; q < w.length; q++) o[w[q]] = 1; return { s: c.s, e: c.e, w: o, n: w.length }; });
  for (i = 0; i < Rn.length; i++) {
    var rw = syncWords(Rn[i].t); if (rw.length < 3) continue; // "Yes." / "No!" are everywhere
    var ro = {}, rn = 0; for (k = 0; k < rw.length; k++) if (!ro[rw[k]]) { ro[rw[k]] = 1; rn++; }
    var lo = Rn[i].s / 1.05 - 40, hi = Rn[i].s / 0.95 + 40;
    for (j = 0; j < Xw.length; j++) { var x = Xw[j]; if (x.s < lo || x.s > hi || x.n < 2) continue;
      var inter = 0, xn = 0; for (var w in x.w) { xn++; if (ro[w]) inter++; }
      if (inter >= 2 && inter / (rn + xn - inter) >= 0.6) pairs.push([x.s, Rn[i].s]); }
  }
  if (pairs.length < 4) return null;
  var best = null, cl = [];
  for (var si = 0; si < SYNC_SCALES.length; si++) {
    var f = SYNC_SCALES[si], ds = pairs.map(function (p) { return p[1] - p[0] * f; }).filter(function (d) { return d >= -30 && d <= 30; }).sort(function (a, b) { return a - b; });
    for (i = 0, j = 0; i < ds.length; i++) { // the densest 0.6 s of votes
      while (ds[i] - ds[j] > 0.6) j++;
      var n = i - j + 1, mid = ds[j + (n >> 1)], spread = ds[i] - ds[j];
      cl.push({ n: n, f: f, d: mid });
      if (!best || n > best.n) best = { n: n, f: f, d: mid, sp: spread }; // a tie goes to the more common frame-rate pair (listed first): 25/23.976 and 25/24 look the same over 2 minutes
    }
  }
  if (!best) return null;
  var bc = center * best.f + best.d, second = 0;
  for (i = 0; i < cl.length; i++) if (Math.abs(center * cl[i].f + cl[i].d - bc) > 1.5 && cl[i].n > second) second = cl[i].n;
  return { d: Math.round(best.d * 100) / 100, f: best.f, votes: best.n, rival: second, pairs: pairs.length };
}
var ffAudio = null; // does the bundled ffmpeg decode audio? (the TV build may not)
function ffHasAudio(cb) {
  if (ffAudio !== null) return cb(ffAudio);
  var out = '', pr; try { pr = spawn(FFMPEG, ['-hide_banner', '-decoders']); } catch (e) { ffAudio = false; return cb(false); }
  pr.stdout.on('data', function (d) { out += d; }); pr.on('error', function () { ffAudio = false; cb(false); });
  pr.on('close', function () { ffAudio = / aac /.test(out) && / ac3 /.test(out); cb(ffAudio); });
}
function speechOf(u, t, cb) { // ~70 s of mono 8 kHz around t -> speech segments [{s,e}] in video time
  var start = Math.max(0, t - 15), dur = 70, chunks = [], pr, done = false;
  function fin(ok) { if (done) return; done = true; clearTimeout(to); try { pr.kill('SIGKILL'); } catch (e) {}
    if (!ok) return cb(null);
    var buf = Buffer.concat(chunks), n = Math.floor(buf.length / 2), FR = 160, frames = Math.floor(n / FR), db = [], i, j;
    for (i = 0; i < frames; i++) { var e = 0; for (j = 0; j < FR; j++) { var v = buf.readInt16LE((i * FR + j) * 2); e += v * v; } db.push(10 * Math.log(e / FR + 1) / Math.LN10); }
    if (frames < 500) return cb(null);
    var sorted = db.slice().sort(function (a, b) { return a - b; }), thr = sorted[Math.floor(frames * 0.2)] + 9, segs = [], cur = null;
    for (i = 0; i < frames; i++) { var on = db[i] > thr, ts = start + i * 0.02;
      if (on) { if (cur && ts - cur.e < 0.3) cur.e = ts + 0.02; else { if (cur && cur.e - cur.s >= 0.2) segs.push(cur); cur = { s: ts, e: ts + 0.02 }; } } }
    if (cur && cur.e - cur.s >= 0.2) segs.push(cur);
    cb(segs);
  }
  try { pr = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', localProxy(u), '-t', String(dur), '-vn', '-sn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']); } catch (e) { return cb(null); }
  var to = setTimeout(function () { fin(chunks.length > 0); }, 45000);
  pr.stdout.on('data', function (d) { chunks.push(d); }); pr.on('error', function () { fin(false); }); pr.on('close', function () { fin(true); });
}
function subSync(q, res) {
  var vu = q.u || '', su = q.sub || '', t = Math.max(0, parseFloat(q.t || '0') || 0);
  if (!vu || !su) return sendJson(res, { ok: false, why: 'args' });
  fetchUrl(su, function (buf) {
    var X = buf ? parseSrt(buf.toString('utf8')) : [];
    if (X.length < 10) return sendJson(res, { ok: false, why: 'nosub' });
    function answer(m, by) {
      if (!m || m.score < 0.45 || m.margin < 0.08) { dbg('[subsync] ' + by + ' unsure ' + JSON.stringify(m)); return sendJson(res, { ok: false, why: 'unsure', by: by }); }
      dbg('[subsync] ' + by + ' d=' + m.d + ' f=' + m.f.toFixed(4) + ' score=' + m.score + ' margin=' + m.margin);
      sendJson(res, { ok: true, d: m.d, f: m.f, by: by, score: m.score });
    }
    function byAudio(hadTracks) {
      ffHasAudio(function (yes) {
        if (!yes) return sendJson(res, { ok: false, why: hadTracks ? 'notyet' : 'noref' });
        speechOf(vu, t, function (segs) {
          if (!segs || segs.length < 6) { dbg('[subsync] audio: ' + (segs ? segs.length + ' speech parts' : 'no audio read')); return sendJson(res, { ok: false, why: hadTracks ? 'notyet' : 'noaudio' }); }
          answer(syncAlign(X, segs, t), 'audio');
        });
      });
    }
    // the file's own subtitle tracks: the session that harvests them for the player (or a new one)
    var e = subSession(vu, t, true), t0 = Date.now();
    (function wait() {
      var ss = e && e.s, bestR = null, bestN = 0;
      if (ss && !ss.dead && ss.state !== 'fallback') for (var num in ss.tracks) {
        var cs = ss.tracks[num].cues || [], nIn = 0;
        for (var i = 0; i < cs.length; i++) if (cs[i].e > t - 180 && cs[i].s < t + 260) nIn++;
        if (nIn > bestN) { bestN = nIn; bestR = cs; }
      }
      if (bestN >= 12) {
        var tx = syncByText(X, bestR, t);
        if (tx) dbg('[subsync] words ' + JSON.stringify(tx));
        if (tx && tx.votes >= 4 && tx.votes >= 2.5 * Math.max(1, tx.rival)) return answer({ d: tx.d, f: tx.f, score: 1, margin: 1 }, 'words');
        return answer(syncAlign(X, bestR, t, true), 'reference');
      }
      var none = ss && ss.state !== 'starting' && !Object.keys(ss.tracks).length; // the file has no text tracks at all
      // its own tracks are the best reference by far: while they are being read (a torrent brings them in as its
      // pieces arrive) keep waiting, up to 45 s, before trying the audio
      var limit = (ss && !none && !ss.dead && ss.state !== 'fallback') ? 45000 : 12000;
      if (!ss || ss.dead || ss.state === 'fallback' || none || Date.now() - t0 > limit) { dbg('[subsync] reference: ' + bestN + ' lines near ' + Math.round(t) + ' s after ' + Math.round((Date.now() - t0) / 1000) + ' s -> audio'); return byAudio(!none && !!ss); }
      setTimeout(wait, 500);
    })();
  });
}

// ---- app logs: the app sends its errors and notable events here (POST /log, from 127.0.0.1 only); they are
// scrubbed (no query strings, no key-like path parts, no emails), kept in a small rotating file next to the
// helper's own log, and handed out as one text bundle: /logs locally, or on the phone through the same
// random-token link as typing (only after the TV shows the "Share logs" code). Nothing leaves the TV by itself.
var APPLOG = path.join(DIR, 'applog.log'), APPLOG_MAX = 400 * 1024;
function scrub(t) {
  return String(t || '').slice(0, 2000)
    .replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/g, '$1?…') // query strings carry keys / tokens
    .replace(/[A-Za-z0-9_\-]{24,}/g, '…') // any long key-like run (debrid keys, addon configs, tokens, hashes)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ');
}
function appLog(lines) {
  if (!lines || !lines.length) return;
  var out = ''; for (var i = 0; i < lines.length && i < 200; i++) out += new Date().toISOString() + ' ' + scrub(lines[i]) + '\n';
  try {
    fs.appendFileSync(APPLOG, out);
    if (fs.statSync(APPLOG).size > APPLOG_MAX) { var keep = fs.readFileSync(APPLOG, 'utf8'); fs.writeFileSync(APPLOG, keep.slice(keep.length - APPLOG_MAX / 2)); }
  } catch (e) {}
}
function tailOf(f, n) { try { var l = fs.readFileSync(f, 'utf8').split('\n'); return l.slice(Math.max(0, l.length - n)).map(scrub).join('\n'); } catch (e) { return '(none)'; } }
function logBundle() {
  var info = [], osi = '';
  try { var ai = JSON.parse(fs.readFileSync(path.join(DIR, '..', '..', 'applications', 'tv.stremiobrew.app', 'appinfo.json'), 'utf8')); info.push('app ' + ai.id + ' ' + ai.version); } catch (e) {}
  try { osi = fs.readFileSync('/var/run/nyx/os_info.json', 'utf8'); var o = JSON.parse(osi); info.push('webOS ' + (o.webos_release || o.core_os_release || '?') + ' (' + (o.webos_name || '') + ') ' + (o.webos_build_id || '')); } catch (e) {}
  try { var di = JSON.parse(fs.readFileSync('/var/run/nyx/device_info.json', 'utf8')); info.push('model ' + (di.device_name || di.hardware_id || '')); } catch (e) {}
  info.push('node ' + process.version + ' · helper ' + memMb() + ' MB · TV free ' + memAvail() + ' MB · up ' + Math.round(process.uptime()) + ' s');
  return 'StremioBrew logs - ' + new Date().toISOString() + '\n' + info.join('\n') +
    '\n\n== player notes (last) ==\n' + (hbRing.join('\n') || '(none)') +
    '\n\n== app ==\n' + tailOf(APPLOG, 400) + '\n\n== helper ==\n' + tailOf(path.join(DIR, 'tvserver.log'), 250) +
    '\n\n== P2P engine ==\n' + tailOf(path.join(DIR, 'engine.log'), 60) + '\n';
}

// ---- player flight recorder: the app sends a state note every 20 s while the player is open. Kept in
// memory (last 30); if they stop without a 'closed' note, the app died: the notes go to the log ----
var hbRing = [], hbWatch = null;
function procMem(pat) { // VmRSS+VmSwap (MB) of the first process whose command line matches
  try { var ds = fs.readdirSync('/proc');
    for (var i = 0; i < ds.length; i++) { if (!/^\d+$/.test(ds[i])) continue; var c = '';
      try { c = fs.readFileSync('/proc/' + ds[i] + '/cmdline', 'utf8'); } catch (e) { continue; }
      if (c.indexOf(pat) < 0) continue;
      var s = fs.readFileSync('/proc/' + ds[i] + '/status', 'utf8'), r = /VmRSS:\s+(\d+)/.exec(s), w = /VmSwap:\s+(\d+)/.exec(s);
      return Math.round(((r ? +r[1] : 0) + (w ? +w[1] : 0)) / 1024); } } catch (e) {}
  return -1;
}
function memAvail() { try { var m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); return m ? Math.round(+m[1] / 1024) : -1; } catch (e) { return -1; } }
function heartbeatIn(q) {
  clearTimeout(hbWatch);
  if (q.s === 'closed') { hbRing = []; return; }
  hbRing.push(new Date().toISOString().slice(11, 19) + ' ' + q.s + ' t=' + q.t + ' sub=' + q.sub + ' cues=' + q.cues + ' heap=' + q.heap + 'MB dom=' + q.dom +
    ' mode=' + q.mode + ' p2p=' + q.p2p + ' | tvFree=' + memAvail() + 'MB app=' + procMem('--type=renderer') + 'MB helper=' + memMb() + 'MB');
  while (hbRing.length > 30) hbRing.shift();
  hbWatch = setTimeout(function () { // no note for 70 s and no close: the app is gone (crash, killed by the TV)
    dbg('[flight] player notes stopped without a close - the last ones:\n  ' + hbRing.join('\n  ') + '\n  now tvFree=' + memAvail() + 'MB');
    hbRing = [];
  }, 70000);
}
function capKeys(o, max) { var k = Object.keys(o); for (var i = 0; i < k.length - max; i++) delete o[k[i]]; } // oldest first
function clearObj(o) { for (var k in o) delete o[k]; }
setInterval(function () {
  // caches stay small at all times (newest kept; each entry is re-fetched on a miss)
  capKeys(resolveCache, 40); capKeys(ytCache, 40); capKeys(ytFail, 200); capKeys(imdbCache, 60); capKeys(imdbFail, 200);
  capKeys(cinemetaYtCache, 100); capKeys(ytCapCache, 60); capKeys(trailerCache, 40); capKeys(subsCache, 40); capKeys(skipsApi, 120);
  var mb = memMb();
  if (mb < MEM_SOFT_MB) return;
  var closed = 0;
  for (var u in subSessions) if (Date.now() - subSessions[u].used > 30000) { subSessions[u].s.stop(); delete subSessions[u]; closed++; }
  clearObj(ytCache); clearObj(imdbCache); clearObj(cinemetaYtCache); clearObj(ytCapCache); clearObj(trailerCache);
  clearObj(imgxCache); imgxOrder.length = 0; catMem = {}; catMemN = 0; locMem = {}; locMemN = 0; sizeMem = {}; sizeMemN = 0; sugCache = {};
  for (var sk in subsCache) if (subsCache[sk] && subsCache[sk].out) delete subsCache[sk];
  if (embJob && Date.now() - embJob.lastPoll > 30000) killJob();
  // a full collection after the trim: Node 0.12 otherwise keeps the freed pages (seen at 100-110 MB, ~80 MB of it
  // in swap, growing through a long watch while the TV itself was short of memory)
  if (global.gc) { try { global.gc(); } catch (e) {} }
  dbg('memory ' + mb + ' MB: trimmed (' + closed + ' idle subtitle sessions closed) -> ' + memMb() + ' MB');
  var playing = activeProxy > 0 || engineActiveStreams > 0 || Date.now() - p2pKeepaliveAt < 60000;
  if (mb >= MEM_HARD_MB && !playing) respawn('memory ' + mb + ' MB with nothing playing');
}, +process.env.SB_MEM_TICK || 60000);
// Between those trims: a full collection as soon as the helper has grown 16 MB since the last one (dead Buffers
// from streamed video / subtitle scans; Node 0.12 leaves them until its small heap fills). Checked every 10 s.
var gcBase = 0;
setInterval(function () {
  var mb = memMb();
  if (!gcBase || mb < gcBase) gcBase = mb;
  if (mb - gcBase < 16 || !global.gc) return;
  try { global.gc(); } catch (e) {}
  gcBase = memMb();
}, 10000);
// A restart for memory starts the next helper first (it waits a second for the port): the app only starts one
// when it launches, so a helper that just exited left the QR codes, subtitles and P2P dead until a relaunch.
function respawn(why) {
  dbg(why + ': restarting the helper');
  try {
    var c = require('child_process').spawn('/bin/sh', ['-c', 'sleep 1; HOME=/home/root USER=root exec "$0" --max-old-space-size=96 --expose-gc "$1" >>"$2" 2>&1 </dev/null',
      process.execPath, __filename, path.join(DIR, 'tvserver.log')], { cwd: DIR, detached: true, stdio: 'ignore' });
    c.unref();
  } catch (e) { dbg('respawn failed: ' + e.message); }
  setTimeout(function () { process.exit(0); }, 100);
}

// Only the app may use the helper: it can fetch any URL, start torrents and hand out the phone link, so a web page
// opened in the TV's browser must not be able to drive it. A request is refused when it names another host (DNS
// rebinding) or comes from a page that is not the app (Origin / Referer of a real website). The app (file://,
// Origin "null"), its <video>, ffmpeg and the P2P engine send neither, and localhost (the Mac preview) is allowed.
function trustedReq(req) {
  var h = String(req.headers.host || '');
  if (h && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h)) return false;
  function ok(u) { return !u || u === 'null' || /^file:/i.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u); }
  return ok(req.headers.origin) && ok(req.headers.referer);
}
http.createServer(function (req, res) {
  if (!trustedReq(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
  var p = req.url.split('?')[0];
  var q = urlmod.parse(req.url, true).query;
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Origin, Content-Type, Accept'
    });
    res.end();
    return;
  }
  if (p === '/ping') {
    // Instant readiness probe for the app launcher — proves :8080 is bound so it can
    // redirect here instead of guessing on a timer (which races a cold node start).
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
  } else if (p === '/subs') {
    subsList(q.type || 'movie', q.vid || '', function (out) { sendJson(res, { subtitles: out }); });
  } else if (p === '/sub') {
    fetchUrl(q.u || '', function (buf) { sendJson(res, { cues: buf ? parseSrt(buf.toString('utf8')) : [] }); });
  } else if (p === '/proxy') {
    var orig = q.u || '';
    var c = resolveCache[orig];
    var start = (c && (Date.now() - c.at) < 120000) ? c.url : orig; // reuse a fresh resolved CDN url
    proxyStream(start, req.headers.range, req.method, res, orig, 0, false);
  } else if (p === '/trailer') {
    trailerRoute(q, res);
  } else if (p === '/phoneurl') {
    phoneSetStr(q); phoneOn(); var ip = lanIp();
    sendJson(res, qrBits(ip ? 'http://' + ip + ':' + PHONE_PORT + '/t/' + phoneTok : ''));
  } else if (p === '/typed') {
    sendJson(res, phoneTyped.seq > (parseInt(q.since, 10) || 0) ? phoneTyped : { seq: phoneTyped.seq });
  } else if (p === '/sug') {
    sugRoute(q, res);
  } else if (p === '/imgx') {
    imgxRoute(q, res);
  } else if (p === '/skips') {
    skipsRoute(q, res);
  } else if (p === '/embtracks') {
    embTracks(q.u || '', Math.max(0, parseFloat(q.t || '0') || 0), res, q.lazy === '1');
  } else if (p === '/embpos') {
    // the player's position while no track is chosen, so the session keeps the window ready
    var pe = q.u ? subSession(q.u, Math.max(0, parseFloat(q.t || '0') || 0), false) : null;
    if (pe && q.b != null) pe.s.setBuf(parseFloat(q.b));
    sendJson(res, {});
  } else if (p === '/embstart') {
    embStart(q, res);
  } else if (p === '/embcues') {
    embCues(q, res);
  } else if (p === '/p2p' || p === '/p2p/stream') {
    handleP2pStream(req, res, q);
  } else if (p === '/p2p/stop') {
    sendJson(res, { ok: true });
    clearP2pTorrents();
  } else if (p === '/p2p/stats') {
    handleP2pStats(res, q);
  } else if (p === '/p2p/resolve') {
    handleP2pResolve(res, q);
  } else if (p === '/log' && req.method === 'POST') {
    var body = '';
    req.on('data', function (d) { if (body.length < 65536) body += d; });
    req.on('end', function () { try { var j = JSON.parse(body); appLog(j.lines || []); } catch (e) {} sendJson(res, { ok: true }); });
  } else if (p === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(logBundle());
  } else if (p === '/logsurl') {
    phoneOn(); var lip = lanIp();
    sendJson(res, qrBits(lip ? 'http://' + lip + ':' + PHONE_PORT + '/t/' + phoneTok + '/logs' : ''));
  } else if (p === '/tmdburl') {
    phoneSetStr(q); phoneOn(); var tip = lanIp();
    sendJson(res, qrBits(tip ? 'http://' + tip + ':' + PHONE_PORT + '/t/' + phoneTok + '/tmdb' : ''));
  } else if (p === '/tmdb') {
    // the app keeps a copy (an app update replaces this folder) and hands it back when it is missing here
    if (q.clear) { try { fs.unlinkSync(TMDB_KEYF); } catch (e) {} locMem = {}; locMemN = 0; }
    if (q.put && /^[A-Za-z0-9._-]{20,400}$/.test(q.put) && !tmdbKey()) { try { fs.writeFileSync(TMDB_KEYF, q.put); locMem = {}; locMemN = 0; } catch (e) {} }
    var tk = tmdbKey(); sendJson(res, q.get ? { key: !!tk, k: tk } : { key: !!tk });
  } else if (p === '/mem') {
    sendJson(res, { free: memAvail() });
  } else if (p === '/cat') {
    catRoute(q, res);
  } else if (p === '/loc') {
    locRoute(q, res);
  } else if (p === '/locs') {
    locsRoute(q, res);
  } else if (p === '/size') {
    var su = String(q.u || ''), sc = sizeMem[su];
    if (sc != null) return sendJson(res, { bytes: sc });
    streamSize(su, function (n) { if (n) { if (++sizeMemN > 200) { sizeMem = {}; sizeMemN = 0; } sizeMem[su] = n; } sendJson(res, { bytes: n }); });
  } else if (p === '/subsync') {
    subSync(q, res);
  } else if (p === '/hb') {
    sendJson(res, { ok: true }); heartbeatIn(q);
  } else if (p === '/p2p/pace') {
    sendJson(res, { ok: true }); p2pPace(q);
  } else if (/^\/([0-9a-fA-F]{40})(?:\/(\d+))?$/.test(p)) {
    var hm = /^\/([0-9a-fA-F]{40})(?:\/(\d+))?$/.exec(p);
    q.ih = hm[1];
    q.idx = hm[2] || 0;
    handleP2pStream(req, res, q);
  } else {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
}).on('error', function (e) {
  // another helper already owns :8080 -> this one has nothing to do. Without this, the global
  // uncaughtException handler kept duplicates alive (each ~15MB of the TV's RAM).
  if (e && e.code === 'EADDRINUSE') { dbg('port ' + PORT + ' already in use - exiting'); process.exit(0); }
  dbg('server error: ' + (e && e.message));
}).listen(PORT, '127.0.0.1', function () {
  dbg('listening on :' + PORT); console.log('tvserver on :' + PORT);
  // we own :8080, so any P2P engine still running belongs to a helper that died without its
  // exit handler (killed, out of memory): stop it, or it would be adopted and never stopped
  try {
    fs.readdirSync('/proc').forEach(function (d) {
      if (!/^\d+$/.test(d) || +d === process.pid) return;
      var c = '';
      try { c = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch (e) { return; }
      if (c.indexOf('nuvio-bridge') >= 0 && c.indexOf('--port') >= 0) {
        try { process.kill(+d, 'SIGKILL'); dbg('stopped a P2P engine left by a previous helper, pid=' + d); } catch (e) {}
      }
    });
  } catch (e) {}
});
