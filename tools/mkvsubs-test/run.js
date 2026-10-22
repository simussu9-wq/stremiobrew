// Tests service/mkvsubs.js against the fixtures from make-fixtures.js, over a local HTTP
// server with Range. ES5, so it also runs on the TV's Node 0.12:
//   node tools/mkvsubs-test/make-fixtures.js /tmp/mkvfx
//   node tools/mkvsubs-test/run.js /tmp/mkvfx
'use strict';
var fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process');
var mkv = require('../../service/mkvsubs.js');
var dir = process.argv[2];
if (!dir) { console.error('usage: run.js <fixture dir>'); process.exit(2); }
var PORT = 8897, BASE = 'http://127.0.0.1:' + PORT + '/';
var PORT_LATE = 8895; // only for the transient-error step: its server starts 1 s late
var failed = 0, passed = 0;
function ok(cond, what) { if (cond) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what); } }

// expected cues from the source files
function srtCues(file) {
  var out = [], blocks = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split(/\n\n+/);
  for (var i = 0; i < blocks.length; i++) {
    var m = /(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)\n([\s\S]*)/.exec(blocks[i]);
    if (!m) continue;
    out.push({ s: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, e: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000, t: m[9].replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}
function assEvents(file) {
  var out = [], lines = fs.readFileSync(file, 'utf8').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = /^Dialogue: (\d+),(\d+):(\d+):(\d+)\.(\d+),(\d+):(\d+):(\d+)\.(\d+),([^,]*),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/.exec(lines[i]);
    if (m) out.push({ s: +m[2] * 3600 + +m[3] * 60 + +m[4] + +m[5] / 100, e: +m[6] * 3600 + +m[7] * 60 + +m[8] + +m[9] / 100, style: m[10], text: m[11] });
  }
  return out;
}
function get(p, cb) { http.get(BASE + p, function (r) { var b = ''; r.on('data', function (d) { b += d; }); r.on('end', function () { cb(b); }); }); }
// polls cond() every 50 ms; cb(elapsed ms) when it holds or after ms
function waitFor(cond, ms, cb) {
  var t0 = Date.now();
  (function poll() { if (cond() || Date.now() - t0 > ms) return cb(Date.now() - t0); setTimeout(poll, 50); })();
}
// a session is settled for track n when the track is complete, or the session fell back to ffmpeg
function settled(s, n) { var st = s.trackState(n); return st === 'complete' || st === 'fallback'; }
function byStart(a, b) { return a.s - b.s || (a.l || 0) - (b.l || 0); }
function between(cues, a, b) { return cues.filter(function (c) { return c.s >= a && c.s <= b; }); }
function matchAll(got, want, what, textOf) {
  got = got.slice().sort(byStart);
  var bad = 0, first = '';
  if (got.length !== want.length) { ok(false, what + ': ' + got.length + ' cues, expected ' + want.length); return; }
  for (var i = 0; i < want.length; i++) {
    var g = got[i], w = want[i];
    if (Math.abs(g.s - w.s) > 0.005 || Math.abs(g.e - w.e) > 0.005 || g.t !== textOf(w)) { bad++; if (!first) first = JSON.stringify(g) + ' vs ' + JSON.stringify(w); }
  }
  ok(!bad, what + ': ' + want.length + ' cues, timing within 5 ms and text identical' + (bad ? ' (' + bad + ' differ, first: ' + first + ')' : ''));
}

// the test server runs on the system Node (the TV only ever runs the client side, which may be 0.12)
var server = cp.spawn(process.env.SERVER_NODE || 'node', [path.join(__dirname, 'range-server.js'), dir, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.once('data', function () { steps.shift()(); });
function next() { var f = steps.shift(); if (f) f(); else { server.kill(); console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); } }
var size = fs.statSync(path.join(dir, 'sample.mkv')).size;
var EN = srtCues(path.join(dir, 'en.srt')), AR = srtCues(path.join(dir, 'ar.srt')), FR = assEvents(path.join(dir, 'fr.ass'));
var steps = [
  function () {
    console.log('probe');
    mkv.probe(BASE + 'sample.mkv', function (err, info) {
      ok(!err, 'head parsed (' + (err || 'Matroska') + ')');
      if (err) return next();
      var s = info.subs;
      ok(s.length === 3, '3 subtitle tracks');
      ok(s[0] && s[0].lang === 'eng' && s[0].kind === 'text' && s[0].name === 'English', 'track 0: English SubRip');
      ok(s[1] && s[1].lang === 'fre' && s[1].kind === 'ass', 'track 1: French ASS');
      ok(s[2] && s[2].lang === 'ara' && s[2].kind === 'text', 'track 2: Arabic SubRip');
      ok(info.cuesPos > size / 2, 'Cues located through the SeekHead (at the end)');
      ok(Math.abs(info.duration - 360) < 2, 'duration ' + info.duration.toFixed(1) + ' s');
      next();
    });
  },
  function () {
    console.log('full harvest, English SubRip (debrid-like)');
    get('__reset', function () {
      var s = new mkv.Session(BASE + 'sample.mkv', { t: 0 }); s.select(0);
      waitFor(function () { return settled(s, 0); }, 120000, function (ms) {
        var st = s.stats(0);
        ok(s.trackState(0) === 'complete', 'complete in ' + (ms / 1000).toFixed(1) + ' s (' + st.requests + ' requests, ' + (st.bytes / 1024).toFixed(0) + ' KB = ' + (st.bytes / size * 100).toFixed(2) + ' % of the file)');
        ok(st.firstCueMs >= 0 && st.firstCueMs < 1500, 'first cue after ' + st.firstCueMs + ' ms');
        matchAll(s.cuesFor(0), EN, 'English', function (w) { return w.t; });
        var it = s.cuesFor(0).filter(function (c) { return /italic/.test(c.t); })[0];
        ok(it && /font-style:italic/.test(it.h || ''), '<i> kept as italic HTML');
        s.stop(); next();
      });
    });
  },
  function () {
    console.log('full harvest, Arabic SubRip');
    var s = new mkv.Session(BASE + 'sample.mkv', { t: 0 }); s.select(2);
    waitFor(function () { return settled(s, 2); }, 120000, function () {
      ok(s.trackState(2) === 'complete', 'complete');
      matchAll(s.cuesFor(2), AR, 'Arabic', function (w) { return w.t; });
      s.stop(); next();
    });
  },
  function () {
    console.log('full harvest, French ASS with positioned signs');
    var s = new mkv.Session(BASE + 'sample.mkv', { t: 0 }); s.select(1);
    waitFor(function () { return settled(s, 1); }, 120000, function () {
      ok(s.trackState(1) === 'complete', 'complete');
      matchAll(s.cuesFor(1), FR, 'French ASS', function (w) {
        return w.text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n');
      });
      var sign = s.cuesFor(1).filter(function (c) { return /PANNEAU/.test(c.t); })[0];
      ok(sign && sign.an === 8 && sign.x === 25 && Math.abs(sign.y - 16.7) < 0.1, 'sign: \\pos(320,120) on 1280x720 -> x 25 %, y 16.7 %, top-centre anchor (' + JSON.stringify(sign && { an: sign.an, x: sign.x, y: sign.y }) + ')');
      ok(sign && /color:#ffff00/i.test(sign.h || ''), 'sign keeps its style colour (yellow)');
      var dlg = s.cuesFor(1).filter(function (c) { return /en italique/.test(c.t); })[0];
      ok(dlg && !dlg.an && /font-style:italic/.test(dlg.h || ''), 'dialogue: bottom default, inline {\\i1} italic');
      s.stop(); next();
    });
  },
  function () {
    console.log('P2P mode: window only, follows a seek');
    get('__reset', function () {
      var s = new mkv.Session(BASE + 'sample.mkv', { t: 100, p2p: true }); s.select(0);
      waitFor(function () { return s.cuesFor(0).length >= 40; }, 15000, function (ms) {
        var outside = s.cuesFor(0).filter(function (c) { return c.s < 100 - 8 - 3 || c.s > 100 + 120 + 1; }).length;
        ok(s.cuesFor(0).length >= 40 && !outside, 'window [92 s, 220 s] harvested in ' + (ms / 1000).toFixed(1) + ' s, nothing outside it (' + s.cuesFor(0).length + ' cues)');
        var before = s.cuesFor(0).length;
        s.setPos(300);
        waitFor(function () { return s.cuesFor(0).some(function (c) { return c.s >= 300 && c.s < 310; }); }, 5000, function (ms2) {
          ok(ms2 < 2000, 'after seeking to 300 s the lines at 300-310 s arrived in ' + ms2 + ' ms');
          setTimeout(function () {
            var far = s.cuesFor(0).filter(function (c) { return c.s < 50; }).length;
            ok(!far && s.trackState(0) !== 'complete', 'never harvests far behind or the whole track (' + (s.cuesFor(0).length - before) + ' new cues)');
            s.stop(); next();
          }, 1500);
        });
      });
    });
  },
  function () {
    console.log('slow CDN (150 ms per request)');
    var s = new mkv.Session(BASE + 'slow/sample.mkv', { t: 200 }); s.select(0);
    waitFor(function () { return s.cuesFor(0).some(function (c) { return c.s >= 200 && c.s < 205; }); }, 15000, function (ms) {
      ok(ms < 3000, 'line at the playhead after ' + ms + ' ms (head + index + block, cold)');
      s.stop(); next();
    });
  },
  function () {
    console.log('servers that cut responses short');
    var s = new mkv.Session(BASE + 'cut/sample.mkv', { t: 0 }); s.select(0);
    waitFor(function () { return settled(s, 0); }, 120000, function () {
      ok(s.trackState(0) === 'complete' && s.cuesFor(0).length === EN.length, 'still complete (' + s.cuesFor(0).length + ' cues, ' + s.trackState(0) + (s.err ? ' ' + s.err : '') + ')');
      s.stop(); next();
    });
  },
  function () {
    // nocues.mkv: same streams remuxed without any index (ffmpeg streamed output: ~38 KB
    // Clusters, and its timestamps start 21 ms later than the source)
    console.log('scan mode: file without Cues');
    var want = srtCues(path.join(dir, 'en.srt')), spots = [0, 150, 300], k = 0;
    get('__reset', function () {
      (function one() {
        if (k >= spots.length) return get('__stats', function (b) {
          var st = JSON.parse(b);
          ok(st.bytes < size * 0.25, 'three spots scanned for ' + (st.bytes / 1e6).toFixed(1) + ' MB (' + (st.bytes / size * 100).toFixed(0) + ' % of the file, never the whole file)');
          next();
        });
        var t = spots[k++], t0 = Date.now(), s = new mkv.Session(BASE + 'nocues.mkv', { t: t });
        s.select(0);
        waitFor(function () { return s.cuesFor(0).some(function (c) { return c.s >= t - 1 && c.s <= t + 4; }); }, 8000, function (ms) {
          var c = s.cuesFor(0).filter(function (x) { return x.s >= t - 1 && x.s <= t + 4; })[0];
          var w = c && want.filter(function (x) { return Math.abs(x.s + 0.021 - c.s) < 0.05; })[0];
          ok(s.state === 'harvesting' && c && w && w.t === c.t && Math.abs(w.e + 0.021 - c.e) < 0.05, 'at ' + t + ' s: line at the playhead after ' + ms + ' ms, text and timing match the source (' + (c ? JSON.stringify(c.t) : 'none') + ')');
          s.stop(); one();
        });
      })();
    });
  },
  function () {
    console.log('fallbacks');
    var s = new mkv.Session(BASE + 'norange/sample.mkv', { t: 0 }); s.select(0);
    waitFor(function () { return s.state === 'fallback'; }, 20000, function (ms) {
      ok(s.state === 'fallback' && s.err === 'norange', 'server ignoring Range -> ffmpeg fallback (' + s.err + ', ' + ms + ' ms)');
      s.stop();
      mkv.probe(BASE + 'en.srt', function (err) {
        ok(err === 'notmkv', 'not Matroska -> ffmpeg fallback (' + err + ')');
        next();
      });
    });
  },
  function () {
    console.log('instant selection: every text track is harvested before it is chosen');
    var s = new mkv.Session(BASE + 'sample.mkv', { t: 200 }); // no select
    waitFor(function () { return between(s.cuesFor(1), 195, 290).length > 0; }, 8000, function (ms) {
      ok(between(s.cuesFor(1), 195, 290).length > 0, 'French ASS has lines around 200 s before any select (' + ms + ' ms)');
      s.select(1);
      var near = between(s.cuesFor(1), 192, 210);
      ok(near.length > 0, 'right after select(1), French ASS already has a cue at 192-210 s (' + near.length + ' cues)');
      // the other tracks were never chosen; they must still have their window
      waitFor(function () { return between(s.cuesFor(0), 192, 290).length > 0 && between(s.cuesFor(2), 192, 290).length > 0; }, 8000, function (ms2) {
        ok(between(s.cuesFor(0), 192, 290).length > 0, 'English (not chosen) has lines in the window [192 s, 290 s] (' + between(s.cuesFor(0), 192, 290).length + ' cues, ' + ms2 + ' ms)');
        ok(between(s.cuesFor(2), 192, 290).length > 0, 'Arabic (not chosen) has lines in the window [192 s, 290 s] (' + between(s.cuesFor(2), 192, 290).length + ' cues, ' + ms2 + ' ms)');
        s.stop(); next();
      });
    });
  },
  function () {
    // no network: a chosen track over 20 000 lines (karaoke-heavy ASS) is windowed too, its
    // epoch changes, and a player holding the old epoch gets the kept list once, then only news
    console.log('huge chosen track: windowed, epoch bump, player resyncs once');
    var s = Object.create(mkv.Session.prototype);
    s.tracks = {}; s.byN = { 0: { num: 3 } }; s.sel = 3; s.pos = 5000; s.posAt = Date.now(); s.status = []; s.all = [];
    s.scanned = {}; s.scannedN = 0; s.seen = {}; s.hasScan = false;
    var t = s.tracks[3] = { tr: {}, cues: [], pidx: [], skey: [], q: 0, ep: 0, state: 'harvesting', total: 0, done: 0 };
    function add(st, txt) { var c = { s: st, e: st + 0.4, t: txt }; c.q = t.q++; t.cues.push(c); t.pidx.push(-1); t.skey.push(null); }
    for (var i = 0; i < 20500; i++) add(i * 0.5, 'x' + i);
    var held = s.cuesSince(0, 0, null);
    s.prune(); // playhead 5000 s: keeps [4400 s, 5900 s]
    var r = s.cuesSince(0, 20500, held.ep);
    ok(r.reset && r.ep === held.ep + 1 && r.cues.length === 3001 && r.cues[0].s >= 4400, 'pruned to the window and the epoch moved (' + r.cues.length + ' lines kept, ep ' + r.ep + ')');
    var since = 0; r.cues.forEach(function (c) { if (c.q >= since) since = c.q + 1; });
    add(5001, 'new');
    var r2 = s.cuesSince(0, since, r.ep);
    ok(!r2.reset && r2.cues.length === 1 && r2.cues[0].t === 'new', 'next poll: only the new line, no reset');
    next();
  },
  function () {
    // A long film used to keep every line of every text track: only the chosen track may keep
    // all its lines; the others keep a window around the playhead and get pruned lines back
    // when the playhead returns, without duplicates.
    console.log('long watch: tracks not chosen keep only the window around the playhead');
    var s = new mkv.Session(BASE + 'sample.mkv', { t: 0 }); s.select(0);
    function uniq(cs) { var k = {}, d = 0; cs.forEach(function (c) { var x = c.s + '|' + (c.l || 0) + '|' + c.t; if (k[x]) d++; k[x] = 1; }); return d; }
    waitFor(function () { return settled(s, 0); }, 90000, function () {
      ok(s.trackState(0) === 'complete' && s.cuesFor(0).length === EN.length, 'chosen English complete (' + s.cuesFor(0).length + '/' + EN.length + ')');
      var r0 = s.cuesSince(0, 0, null), maxQ = -1;
      r0.cues.forEach(function (c) { if (c.q > maxQ) maxQ = c.q; });
      ok(r0.reset && r0.cues.length === EN.length && maxQ === EN.length - 1, 'cuesSince with no epoch: whole list, lines numbered 0..' + maxQ);
      var r1 = s.cuesSince(0, maxQ + 1, r0.ep);
      ok(!r1.reset && r1.cues.length === 0, 'cuesSince(next, same epoch): nothing new, no reset');
      s.setPos(300); // a jump: prunes at once
      var frOld = between(s.cuesFor(1), 0, 230).length, arOld = between(s.cuesFor(2), 0, 230).length;
      ok(frOld === 0 && arOld === 0, 'after a jump to 300 s, French/Arabic keep nothing before 240 s (' + frOld + ', ' + arOld + ' left)');
      ok(s.cuesFor(0).length === EN.length, 'chosen English still keeps all its lines (' + s.cuesFor(0).length + ')');
      waitFor(function () { return between(s.cuesFor(1), 295, 340).length > 0; }, 15000, function () {
        ok(between(s.cuesFor(1), 295, 340).length > 0, 'French has lines around the new playhead');
        s.setPos(20); // back: the pruned lines come again
        var want = between(FR, 15, 100).length;
        waitFor(function () { return between(s.cuesFor(1), 15, 100).length >= want; }, 20000, function (ms) {
          var fr = s.cuesFor(1);
          ok(between(fr, 15, 100).length === want, 'back at 20 s: French lines [15 s, 100 s] fetched again (' + between(fr, 15, 100).length + '/' + want + ', ' + ms + ' ms)');
          ok(uniq(fr) === 0 && uniq(s.cuesFor(2)) === 0 && uniq(s.cuesFor(0)) === 0, 'no duplicated lines in any track');
          ok(between(fr, 250, 400).length === 0, 'and the lines around 300 s were let go (' + between(fr, 250, 400).length + ' left)');
          s.stop(); next();
        });
      });
    });
  },
  function () {
    console.log('long watch, scan mode (no index): same window, no duplicates after a seek back');
    var s = new mkv.Session(BASE + 'nocues.mkv', { t: 200 }); s.select(0);
    function uniq(cs) { var k = {}, d = 0; cs.forEach(function (c) { var x = c.s + '|' + (c.l || 0) + '|' + c.t; if (k[x]) d++; k[x] = 1; }); return d; }
    waitFor(function () { return between(s.cuesFor(1), 200, 240).length > 0; }, 20000, function () {
      ok(between(s.cuesFor(1), 200, 240).length > 0, 'French (not chosen) scanned around 200 s');
      s.setPos(20);
      ok(between(s.cuesFor(1), 180, 400).length === 0, 'jump back to 20 s: French lines around 200 s let go (window ends at 170 s)');
      waitFor(function () { return between(s.cuesFor(1), 20, 60).length > 0 && between(s.cuesFor(0), 20, 60).length > 0; }, 20000, function (ms) {
        ok(between(s.cuesFor(1), 20, 60).length > 0, 'French scanned again at 20-60 s (' + ms + ' ms)');
        s.setPos(205);
        waitFor(function () { return between(s.cuesFor(1), 205, 240).length > 0; }, 20000, function () {
          ok(uniq(s.cuesFor(0)) === 0 && uniq(s.cuesFor(1)) === 0, 'no duplicated lines after scanning the same span twice');
          s.stop(); next();
        });
      });
    });
  },
  function () {
    console.log('all tracks for the price of one (P2P window [92 s, 220 s])');
    get('__reset', function () {
      var s = new mkv.Session(BASE + 'sample.mkv', { t: 100, p2p: true });
      var last = -1, since = Date.now();
      // done when the request count has not grown for 2 s
      waitFor(function () {
        var r = s.stats().requests;
        if (r !== last) { last = r; since = Date.now(); }
        return Date.now() - since >= 2000;
      }, 30000, function (ms) {
        var st = s.stats();
        var en = between(s.cuesFor(0), 92, 220).length, fr = between(s.cuesFor(1), 92, 220).length, ar = between(s.cuesFor(2), 92, 220).length;
        var wantEn = between(EN, 92, 220).length, wantFr = between(FR, 92, 220).length, wantAr = between(AR, 92, 220).length;
        var limit = 1.5 * en + 10;
        console.log('    requests ' + st.requests + ' (stopped growing after ' + (ms / 1000).toFixed(1) + ' s); lines in window: English ' + en + ', French ' + fr + ', Arabic ' + ar + '; limit 1.5 x ' + en + ' + 10 = ' + limit);
        ok(en === wantEn && fr === wantFr && ar === wantAr, 'window [92 s, 220 s] complete for all 3 tracks (English ' + en + '/' + wantEn + ', French ' + fr + '/' + wantFr + ', Arabic ' + ar + '/' + wantAr + ')');
        ok(st.requests < limit, 'all 3 tracks for ' + st.requests + ' requests, less than 1.5 x English lines + 10 (' + limit + ')');
        s.stop(); next();
      });
    });
  },
  function () {
    console.log('two sessions at once (P2P, select(0), t 0 and 250)');
    var a = new mkv.Session(BASE + 'sample.mkv', { t: 0, p2p: true }); a.select(0);
    var b = new mkv.Session(BASE + 'sample.mkv', { t: 250, p2p: true }); b.select(0);
    waitFor(function () { return between(a.cuesFor(0), 0, 5).length > 0; }, 5000, function (msA) {
      ok(between(a.cuesFor(0), 0, 5).length > 0, 'session at 0 s has a line at 0-5 s within 5 s (' + msA + ' ms)');
      waitFor(function () { return between(b.cuesFor(0), 250, 255).length > 0; }, 5000, function (msB) {
        ok(between(b.cuesFor(0), 250, 255).length > 0, 'session at 250 s has a line at 250-255 s within 5 s (' + msB + ' ms)');
        // neither stops the other: each one's whole window arrives
        var wantA = between(EN, 0, 60).length, wantB = between(EN, 250, 300).length;
        waitFor(function () { return between(a.cuesFor(0), 0, 60).length >= wantA && between(b.cuesFor(0), 250, 300).length >= wantB; }, 20000, function () {
          var gotA = between(a.cuesFor(0), 0, 60).length, gotB = between(b.cuesFor(0), 250, 300).length;
          ok(gotA === wantA, 'session at 0 s has all its lines in [0 s, 60 s] (' + gotA + '/' + wantA + ')');
          ok(gotB === wantB, 'session at 250 s has all its lines in [250 s, 300 s] (' + gotB + '/' + wantB + ')');
          ok(a.state !== 'fallback' && b.state !== 'fallback', 'neither session fell back (' + a.state + ', ' + b.state + ')');
          a.stop(); b.stop(); next();
        });
      });
    });
  },
  function () {
    console.log('transient network error: nothing listening on ' + PORT_LATE + ' yet, server starts after 1 s');
    var t0 = Date.now(), late = null;
    var s = new mkv.Session('http://127.0.0.1:' + PORT_LATE + '/sample.mkv', { t: 0 });
    setTimeout(function () {
      late = cp.spawn(process.env.SERVER_NODE || 'node', [path.join(__dirname, 'range-server.js'), dir, String(PORT_LATE)], { stdio: ['ignore', 'pipe', 'inherit'] });
      late.stdout.once('data', function () {});
    }, 1000);
    waitFor(function () { return s.state === 'harvesting' || s.state === 'fallback'; }, 10000, function () {
      ok(s.state === 'harvesting', 'session reaches state harvesting after the server came up (' + s.state + (s.err ? ' ' + s.err : '') + ', ' + (Date.now() - t0) + ' ms)');
      waitFor(function () { return s.cuesFor(0).length > 0 || s.state === 'fallback'; }, Math.max(0, 10000 - (Date.now() - t0)), function () {
        ok(s.cuesFor(0).length > 0, 'cues within 10 s of starting (' + s.cuesFor(0).length + ' cues, ' + (Date.now() - t0) + ' ms)');
        s.stop();
        if (late) late.kill();
        next();
      });
    });
  }
];
