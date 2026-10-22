/* StremioBrew player. It plays INSIDE the app page: opening it fades the app out behind the
   title art and Back fades straight back to the exact screen, with no page load in between.
   ES5 only (the TV runs Chromium 53). Motion is opacity/transform only, so the TV keeps its
   full refresh rate.

   var player = window.StremioPlayer(api)
     api.T(text, vars)   translation        api.toast(text)        api.srv  helper base URL
     api.onCover()       the art fully covers the app: hide it (frees its GPU tiles)
     api.onUncover()     the app must be visible again (it renders behind the player)
     api.onExit(info)    playback ended {type, id, vid, t}: refresh Continue Watching etc.
     api.onNext(info)    play the next episode {type, id, vid}
     api.onSimilar(info) "watch something similar" {type, id}
     api.streams(type, vid, onPart(list, group), onDone)   the addons' streams for a video
     api.play(item, {type, id, vid, startAt})              play one of those streams
   player.prepare(o)  show the title art at once (o: type,id,vid,name,logo,bg,poster,sname,
                      season,episode,epTitle,next{vid,title,thumb},sim,videos,trailer{name,subs},
                      startAt,onCancel)
   player.start(o)    o.url (+ o.alt fallback): start playback behind the art
   player.status(t) / player.fail(t) / player.close() / player.back() / player.key(k)
   player.isOpen() / player.updateArt(o) */
(function () {
'use strict';

function svg(d) { return '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'; }
var ICON = {
  play: svg('M8 5v14l11-7z'),
  pause: svg('M6 5h4v14H6zM14 5h4v14h-4z'),
  rw: svg('M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z'),
  ff: svg('M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z'),
  eps: svg('M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z'),
  src: svg('M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z'),
  subs: svg('M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z'),
  aud: svg('M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'),
  asp: svg('M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z'),
  next: svg('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'),
  skip: svg('M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z'),
  spk: svg('M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z'),
  cc: svg('M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z')
};
// a track's language code (eng / en / en-US) as a name in the UI language
var LANGS = { en: 'English', eng: 'English', fr: 'French', fre: 'French', fra: 'French', es: 'Spanish', spa: 'Spanish', de: 'German', ger: 'German', deu: 'German',
  it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese', ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic', tr: 'Turkish', tur: 'Turkish',
  pl: 'Polish', pol: 'Polish', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', sv: 'Swedish', swe: 'Swedish', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', hi: 'Hindi', hin: 'Hindi', he: 'Hebrew', heb: 'Hebrew', el: 'Greek', gre: 'Greek', ell: 'Greek', ro: 'Romanian', rum: 'Romanian', ron: 'Romanian',
  hu: 'Hungarian', hun: 'Hungarian', cs: 'Czech', cze: 'Czech', ces: 'Czech', da: 'Danish', dan: 'Danish', fi: 'Finnish', fin: 'Finnish', no: 'Norwegian', nor: 'Norwegian', nb: 'Norwegian', nob: 'Norwegian',
  uk: 'Ukrainian', ukr: 'Ukrainian', th: 'Thai', tha: 'Thai', vi: 'Vietnamese', vie: 'Vietnamese', id: 'Indonesian', ind: 'Indonesian', fa: 'Persian', per: 'Persian', fas: 'Persian' };
var SUB_SIZES = [72, 80, 100, 120, 140, 160, 180], SUB_COLORS = ['#ffffff', '#ffe600', '#00e5ff'], SUB_COLOR_NAMES = ['White', 'Yellow', 'Cyan'];
var SUB_BGS = ['0', '1', '.6'], SUB_BG_NAMES = ['None', 'Solid', 'Transparent'];
var ASPECTS = [['fit', 'Original'], ['fill', 'Fill the screen'], ['zoom', 'Zoom']];
// one canonical code per language, whatever the source uses (639-2 B/T, 639-1, BCP-47)
var LANG_ALIAS = { en: 'eng', ar: 'ara', fr: 'fre', fra: 'fre', es: 'spa', spl: 'spa', de: 'ger', deu: 'ger', it: 'ita', pt: 'por', pob: 'por', ru: 'rus', tr: 'tur', pl: 'pol', nl: 'dut', nld: 'dut',
  sv: 'swe', he: 'heb', iw: 'heb', hi: 'hin', ja: 'jpn', ko: 'kor', zh: 'chi', zho: 'chi', ro: 'rum', ron: 'rum', el: 'gre', ell: 'gre', cs: 'cze', ces: 'cze', fa: 'per', fas: 'per',
  da: 'dan', fi: 'fin', no: 'nor', nb: 'nor', nob: 'nor', hu: 'hun', bg: 'bul', uk: 'ukr', sr: 'srp', hr: 'hrv', sk: 'slo', slk: 'slo', sl: 'slv', id: 'ind', ms: 'may', msa: 'may', th: 'tha', vi: 'vie' };
function langCanon(l) { l = String(l || '').toLowerCase().split(/[-_]/)[0]; return LANG_ALIAS[l] || l; }
function langMatch(l, want) { return !!l && !!want && langCanon(l) === langCanon(want); }
function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsPut(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(s) { s = Math.max(0, s | 0); var h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60; return (h ? h + ':' + pad(m) : m) + ':' + pad(x); }
function clockOf(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function raf(f) { (window.requestAnimationFrame || function (g) { setTimeout(g, 16); })(f); }
function xhr(u, cb, tmo) {
  var done = false;
  function fin(j) { if (!done) { done = true; if (cb) cb(j); } }
  try {
    var x = new XMLHttpRequest(); x.open('GET', u, true);
    x.onreadystatechange = function () { if (x.readyState === 4) { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} fin(j); } };
    x.send();
    setTimeout(function () { if (!done) { try { x.abort(); } catch (e) {} fin(null); } }, tmo || 15000);
  } catch (e) { fin(null); }
}
function xpost(u, body) { try { var x = new XMLHttpRequest(); x.open('POST', u, true); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(body)); } catch (e) {} }
// resolution + audio codec, read instantly from the stream's own text (name, description,
// file name): no probing of the file. The picture size is corrected from the video itself.
function resOf(label) {
  var s = String(label || '').toLowerCase();
  if (/2160p|\b4k\b|\buhd\b/.test(s)) return '4K'; if (/1440p|\b2k\b/.test(s)) return '1440p'; if (/1080p|\bfhd\b/.test(s)) return '1080p';
  if (/720p/.test(s)) return '720p'; if (/576p|480p|\bsd\b/.test(s)) return 'SD'; return '';
}
function resOfVideo(w, h) { // by width: a scope film is 1920x800 and still 1080p
  if (!w || !h) return ''; if (w >= 3200 || h >= 1800) return '4K'; if (w >= 2400 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 950) return '1080p'; if (w >= 1150 || h >= 650) return '720p'; return 'SD';
}
function hdrOf(label) {
  var s = String(label || '').toLowerCase().replace(/[._]/g, ' '), dv = /\b(dv|dovi|dolby ?vision)\b/.test(s), out = [];
  if (dv) out.push('DV');
  if (/hdr10 ?(\+|plus)|hdr10p\b/.test(s)) out.push('HDR10+'); else if (/\bhdr10\b/.test(s)) out.push('HDR10'); else if (/\bhdr\b/.test(s) && !dv) out.push('HDR'); else if (/\bhlg\b/.test(s)) out.push('HLG');
  return out.join(' · ');
}
function audioOf(label) {
  var s = String(label || '').toLowerCase().replace(/[._]/g, ' '), au = '', ch = '';
  if (/truehd/.test(s)) au = 'TrueHD'; else if (/dts ?-?x\b/.test(s)) au = 'DTS:X'; else if (/dts ?-?hd ?-?ma|dts ?-?ma\b/.test(s)) au = 'DTS-HD MA';
  else if (/dts ?-?hd/.test(s)) au = 'DTS-HD'; else if (/\bdts\b/.test(s)) au = 'DTS';
  else if (/\bddp|dd\+|e-?ac-?3|eac3|dolby digital plus/.test(s)) au = 'EAC3'; else if (/\bdd\b|\bdd ?[257] ?[01]\b|\bac-?3\b|dolby digital/.test(s)) au = 'AC3';
  else if (/\baac\b|aac ?[257] ?[01]|aac2/.test(s)) au = 'AAC'; else if (/\bopus\b/.test(s)) au = 'Opus'; else if (/\bflac\b/.test(s)) au = 'FLAC'; else if (/\bmp3\b/.test(s)) au = 'MP3';
  if (au && /atmos/.test(s)) au += ' Atmos'; else if (!au && /atmos/.test(s)) au = 'Atmos';
  var m = /(?:^|[^\d.])([1-9])[ .]([01])(?!\d)/.exec(s); if (au && m && +m[1] <= 9) ch = m[1] + '.' + m[2];
  return au + (ch ? ' ' + ch : '');
}
// episode stills at tray size: TMDB and metahub (which redirects to TMDB) both serve w300
function still(u) { return String(u || '').replace(/(image\.tmdb\.org\/t\/p\/)(original|w\d+)\//, '$1w300/').replace(/(episodes\.metahub\.space\/.+\/)w\d+(\.jpg)$/, '$1w300$2'); }
function dateOf(s) { var d = s ? new Date(s) : null; if (!d || isNaN(d.getTime())) return ''; return d.getUTCDate() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }

window.StremioPlayer = function (api) {
  var T = api.T, SRV = api.srv;
  var root = null, E = {}, S = null, isOpen = false, clockT = null;

  // ---------------------------------------------------------------- DOM (built once)
  function build() {
    if (root) return;
    root = document.createElement('div'); root.id = 'plr'; root.setAttribute('dir', 'ltr');
    root.innerHTML =
      '<div id="pSub"></div><div id="pSubP"></div><canvas id="pVig" width="384" height="216"></canvas><canvas id="pDim" width="8" height="256"></canvas><canvas id="pDimT" width="8" height="128"></canvas>' +
      '<div id="pBuf"><div class="ring"></div><div class="stx"></div></div>' +
      '<div id="pSeek"></div>' +
      '<div id="pP2p"><i></i><span></span></div>' +
      '<div id="pTopR"><div id="pClock"><span class="now"></span><span class="end"></span></div></div>' +
      '<div id="pBot"><div class="ttl"><div class="pz"></div><div class="lg"></div><div class="se"></div><div class="inf"></div><div class="mt"></div></div>' +
        '<div class="bar"><span class="cur">0:00</span><div class="trk"><div class="bfd"></div><div class="fil"></div><div class="mks"></div><div class="knb"></div><div class="hv"><span></span></div></div><span class="rem"></span></div>' +
        '<div class="btns"><div id="pFoc"><i class="a"></i><i class="m"></i><i class="c"></i></div><div id="pTip"></div><div class="l"></div><div class="r"></div></div></div>' +
      '<div id="pPrompt"></div>' +
      '<div id="pTray" class="isl"><div class="hd"></div><div class="lst"><div class="in"></div></div></div>' +
      '<div id="pArt"><canvas class="cv" width="1280" height="720"></canvas><div class="bg"></div><div class="sh"></div><div class="c"><div class="lg"></div><div class="tag"></div><div class="ln"><i></i></div><div class="stx"></div></div></div>';
    document.body.appendChild(root);
    function q(sel) { return root.querySelector(sel); }
    E.sub = q('#pSub'); E.subP = q('#pSubP');
    // the shades are tiny canvases the GPU stretches: no full-screen tiles to raster or keep in memory
    (function () {
      function vgrad(c, stops) { var x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, c.height); for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], 'rgba(0,0,0,' + stops[i][1] + ')'); x.fillStyle = g; x.fillRect(0, 0, c.width, c.height); }
      vgrad(q('#pDim'), [[0, 0], [0.54, 0.55], [1, 0.88]]);
      vgrad(q('#pDimT'), [[0, 0.55], [1, 0]]);
      var v = q('#pVig'), x = v.getContext('2d'), W = v.width, H = v.height;
      x.save(); x.translate(W * 0.6, H * 0.4); x.scale(1, (H * 1.0) / (W * 1.2)); var rg = x.createRadialGradient(0, 0, 0, 0, 0, W * 1.2 * 0.62);
      rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.45, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,.6)'); x.fillStyle = rg; x.fillRect(-W, -H * 3, W * 3, H * 6); x.restore();
      var lg = x.createLinearGradient(0, 0, W, 0); lg.addColorStop(0, 'rgba(0,0,0,.42)'); lg.addColorStop(0.55, 'rgba(0,0,0,0)'); x.fillStyle = lg; x.fillRect(0, 0, W, H);
    })();
    E.buf = q('#pBuf'); E.bufSt = q('#pBuf .stx'); E.seek = q('#pSeek');
    E.cNow = q('#pClock .now'); E.cEnd = q('#pClock .end');
    E.tLg = q('#pBot .ttl .lg'); E.tSe = q('#pBot .ttl .se');
    E.cur = q('#pBot .cur'); E.rem = q('#pBot .rem'); E.p2p = q('#pP2p span'); E.inf = q('#pBot .ttl .inf'); E.mt = q('#pBot .ttl .mt'); E.mks = q('#pBot .mks'); E.pz = q('#pBot .pz'); E.trk = q('#pBot .trk'); E.hv = q('#pBot .trk .hv'); E.bfd = q('#pBot .bfd'); E.fil = q('#pBot .fil'); E.knb = q('#pBot .knb');
    E.foc = q('#pFoc'); E.focM = q('#pFoc .m'); E.focC = q('#pFoc .c'); E.tip = q('#pTip'); E.bl = q('#pBot .btns .l'); E.br = q('#pBot .btns .r');
    E.prompt = q('#pPrompt');
    E.tray = q('#pTray'); E.hd = q('#pTray .hd'); E.lst = q('#pTray .lst'); E.lin = q('#pTray .in');
    E.art = q('#pArt'); E.aCv = q('#pArt .cv'); E.aBg = q('#pArt .bg'); E.aLg = q('#pArt .lg'); E.aTag = q('#pArt .tag'); E.aSt = q('#pArt .stx');
  }
  function cls(c, on) { if (on) root.classList.add(c); else root.classList.remove(c); }

  // ---------------------------------------------------------------- open / close
  function newState(o) {
    return { o: o, v: null, mode: 'video', row: 'btns', bIdx: 0, btns: [], live: false, failed: false, closing: false,
      seekT: -1, seekTimer: null, seekHide: null, rep: 0, lastKey: 0, seekDir: 0, hideT: null, timers: [], ivs: [],
      extSubs: [], cues: null, curSub: 'off', subDelay: 0, embTracks: null, embLoading: true, embErr: '', embN: -1,
      embQ: 0, embEp: 0, embDone: false, embFails: 0, embPolling: false, fastN: 0, autoSubDone: false, embWaitOver: false, embWaitT: null,
      curAud: -1, autoAudDone: false, didResume: false, lastPush: 0, tray: null, paced: false, alt: '', altTried: false,
      seekFix: false, lastSeekT: -1, helperAt: 0, skips: null, prompt: null, promptIdx: 0, dismissed: {}, aspect: (function (a) { return a === 'stretch' ? 'fit' : a; })(lsGet('aspectMode', 'fit')) };
  }
  function later(f, ms) { var st = S, id = setTimeout(function () { if (S === st) f(); }, ms); st.timers.push(id); return id; }
  function every(f, ms) { var st = S, id = setInterval(function () { if (S === st) f(); }, ms); st.ivs.push(id); return id; }

  function prepare(o) {
    build();
    var again = isOpen && S; // another source / episode from inside the player: crossfade to the art
    // another source of the same episode: its OpenSubtitles list is the same, keep it (the tray is never empty)
    var keepSubs = again && S.extSubs && S.extSubs.length && S.o && S.o.id === o.id && (S.vidId || S.o.vid) === (o.vid || o.id) ? S.extSubs : null;
    if (again) { teardown(S); cls('osd', false); cls('tr', false); cls('trp', false); cls('p2p', false); cls('paused', false); cls('skm', false); }
    S = newState(o); isOpen = true;
    if (keepSubs) S.extSubs = keepSubs;
    E.aSt.textContent = ''; E.art.className = '';
    paintArt(o);
    if (again) { E.art.style.display = ''; raf(function () { cls('live', false); }); }
    else {
      root.className = ''; root.style.display = 'block'; E.art.style.display = '';
      raf(function () { raf(function () { if (isOpen) cls('in', true); }); });
      later(function () { if (api.onCover) api.onCover(); }, 260); // the art covers the app now: let it rest
    }
    if (!clockT) clockT = setInterval(paintClock, 15000);
    if (!hbT) { hbT = setInterval(heartbeat, 20000); heartbeat(); }
    paintClock();
  }
  function updateArt(o) { if (!S) return; for (var k in o) if (o[k] != null && o[k] !== '') S.o[k] = o[k]; paintArt(S.o); }
  // The logo is decoded OFF the page thread (XHR blob + createImageBitmap, once per title) and drawn into
  // a canvas at its display size: as a plain <img> its 780x505 PNG was decoded during raster and held the
  // player's first commit (~77 ms of a 227 ms block on the TV). A plain <img> stays the last resort.
  var logoSrc = { u: '', c: null };
  function logoInto(host, o, cb, mw, mh) { // the title's logo (text art); its name only when there is none
    var st = S, shown = false;
    host.innerHTML = '';
    function text() { if (shown || S !== st) return; shown = true; host.innerHTML = '<div class="nm">' + esc(o.dname || o.name || '') + '</div>'; if (cb) cb(); }
    function put(src, w, h) {
      if (S !== st) return;
      var k = Math.min(mw / w, mh / h, 1), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); } catch (e) { return viaImg(); }
      host.innerHTML = ''; host.appendChild(c); shown = true; if (cb) cb();
    }
    function viaImg() {
      var im = new Image();
      im.onload = function () { if (S !== st) return; host.innerHTML = ''; host.appendChild(im); shown = true; if (cb) cb(); };
      im.onerror = text; im.src = o.logo;
    }
    function get(u, fail) {
      var x = new XMLHttpRequest(); try { x.open('GET', u, true); x.responseType = 'blob'; } catch (e) { return fail(); }
      x.onload = function () { if (x.status !== 200 || !x.response || x.response.size < 100) return fail();
        createImageBitmap(x.response).then(function (b) {
          // kept as a canvas (largest size used) so the bar's smaller copy needs no second decode
          var k = Math.min(760 / b.width, 260 / b.height, 1), c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(b.width * k)); c.height = Math.max(1, Math.round(b.height * k));
          try { c.getContext('2d').drawImage(b, 0, 0, c.width, c.height); } catch (e) { c = null; }
          try { if (b.close) b.close(); } catch (e) {}
          if (!c) return fail();
          logoSrc = { u: o.logo, c: c }; put(c, c.width, c.height);
        }, fail); };
      x.onerror = fail; x.timeout = 8000; x.ontimeout = fail; x.send();
    }
    if (o.logo) {
      if (logoSrc.u === o.logo && logoSrc.c) put(logoSrc.c, logoSrc.c.width, logoSrc.c.height);
      else if (!window.createImageBitmap) viaImg();
      else get(o.logo, function () { // no CORS header on that copy: through the helper, which adds it
        if (/^https:\/\/(images\.metahub\.space|episodes\.metahub\.space|image\.tmdb\.org|m\.media-amazon\.com)\//.test(o.logo)) get(api.srv + '/imgx?u=' + encodeURIComponent(o.logo), viaImg); else viaImg(); });
      setTimeout(text, 600);
    } else text();
  }
  function paintArt(o) {
    // the title page's own backdrop canvas is copied (a GPU copy, instant): decoding the picture again
    // showed black for a moment before the art came back. o.bg stays the real URL (saved to the library)
    var cv = E.aCv;
    if (o.artCv && o.artCv.width > 1) {
      try { if (cv.width !== o.artCv.width) cv.width = o.artCv.width; if (cv.height !== o.artCv.height) cv.height = o.artCv.height; cv.getContext('2d').drawImage(o.artCv, 0, 0); cv._src = o.bg || ''; cv.style.display = 'block'; E.aBg.style.backgroundImage = ''; } catch (e) { cv.style.display = 'none'; }
      o.artCv = null; // never keep a reference to the page's canvas
    } else if (o.bg && cv._src === o.bg && cv.style.display === 'block') { /* same art: keep it */ }
    else { cv.style.display = 'none'; cv._src = ''; E.aBg.style.backgroundImage = o.bg ? 'url("' + String(o.bg).replace(/"/g, '%22') + '")' : ''; }
    logoInto(E.aLg, o, null, 760, 260);
    E.aTag.innerHTML = o.trailer ? '<i></i><span>' + esc(o.trailer.name || T('Trailer')) + '</span><i></i>' : '';
  }
  function setStatus(t) { if (E.aSt) E.aSt.textContent = t || ''; }
  function fail(t) {
    try { if (window.sbLog) window.sbLog('[player] ' + t + ' | ' + (S && S.o ? S.o.type + ' ' + S.o.id + (S.vidId ? ' ' + S.vidId : '') + ' ' + (S.o.sname || '').slice(0, 80) : '')); } catch (e) {}
    if (!S) return;
    S.failed = true; killVideo(S);
    E.art.style.display = ''; cls('live', false); E.art.className = 'err';
    setStatus((t || T('Playback error')) + '  ·  ' + T('Press Back to close'));
  }

  function start(o2) {
    if (!S || S.closing) return;
    var st = S, o = st.o, k;
    st.started = true;
    for (k in o2) if (o2[k] != null) o[k] = o2[k];
    if (o2.logo || o2.bg || o2.name) paintArt(o);
    st.alt = o.alt || '';
    st.isTrailer = o.type === 'other' || !!o.trailer;
    st.isHls = String(o.url).indexOf('.m3u8') >= 0;
    st.seekFix = st.isTrailer && !st.isHls; // webOS restarts these files from 0 after a seek: reload-at-position instead
    st.p2pIh = (function () { var m = /127\.0\.0\.1:3030\/torrents\/([0-9a-fA-F]{40})\//.exec(o.url) || /\/p2p\?(?:.*&)?ih=([0-9a-fA-F]{40})/.exec(o.url); return m ? m[1].toLowerCase() : ''; })();
    st.isP2p = !!st.p2pIh || /127\.0\.0\.1:(3030|8080\/p2p)/.test(o.url);
    st.vidId = (o.vid && o.vid !== 'null' && o.vid !== 'undefined') ? o.vid : o.id;
    st.libKey = libPrefix() + o.id;
    if (api.beforeVideo) api.beforeVideo(); // one hardware decoder: any background trailer is fully released first
    var v = document.createElement('video'); v.id = 'pVid'; v.autoplay = true;
    root.insertBefore(v, root.firstChild); st.v = v;
    wireVideo(st, v);
    paintTitle(); buildBtns(); applyAspect();
    // a series whose episode list / next episode wasn't known yet: ask again (now and in 20 s) and add
    // the Next episode button + the Episodes tray as soon as they are there
    if (o.type === 'series' && !st.isTrailer && (!o.next || !o.videos) && api.opts) {
      var fill = function () { api.opts(o.type, o.id, st.vidId, function (o3) {
        if (S !== st || !o3) return; var ch = false;
        if (o3.videos && !o.videos) { o.videos = o3.videos; ch = true; }
        if (o3.next && !o.next) { o.next = o3.next; ch = true; }
        if (o3.epTitle && !o.epTitle) { o.epTitle = o3.epTitle; paintTitle(); }
        if (ch) { var fid = st.btns[st.bIdx] && st.btns[st.bIdx].id; buildBtns(); for (var q = 0; q < st.btns.length; q++) if (st.btns[q].id === fid) st.bIdx = q; paintBtns(); }
      }); };
      fill(); later(function () { if (!o.next || !o.videos) fill(); }, 20000);
    }
    st.res = resOf(o.sname); paintInfo();
    v.src = o.url;
    // remember exactly what we played: Continue Watching resumes it directly
    if (o.id && !st.isTrailer) lsPut('tvstream_' + o.id + '_' + st.vidId, '?u=' + encodeURIComponent(o.url) + '&type=' + encodeURIComponent(o.type) + '&id=' + encodeURIComponent(o.id) +
      '&vid=' + encodeURIComponent(st.vidId) + (o.sname ? '&name=' + encodeURIComponent(o.sname) : '') + (o.saddon ? '&addon=' + encodeURIComponent(o.saddon) : '') + (o.alt ? '&u2=' + encodeURIComponent(o.alt) : ''));
    if (st.isTrailer) {
      st.embLoading = false; st.embTracks = [];
      var ts = (o.trailer && o.trailer.subs) || [];
      st.extSubs = ts.map(function (s, i) { return { name: s.name || 'English', lang: (s.lang || 'eng').toLowerCase(), u: s.url || s.u, n: i + 1 }; });
      if (st.extSubs.length) autoSub();
    } else {
      loadExtSubs(0);
      if (st.isP2p) { var ed = false; v.addEventListener('playing', function () { if (!ed) { ed = true; later(function () { loadEmbTracks(0); }, 1000); } }); }
      else loadEmbTracks(0);
    }
    if (st.p2pIh) p2pTick();
    every(function () { if (st.v && !st.v.paused) { saveProgress(); pushLib(false); if (st.v.duration && st.v.currentTime / st.v.duration > 0.95) markWatched(); } }, 10000);
    every(function () { if (st.v && !st.v.paused && st.embN < 0 && st.embTracks && st.embTracks.length) embPos(); }, 8000);
    every(function () { if (st.embN >= 0) pollEmb(); }, 4000);
  }

  function wireVideo(st, v) {
    function on(ev, f) { v.addEventListener(ev, function (e) { if (S === st && st.v === v) f(e); }); }
    on('playing', function () {
      if (!st.live) { st.live = true; cls('live', true); later(function () { if (st.live) E.art.style.display = 'none'; }, 500); }
      hideBuf(); cls('paused', false); if (!st.hiccup) st.hiccup = Date.now();
    });
    on('loadedmetadata', function () { applyAspect(); loadSkips(); paintMarks(); if (!st.isTrailer) { var r = resOfVideo(v.videoWidth, v.videoHeight); if (r) st.res = r; paintInfo(); } });
    on('loadeddata', tryResume); on('canplay', tryResume);
    on('loadeddata', autoAudio); on('canplay', autoAudio);
    on('canplay', hideBuf); on('seeked', function () { hideBuf(); embPos(); seekBurst(); });
    on('waiting', showBuf); on('stalled', showBuf);
    on('waiting', function () { st.hiccup = Date.now(); }); on('seeking', function () { st.hiccup = Date.now(); }); // P2P: full speed until 15 s of smooth play
    on('playing', function () { if (st.aspect !== 'fit') applyAspect(); }); on('seeked', function () { if (st.aspect !== 'fit') applyAspect(); });
    on('play', function () { paintPP(); cls('paused', false); clearTimeout(st.pauseT); armHide(); });
    on('pause', function () {
      paintPP(); hideBuf(); saveProgress(); pushLib(true);
      clearTimeout(st.pauseT); st.pauseT = later(function () { if (v.paused && st.live && st.mode !== 'tray') { cls('paused', true); showOsd(true); } }, 350);
    });
    on('timeupdate', function () { if (st.seekT < 0) paintBar(); renderSub(); checkPrompt(); if (st.seekT < 0 && !v.paused) hideBuf(); });
    on('ended', function () {
      saveProgress(); pushLib(true); markWatched();
      var binge = lsGet('bingeWatch', 'true') !== 'false' && lsGet('enableNextVideo', 'true') !== 'false';
      if (binge && st.o.next) later(goNext, 600);
    });
    on('error', function () {
      if (st.alt && !st.altTried) { st.altTried = true; v.src = st.alt; try { v.play(); } catch (e) {} return; } // the direct URL failed: same file via the helper
      fail(T('Playback error'));
    });
  }

  function close(opts) {
    if (!isOpen || !S || S.closing) return;
    var st = S; st.closing = true; opts = opts || {};
    try { saveProgress(); pushLib(true); } catch (e) {}
    if (!st.started && st.o.onCancel) st.o.onCancel(); // Back while the stream was still being resolved
    if (st.isP2p || st.p2pIh || /\/p2p\?/.test(st.alt)) xhr(SRV + '/p2p/stop');
    try { if (st.v) st.v.pause(); } catch (e) {}
    var info = { type: st.o.type, id: st.o.id, vid: st.vidId, t: st.v ? st.v.currentTime : 0 };
    if (opts.go) opts.go(); // the screen to land on is set up behind the player first
    // Back to the app: the app was hidden while the film played (its tiles freed) and needs time to draw
    // itself again - a fixed 340 ms often wasn't enough (blank / half-drawn screen, no real fade). So:
    // 1) the title's own picture (the cover, no logo / loading line) fades back over the paused frame,
    // 2) under it the video is released and the app is shown and drawn,
    // 3) once the page has settled, the cover fades away onto it.
    cls('osd', false); cls('tr', false); cls('trp', false); cls('paused', false); cls('skm', false); cls('p2p', false);
    E.art.style.display = ''; cls('exit', true);
    // each step starts from the one before (never a parallel timer: on a busy frame the video went before
    // the cover was up)
    raf(function () { raf(function () {
      cls('live', false); // the cover fades in (0.2 s)
      setTimeout(function () {
        killVideo(st);
        if (api.onUncover) api.onUncover();
        if (api.onExit) api.onExit(info);
        appDrawn(function () {
          cls('in', false);
          setTimeout(function () { if (S === st) { teardown(st); S = null; isOpen = false; root.style.display = 'none'; root.className = ''; } }, 380);
        });
      }, 240);
    }); });
  }
  // the page behind has done its work: two frames, then the main thread going idle (style, layout, paint
  // and the screen's own setup are over), plus a little for the raster threads; 1.2 s at most
  function appDrawn(cb) {
    var done = false; function go() { if (done) return; done = true; setTimeout(cb, 180); }
    raf(function () { raf(function () {
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 900 }); else setTimeout(go, 450);
    }); });
    setTimeout(go, 1200);
  }
  function teardown(st) {
    var i;
    for (i = 0; i < st.timers.length; i++) clearTimeout(st.timers[i]);
    for (i = 0; i < st.ivs.length; i++) clearInterval(st.ivs[i]);
    clearTimeout(st.seekTimer); clearTimeout(st.hideT); clearTimeout(st.seekHide); clearTimeout(st.pauseT); clearTimeout(st.embWaitT);
    st.tok = -1; killVideo(st);
    E.sub.innerHTML = ''; E.subP.innerHTML = ''; E.lin.innerHTML = ''; E.hd.innerHTML = ''; E.lin._h = E.hd._h = null; E.prompt.innerHTML = ''; E.prompt.className = '';
    if (!isOpen && clockT) { clearInterval(clockT); clockT = null; }
  }
  function killVideo(st) {
    var v = st.v; if (!v) return; st.v = null;
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); v.load(); } catch (e) {} // releases the TV's decoder now, not at GC time
    if (v.parentNode) v.parentNode.removeChild(v);
  }

  // ---------------------------------------------------------------- OSD
  // Netflix-style: the title's text art bottom-left, "S1:E1  Name" under it for an episode
  function paintTitle() {
    var o = S.o; logoInto(E.tLg, o, null, 560, 170); E.pz.textContent = T('Paused');
    if (S.isTrailer) E.tSe.innerHTML = '<span class="tg">' + esc((o.trailer && o.trailer.name) || T('Trailer')) + '</span>';
    else if (o.season && o.episode) E.tSe.innerHTML = '<b dir="ltr">S' + esc(o.season) + ':E' + esc(o.episode) + '</b>' + (o.epTitle ? '<i></i><span>' + esc(o.epTitle) + '</span>' : '');
    else E.tSe.innerHTML = '';
  }
  // Under the title, grouped like a streaming app: [resolution] [HDR · audio format] | [audio
  // language + channels] [subtitles: language · in the file / external]; then year · genre · via addon.
  // the info chips come in one after another, lightly (rise + fade; two names alternate to replay)
  function infIn() { E.inf._ab = !E.inf._ab; E.inf.className = 'inf ' + (E.inf._ab ? 'ia' : 'ib'); }
  function fmtSize(b) { return b >= 1e9 ? T('{n} GB', { n: (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) }) : T('{n} MB', { n: Math.round(b / 1e6) }); }
  function paintInfo() {
    var st = S; if (!st || !E.inf) return;
    var o = st.o, lab = o.sname || '';
    function langName(c) { var n = LANGS[String(c || '').toLowerCase().split(/[-_]/)[0]]; return n ? T(n) : ''; }
    if (st.isTrailer) { E.inf.innerHTML = ''; E.inf._h = ''; E.mt.innerHTML = ''; return; }
    function chip(ic, t, c) { return t ? '<span class="ch' + (c ? ' ' + c : '') + '">' + (ic || '') + esc(t) + '</span>' : ''; }
    var hdr = hdrOf(lab), au = audioOf(lab), codec = au.replace(/ [0-9]\.[0-9]$/, ''), chs = (/ ([0-9]\.[0-9])$/.exec(au) || [])[1] || '';
    var fmt = [hdr ? hdr.replace(/^DV/, 'Dolby Vision') : '', codec].filter(function (x) { return !!x; }).join('  ·  ');
    if (st.size == null && !st.isHls && o.url) { st.size = 0; xhr(SRV + '/size?u=' + encodeURIComponent(o.url), function (j) { if (S !== st || !j || !j.bytes) return; st.size = j.bytes; paintInfo(); }, 12000); } // asked once per stream
    var g1 = chip('', st.res, 'rs') + chip('', fmt, 'fx') + chip('', st.size ? fmtSize(st.size) : '', 'sz');
    var aLang = '';
    try { var ts = st.v && st.v.audioTracks, sel = st.curAud; if (ts && ts.length) { if (sel < 0) for (var i = 0; i < ts.length; i++) if (ts[i].enabled) { sel = i; break; } var tr = ts[sel < 0 ? 0 : sel]; aLang = langName(tr.language) || tr.label || ''; } } catch (e) {}
    var aud = [aLang, chs].filter(function (x) { return !!x; }).join(' ');
    var sub = '';
    if (st.curSub.indexOf('emb:') === 0) { var n = st.embN, et = null; for (var k = 0; st.embTracks && k < st.embTracks.length; k++) if (st.embTracks[k].n === n) et = st.embTracks[k]; sub = (et ? (langName(et.lang) || et.name || '') : '') + '  ·  ' + T('In the file'); }
    else if (st.curSub.indexOf('ext:') === 0) { var u = st.curSub.slice(4), ex = null; for (var m = 0; m < st.extSubs.length; m++) if (st.extSubs[m].u === u) ex = st.extSubs[m]; sub = (ex ? (langName(ex.lang) || ex.name) : '') + '  ·  ' + T('External'); }
    var g2 = chip(ICON.spk, aud) + chip(ICON.cc, sub);
    var ih = g1 + (g1 && g2 ? '<i class="sep"></i>' : '') + g2;
    if (E.inf._h !== ih) { E.inf._h = ih; E.inf.innerHTML = ih; infIn(); } // changed: the chips come in again
    var via = String(o.saddon || '').replace(/^[^A-Za-z0-9]+/, '');
    E.mt.innerHTML = [o.year, o.genre ? T(o.genre) : '', via ? T('via {a}', { a: via }) : ''].filter(function (x) { return !!x; }).map(esc).join('<b>•</b>');
  }
  // flight recorder for the rare crash while paused: a tiny state note to the helper every 20 s; when
  // they stop without a close, the helper logs the last ones (with the TV's free memory at the time)
  var hbT = null;
  function heartbeat() {
    var st = S;
    if (!isOpen || !st) { xhr(SRV + '/hb?s=closed'); clearInterval(hbT); hbT = null; return; }
    var v = st.v, mem = 0, nodes = 0;
    try { if (performance.memory) mem = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
    try { nodes = document.getElementsByTagName('*').length; } catch (e) {}
    xhr(SRV + '/hb?s=' + (v ? (v.paused ? 'paused' : 'playing') : 'loading') + '&t=' + (v ? Math.round(v.currentTime) : 0) +
      '&sub=' + encodeURIComponent(st.curSub || '') + '&cues=' + (st.cues ? st.cues.length : 0) + '&heap=' + mem + '&dom=' + nodes +
      '&mode=' + (st.mode || '') + '&p2p=' + (st.isP2p ? 1 : 0));
  }
  function paintClock() {
    if (!E.cNow) return;
    var d = new Date(), tx = clockOf(d); if (E.cNow.textContent !== tx) { var first = !E.cNow.textContent; E.cNow.textContent = tx; if (!first) E.cNow.className = 'now ' + (E.cNow.className === 'now ck-a' ? 'ck-b' : 'ck-a'); } // a new minute: a small nudge
    var v = S && S.v, end = '';
    if (v && v.duration && v.duration !== Infinity) end = T('Ends at {t}', { t: clockOf(new Date(d.getTime() + (v.duration - v.currentTime) * 1000)) });
    E.cEnd.textContent = end;
  }
  var LW = {}; // button label -> measured width (px)
  function buildBtns() {
    var st = S, l = [], r = [];
    l.push({ id: 'pp', h: ICON.pause, c: 'rb big' });
    l[0].lb = ''; if (!st.isTrailer && st.o.next) l.push({ id: 'nxt', h: ICON.next, c: 'ic nx', lb: T('Next episode') });
    function ic(id, icon, label) { r.push({ id: id, h: icon, c: 'ic', lb: label }); }
    if (!st.isTrailer && st.o.type === 'series' && st.o.videos && st.o.videos.length) ic('eps', ICON.eps, T('Episodes'));
    if (!st.isTrailer && api.streams) ic('src', ICON.src, T('Sources'));
    ic('subs', ICON.subs, T('Subtitles'));
    if (!st.isTrailer) ic('aud', ICON.aud, T('Audio'));
    var am = 'Fit'; for (var ai = 0; ai < ASPECTS.length; ai++) if (ASPECTS[ai][0] === st.aspect) am = ASPECTS[ai][1];
    ic('asp', ICON.asp, T(am));
    function mk(list, host) { host.innerHTML = ''; for (var i = 0; i < list.length; i++) { var d = document.createElement('div'); d.className = 'pb ' + list[i].c; d.innerHTML = list[i].h; d._base = d.className; host.appendChild(d); list[i].el = d; } }
    mk(l, E.bl); mk(r, E.br);
    st.btns = l.concat(r); st.bIdx = 0; st.nL = l.length;
    // label widths: all measured in ONE layout (copies of the tip side by side) and kept - reading the tip's
    // width once per label forced a layout each time (~28 ms of every player start on the TV)
    var need = [];
    for (var mi = 0; mi < st.btns.length; mi++) { var mb = st.btns[mi]; if (mb.lb && !(mb.lb in LW)) need.push(mb.lb); }
    if (need.length) {
      var cl = [], par = E.tip.parentNode;
      for (var ni = 0; ni < need.length; ni++) { var t2 = E.tip.cloneNode(false); t2.className = ''; t2.style.visibility = 'hidden'; /* keeps #pTip's font (removed before any paint) */ t2.textContent = need[ni]; par.appendChild(t2); cl.push(t2); }
      for (ni = 0; ni < need.length; ni++) LW[need[ni]] = cl[ni].offsetWidth;
      for (ni = 0; ni < cl.length; ni++) par.removeChild(cl[ni]);
    }
    for (mi = 0; mi < st.btns.length; mi++) { mb = st.btns[mi]; if (mb.lb) mb.lw = LW[mb.lb] + 22; }
    E.tip.textContent = ''; E.tip._t = null;
  }
  function paintPP() { var b = S && S.btns[0]; if (b && S.v) b.el.innerHTML = S.v.paused ? ICON.play : ICON.pause; }
  function paintBtns() {
    var st = S;
    for (var i = 0; i < st.btns.length; i++) {
      var b = st.btns[i], f = (st.mode === 'osd' && st.row === 'btns' && i === st.bIdx) || (st.mode === 'tray' && st.tray && st.tray.btn === b.id);
      b.el.className = b.el._base + (f ? ' f' : '');
    }
    // the focused button opens into a pill with its name: the pill is two round caps and a stretched
    // middle moved by transforms, the other buttons slide aside - nothing is laid out or repainted
    var fb = st.btns[st.bIdx], onRow = st.mode === 'osd' && st.row === 'btns', fi = st.bIdx;
    if (st.mode === 'tray' && st.tray) for (var j = 0; j < st.btns.length; j++) if (st.btns[j].id === st.tray.btn) { fb = st.btns[j]; fi = j; }
    if (fb && E.foc) {
      var show = onRow || st.mode === 'tray', lw = show && fb.lb ? (fb.lw || 0) : 0, nL = st.nL || 0;
      for (var k = 0; k < st.btns.length; k++) {
        var dx = 0;
        if (fi < nL && k < nL && k > fi) dx = lw; // left group grows to the right
        if (fi >= nL && k >= nL && k <= fi) dx = -lw; // right group grows to the left
        var bk = st.btns[k]; if (bk._dx !== dx) { bk._dx = dx; bk.el.style.webkitTransform = bk.el.style.transform = dx ? 'translateX(' + dx + 'px)' : ''; }
      }
      var el = fb.el, x = el.offsetLeft + (fb._dx || 0), y = el.offsetTop, sz = el.offsetWidth / 76;
      var far = E.foc._x != null && Math.abs(x - E.foc._x) > 260; E.foc._x = x;
      if (far) { E.foc._j = !E.foc._j; E.foc.style.webkitTransition = E.foc.style.transition = E.focM.style.webkitTransition = E.focM.style.transition = E.focC.style.webkitTransition = E.focC.style.transition = E.tip.style.webkitTransition = E.tip.style.transition = 'none'; }
      E.foc.style.webkitTransform = E.foc.style.transform = 'translate(' + x + 'px,' + y + 'px)' + (sz !== 1 ? ' scale(' + sz + ')' : '');
      if (far) { void getComputedStyle(E.foc).transform; E.foc.style.webkitTransition = E.foc.style.transition = ''; }
      E.focM.style.webkitTransform = E.focM.style.transform = 'scaleX(' + Math.max(0.001, lw) + ')';
      E.focC.style.webkitTransform = E.focC.style.transform = 'translateX(' + lw + 'px)';
      E.foc.className = show ? 'on' + (far ? (E.foc._j ? ' ja' : ' jb') : '') : '';
      var lb = fb.lb || '';
      if (E.tip._t !== lb) { E.tip._t = lb; E.tip.textContent = lb; E.tip._ab = !E.tip._ab; } // a new name: replay its entrance (two keyframes, no reflow)
      E.tip.style.webkitTransform = E.tip.style.transform = 'translate(' + (x + 70) + 'px,' + (y + 38) + 'px) translateY(-50%)';
      if (far) { void getComputedStyle(E.tip).transform; E.focM.style.webkitTransition = E.focM.style.transition = E.focC.style.webkitTransition = E.focC.style.transition = E.tip.style.webkitTransition = E.tip.style.transition = ''; }
      E.tip.className = lw ? 'on ' + (E.tip._ab ? 'a' : 'b') : '';
    }
    E.trk.className = 'trk' + (st.mode === 'osd' && st.row === 'bar' ? ' f' : '') + (st.seekT >= 0 ? ' sk' : '');
  }
  function showOsd(keepFocus) {
    var st = S; if (!st || !st.v) return;
    if (st.mode === 'video') { st.mode = 'osd'; if (!keepFocus) { st.row = 'btns'; st.bIdx = 0; } }
    var was = root.classList.contains('osd');
    cls('skm', false); cls('osd', true); E.trk._w = 0; paintBtns(); paintBar(); paintClock(); armHide(); paintPrompt();
    if (!was && E.inf && E.inf.innerHTML) infIn();
  }
  function hideOsd() { var st = S; st.mode = 'video'; cls('osd', false); paintBtns(); paintPrompt(); }
  function armHide() {
    var st = S; if (!st) return; clearTimeout(st.hideT);
    st.hideT = later(function () { if (st.mode !== 'osd' || (st.v && st.v.paused) || st.seekT >= 0) return; hideOsd(); }, 5000);
  }
  function paintBar() {
    var st = S, v = st && st.v; if (!v || !v.duration || v.duration === Infinity) return;
    var t = st.seekT >= 0 ? st.seekT : v.currentTime, d = v.duration, p = Math.max(0, Math.min(1, t / d));
    var tw = E.trk._w || (E.trk._w = E.trk.offsetWidth) || 1, kx = Math.round(p * tw); // transforms only; the bar's width is measured when the controls show
    E.fil.style.webkitTransform = E.fil.style.transform = 'scaleX(' + p.toFixed(4) + ')'; E.knb.style.webkitTransform = E.knb.style.transform = 'translateX(' + kx + 'px)';
    var c1 = fmt(t), c2 = '-' + fmt(d - t); if (E.cur._t !== c1) { E.cur._t = c1; E.cur.textContent = c1; } if (E.rem._t !== c2) { E.rem._t = c2; E.rem.textContent = c2; } // 4 timeupdates a second, one new text
    var be = 0; try { var b = v.buffered; for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) be = b.end(i); } catch (e) {}
    var bp = Math.max(p, be / d).toFixed(4); if (E.bfd._p !== bp) { E.bfd._p = bp; E.bfd.style.webkitTransform = E.bfd.style.transform = 'scaleX(' + bp + ')'; }
  }
  function act(id) {
    if (id === 'pp') toggle();
    else if (id === 'rw') seekBy(-1);
    else if (id === 'ff') seekBy(1);
    else if (id === 'asp') nextAspect();
    else if (id === 'nxt') nextAuto();
    else openTray(id);
    armHide();
  }
  function toggle() { var v = S.v; if (!v) return; if (v.paused) v.play(); else v.pause(); }
  function showBuf() { var st = S; if (!st.live || !st.v || st.v.paused) return; cls('buf', true); }
  function hideBuf() { cls('buf', false); }

  // ---------------------------------------------------------------- aspect ratio
  // The TV draws the film on its own video plane inside the element's box, so "fill" sizes the
  // element itself (cropping the overflow) instead of relying on object-fit.
  function nextAspect() {
    var st = S, i = 0, v = st.v; for (var k = 0; k < ASPECTS.length; k++) if (ASPECTS[k][0] === st.aspect) i = k;
    var same = v && v.videoWidth && Math.abs(v.videoWidth / v.videoHeight - window.innerWidth / window.innerHeight) < 0.03; // 16:9: Fill = Original
    var n = (i + 1) % ASPECTS.length; if (same && ASPECTS[n][0] === 'fill') n = (n + 1) % ASPECTS.length;
    st.aspect = ASPECTS[n][0]; lsPut('aspectMode', st.aspect); applyAspect();
    var a = ASPECTS[n][1]; E.seek.textContent = T(a); cls('sk', true); clearTimeout(st.seekHide);
    st.seekHide = later(function () { if (st.seekT < 0) cls('sk', false); }, 1100);
    var b = null; for (var j = 0; j < st.btns.length; j++) if (st.btns[j].id === 'asp') b = st.btns[j];
    if (b) { b.lb = T(a); E.tip.textContent = b.lb; b.lw = E.tip.offsetWidth + 22; E.tip._t = null; paintBtns(); } // the button names the mode it is in
  }
  // Tested on the TV with its own screen capture: the video plane follows the element's box and
  // keeps the picture's shape inside it (CSS object-fit and transforms are ignored, so it can't
  // stretch). Fill = a box the picture's shape that covers the screen (the plane crops what is
  // outside); Zoom = a third bigger than Fit, for films with black bars baked into a 16:9 file.
  function applyAspect() {
    var st = S, v = st && st.v; if (!v) return;
    var W = window.innerWidth, H = window.innerHeight, vw = v.videoWidth, vh = v.videoHeight, s = v.style;
    s.width = '100%'; s.height = '100%'; s.left = '0'; s.top = '0';
    if ((st.aspect === 'fill' || st.aspect === 'zoom') && vw && vh) {
      var k = st.aspect === 'fill' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh) * 1.333, w = Math.round(vw * k), h = Math.round(vh * k);
      s.width = w + 'px'; s.height = h + 'px'; s.left = Math.round((W - w) / 2) + 'px'; s.top = Math.round((H - h) / 2) + 'px';
    }
  }

  // ---------------------------------------------------------------- seeking
  // Presses add up (+10, +20, held: faster) and commit 1.2 s after the last one, so the TV
  // buffers once. With the controls hidden only the amount and the bar show.
  function seekBy(dir) {
    var st = S, v = st.v; if (!v || !v.duration || v.duration === Infinity) return;
    var now = Date.now(), step = parseInt(lsGet('seekStep', '10'), 10) || 10;
    st.rep = (now - st.lastKey < 400 && dir === st.seekDir) ? st.rep + 1 : 0; st.lastKey = now; st.seekDir = dir;
    step *= st.rep < 4 ? 1 : (st.rep < 10 ? 3 : 6);
    var base = st.seekT >= 0 ? st.seekT : v.currentTime;
    st.seekT = Math.max(0, Math.min(v.duration - 1, base + dir * step));
    if (st.mode === 'video') cls('skm', true); else armHide();
    paintBtns(); paintBar();
    var dd = Math.round(st.seekT - v.currentTime), a = Math.abs(dd);
    E.seek.textContent = (dd >= 0 ? '+' : '-') + (a >= 60 ? T('{m}m', { m: (a / 60) | 0 }) + (a % 60 ? ' ' + T('{s}s', { s: a % 60 }) : '') : T('{s}s', { s: a }));
    cls('sk', true); clearTimeout(st.seekHide);
    clearTimeout(st.seekTimer); st.seekTimer = later(commitSeek, 1200);
  }
  function commitSeek() {
    var st = S; if (!st || st.seekT < 0) return;
    var t = st.seekT; st.seekT = -1; clearTimeout(st.seekTimer);
    doSeek(t); showBuf(); paintBtns();
    st.seekHide = later(function () { cls('sk', false); cls('skm', false); }, 900);
    if (st.embN >= 0) pollEmb();
  }
  function cancelSeek() { var st = S; st.seekT = -1; clearTimeout(st.seekTimer); cls('sk', false); cls('skm', false); paintBar(); paintBtns(); }
  // webOS media-pipeline bug: after a seek some files resume from 0 while reporting the new
  // position. A position set on a FRESH load (autoplay off, play after 'seeked') is honoured,
  // so those files seek by reloading at the target; a watchdog switches a file over when it
  // notices the restart (3 s after a seek, still far behind the target).
  function reloadSeek(t) {
    var v = S.v; if (!v) return;
    var resume = !v.paused || v.__rsResume, src = v.__rsSrc || v.currentSrc || v.src;
    v.__rsResume = resume; v.__rsSrc = src; v.pause(); v.autoplay = false;
    if (v.__rsH) { v.removeEventListener('loadedmetadata', v.__rsH); v.removeEventListener('seeked', v.__rsS); }
    v.__rsH = function () { v.removeEventListener('loadedmetadata', v.__rsH); try { v.currentTime = t; } catch (e) {} };
    v.__rsS = function () { v.removeEventListener('seeked', v.__rsS); v.__rsH = null; v.__rsSrc = null; var r = v.__rsResume; v.__rsResume = false; if (r) { try { v.play(); } catch (e) {} } };
    v.addEventListener('loadedmetadata', v.__rsH); v.addEventListener('seeked', v.__rsS);
    v.src = src; try { v.load(); } catch (e) {}
  }
  function doSeek(t) {
    var st = S, v = st.v; if (!v) return;
    st.lastSeekT = t;
    if (st.seekFix) { reloadSeek(t); return; }
    v.currentTime = t;
    if (st.isHls) return;
    later(function () { if (st.lastSeekT === t && !st.seekFix && st.v && !st.v.paused && t > 15 && st.v.currentTime < t - 12) { st.seekFix = true; reloadSeek(t); } }, 3000);
  }

  // ---------------------------------------------------------------- keys
  function key(k) {
    var st = S; if (!st) return true;
    if (!st.v) return true; // the art is up (resolving): only Back does anything
    if (k === 415) { if (st.v.paused) st.v.play(); showOsd(true); return true; }
    if (k === 19) { if (!st.v.paused) st.v.pause(); showOsd(true); return true; }
    if (k === 10252 || k === 179 || k === 463) { toggle(); showOsd(true); return true; }
    if (k === 413) { close(); return true; }
    if (k === 412) { seekBy(-1); return true; }
    if (k === 417) { seekBy(1); return true; }
    if (st.mode === 'tray') return trayKey(k);
    if (st.mode === 'prompt') return promptKey(k);
    if (st.mode === 'video') {
      if (k === 13) { if (st.seekT >= 0) commitSeek(); else if (st.prompt) promptGo(st.prompt.btns[st.promptIdx]); else { toggle(); showOsd(); } return true; }
      if (k === 37) { seekBy(-1); return true; }
      if (k === 39) { seekBy(1); return true; }
      if (k === 38 || k === 40) { if (st.seekT >= 0) commitSeek(); showOsd(); return true; }
      return true;
    }
    armHide();
    if (st.row === 'bar') {
      if (k === 37) seekBy(-1);
      else if (k === 39) seekBy(1);
      else if (k === 13) { if (st.seekT >= 0) commitSeek(); else toggle(); }
      else if (k === 40) { if (st.seekT >= 0) commitSeek(); st.row = 'btns'; paintBtns(); }
      else if (k === 38) { if (st.prompt) { st.mode = 'prompt'; paintPrompt(); } else nudge(E.trk.parentNode, k); }
      return true;
    }
    if ((k === 37 && st.bIdx === 0) || (k === 39 && st.bIdx === st.btns.length - 1)) nudge(E.bl.parentNode, k); // the row's end
    else if (k === 37) { st.bIdx = Math.max(0, st.bIdx - 1); paintBtns(); }
    else if (k === 39) { st.bIdx = Math.min(st.btns.length - 1, st.bIdx + 1); paintBtns(); }
    else if (k === 38) { st.row = 'bar'; paintBtns(); }
    else if (k === 40) hideOsd();
    else if (k === 13) act(st.btns[st.bIdx].id);
    return true;
  }
  function back() {
    var st = S; if (!st) return;
    if (st.closing) return;
    if (st.mode === 'tray') { trayBack(); return; }
    if (st.mode === 'prompt') { dismissPrompt(); return; }
    if (st.seekT >= 0) { cancelSeek(); return; } // Back cancels a pending seek
    if (st.mode === 'osd' && !(st.v && st.v.paused)) { hideOsd(); return; }
    close();
  }

  // ---------------------------------------------------------------- intro / recap / credits
  // Segments come from the helper (/skips): IntroDB for shows and films (IMDb id), AniSkip
  // for anime (Kitsu ids, mapped to MyAnimeList). A skip pill shows during an intro or a
  // recap (OK skips it); when the credits start, "Next episode" / "Watch credits".
  function loadSkips() {
    var st = S, o = st.o; if (st.isTrailer || st.skipsAsked || !o.id) return; st.skipsAsked = true;
    var d = st.v && st.v.duration > 0 && st.v.duration !== Infinity ? Math.round(st.v.duration) : 0;
    var file = st.isHls ? '' : o.url;
    xhr(SRV + '/skips?type=' + encodeURIComponent(o.type) + '&id=' + encodeURIComponent(o.id) + '&vid=' + encodeURIComponent(st.vidId) + '&dur=' + d + (file ? '&u=' + encodeURIComponent(file) + (st.isP2p ? '&p2p=1' : '') : ''), function (j) {
      if (S !== st) return;
      // credits learned from this show's other episodes (how long before the end they start)
      var lk = 'creditsOff_' + o.id;
      if (j && j.outro && d && o.type === 'series' && d - j.outro.s > 10 && d - j.outro.s < 600) lsPut(lk, String(Math.round(d - j.outro.s)));
      else if (j && !j.outro && d > 600 && o.type === 'series') { var off = parseFloat(lsGet(lk, '0')) || 0; if (off > 10) { j.outro = { s: d - off, e: d, est: true }; j.ok = true; } }
      if (j && j.ok) { st.skips = j; checkPrompt(); paintMarks(); }
      else if (!j && (st.skipsTry = (st.skipsTry || 0) + 1) < 4) later(function () { st.skipsAsked = false; loadSkips(); }, 8000 * st.skipsTry); // helper busy / offline: ask again
    }, 15000);
  }
  // faint white marks on the progress line where the intro, the recap and the credits are
  function paintMarks() {
    var st = S, v = st.v, sk = st.skips, h = '';
    if (sk && v && v.duration > 0 && v.duration !== Infinity) {
      var d = v.duration, segs = [sk.intro, sk.recap, sk.outro];
      for (var i = 0; i < segs.length; i++) { var g = segs[i]; if (!g) continue;
        var a = Math.max(0, g.s / d * 100), w = Math.max(0.4, Math.min(100, g.e / d * 100) - a);
        h += '<i style="left:' + a.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></i>'; }
    }
    E.mks.innerHTML = h;
  }
  function inSeg(seg, t, tail) { return seg && t >= seg.s && t < seg.e - (tail || 0); }
  function checkPrompt() {
    var st = S, v = st.v; if (!v || !v.duration || st.seekT >= 0) return;
    var t = v.currentTime, sk = st.skips || {}, want = null;
    if (inSeg(sk.intro, t, 2) && !st.dismissed.intro) want = { k: 'intro', btns: [{ id: 'skip', lb: T('Skip intro'), to: sk.intro.e }] };
    else if (inSeg(sk.recap, t, 2) && !st.dismissed.recap) want = { k: 'recap', btns: [{ id: 'skip', lb: T('Skip recap'), to: sk.recap.e }] };
    else if (!st.dismissed.outro && (st.o.next || st.o.sim)) {
      // credits: the segment when known, else the last 90 s
      var credits = sk.outro ? t >= sk.outro.s : (v.duration > 600 && v.duration - t <= 90 && v.duration - t > 2);
      if (credits) want = { k: 'outro', big: true, btns: st.o.next
        ? [{ id: 'credits', lb: T('Watch credits') }, { id: 'next', lb: T('Next episode'), main: true }]
        : [{ id: 'credits', lb: T('Watch credits') }, { id: 'sim', lb: T('Something similar'), main: true }] };
    }
    var cur = st.prompt;
    if ((cur && cur.k) === (want && want.k)) return;
    clearTimeout(st.cdT); st.cdT = null;
    // credits + autoplay on: "Next episode" fills up like Netflix and plays by itself unless you pick something
    if (want && want.k === 'outro' && st.o.next && lsGet('bingeWatch', 'true') !== 'false' && lsGet('enableNextVideo', 'true') !== 'false') {
      want.auto = true; want.t0 = Date.now(); st.cdT = later(function () { if (st.prompt && st.prompt.auto) nextAuto(); }, 10000);
    }
    st.prompt = want; st.promptIdx = want ? want.btns.length - 1 : 0;
    if (want && want.big && st.mode === 'video') st.mode = 'prompt'; // the credits card takes the focus, like Netflix
    if (!want && st.mode === 'prompt') st.mode = 'video';
    paintPrompt(true);
  }
  // credits with a next episode: a "next up" card - its still with the countdown running along it,
  // S·E and title, two lines of its story, and the keys: OK = next episode, BACK = watch the credits
  function nextCard(p) {
    var st = S, n = st.o.next || {}, th = n.thumb || st.o.bg || '';
    return '<div class="nxc"><div class="art"' + (th ? ' style="background-image:url(&quot;' + esc(th) + '&quot;)"' : '') + '>' + (p.auto ? '<i class="cd"></i>' : '') + '</div>' +
      '<div class="up">' + esc(T('Next episode')) + (p.auto ? '<span class="sec"></span>' : '') + '</div>' +
      '<div class="tt"><bdi class="se">' + esc(n.se || '') + '</bdi>' + (n.title ? '<i>·</i>' + esc(n.title) : '') + '</div>' + (n.ov ? '<div class="ov">' + esc(n.ov) + '</div>' : '') +
      '<div class="hk"><span class="ok"><b>OK</b>' + esc(T('Next episode')) + '</span><span><b>' + esc(T('BACK')) + '</b>' + esc(T('Watch credits')) + '</span></div></div>';
  }
  function nextTick() { // "Starts in 8 s" while the countdown runs
    var st = S, p = st && st.prompt, el = E.prompt.getElementsByClassName('sec')[0]; if (!p || !p.auto || !el) return;
    var left = Math.max(0, Math.ceil((p.t0 + 10000 - Date.now()) / 1000)); el.textContent = '  ·  ' + T('Starts in {n} s', { n: left });
    if (left > 0) st.cdI = later(nextTick, 250);
  }
  function paintPrompt(rebuild) {
    var st = S, p = st && st.prompt;
    if (!p) { E.prompt.className = ''; return; }
    if (p.k === 'outro' && st.o.next) { // the next-up card (OK / BACK, no buttons to move between)
      if (rebuild || !E.prompt.firstChild) { E.prompt.innerHTML = nextCard(p); if (p.auto) { p.t0 = p.t0 || Date.now(); nextTick(); } }
      st.promptIdx = p.btns.length - 1;
      E.prompt.className = 'on big nxt' + (p.auto ? ' auto' : '');
      return;
    }
    if (rebuild || !E.prompt.firstChild) {
      var h = '';
      for (var i = 0; i < p.btns.length; i++) h += '<div class="pp' + (p.btns[i].main ? ' main' : '') + '">' + (p.auto && p.btns[i].id === 'next' ? '<i class="cd"></i>' : '') + (p.btns[i].main || p.btns[i].id === 'skip' ? (p.btns[i].id === 'next' ? ICON.next : ICON.skip) : '') + '<span>' + esc(p.btns[i].lb) + '</span></div>';
      E.prompt.innerHTML = h;
    }
    var els = E.prompt.children, focus = st.mode === 'prompt' || (st.mode === 'video' && !p.big);
    for (var j = 0; j < els.length; j++) els[j].className = 'pp' + (p.btns[j].main ? ' main' : '') + (focus && j === st.promptIdx ? ' f' : '');
    E.prompt.className = 'on' + (p.big ? ' big' : '') + (p.auto ? ' auto' : '');
  }
  function promptKey(k) {
    var st = S, p = st.prompt; if (!p) { st.mode = 'video'; return key(k); }
    if (p.k === 'outro' && st.o.next && (k === 37 || k === 39)) { nudge(E.prompt, k); return true; } // the card: OK or BACK
    if ((k === 37 && st.promptIdx === 0) || (k === 39 && st.promptIdx >= p.btns.length - 1)) nudge(E.prompt, k);
    else if (k === 37) { st.promptIdx = Math.max(0, st.promptIdx - 1); paintPrompt(); }
    else if (k === 39) { st.promptIdx = Math.min(p.btns.length - 1, st.promptIdx + 1); paintPrompt(); }
    else if (k === 13) promptGo(p.btns[st.promptIdx]);
    else if (k === 40 || k === 38) { st.mode = 'video'; showOsd(); }
    return true;
  }
  function promptGo(b) {
    var st = S; if (!b) return;
    if (b.id === 'skip') { st.dismissed[st.prompt.k] = true; st.prompt = null; st.mode = st.mode === 'prompt' ? 'video' : st.mode; paintPrompt(); doSeek(b.to); showBuf(); }
    else if (b.id === 'credits') dismissPrompt();
    else goNext();
  }
  function dismissPrompt() { var st = S; clearTimeout(st.cdT); clearTimeout(st.cdI); if (st.prompt) st.dismissed[st.prompt.k] = true; st.prompt = null; if (st.mode === 'prompt') st.mode = 'video'; paintPrompt(); }
  function goNext() {
    var st = S, o = st.o;
    if (o.next && !st.nextTried) { st.nextTried = true; nextAuto(); }
    else if (o.next) { markWatched(); close({ go: function () { api.onNext({ type: o.type, id: o.id, vid: o.next.vid }); } }); }
    else if (o.sim) close({ go: function () { api.onSimilar({ type: o.type, id: o.id }); } });
  }

  // ---------------------------------------------------------------- P2P
  function p2pTick() {
    var st = S;
    var vis = !st.live || root.classList.contains('buf');
    var calm = st.live && st.v && !st.v.paused && !root.classList.contains('buf') ? Math.round((Date.now() - (st.hiccup || Date.now())) / 1000) : 0;
    xhr(SRV + '/p2p/stats?keepalive=1&ih=' + st.p2pIh + '&calm=' + calm + '&dur=' + Math.round((st.v && st.v.duration) || 0), function (j) {
      if (S !== st) return;
      var t = (window.p2pLine && window.p2pLine(j)) || T('Connecting to peers…');
      E.bufSt.textContent = t; if (!st.live) setStatus(t);
      if (E.p2p) { E.p2p.textContent = t; cls('p2p', true); }
    }, 5000);
    later(p2pTick, vis || root.classList.contains('osd') ? 1000 : 10000);
  }

  // ---------------------------------------------------------------- library / progress
  // Progress is stored like stremio-core's library items so the account and the other apps
  // agree: auto-created items are removed:true + temp:true (Continue Watching only).
  function libPrefix() {
    try { var u = JSON.parse(localStorage.getItem('user') || 'null'); if (u && u._id) return 'lib_' + u._id.slice(0, 4) + '_'; } catch (e) {}
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf('lib_') === 0) { var j = k.indexOf('_', 4); if (j > 0) return k.slice(0, j + 1); } } } catch (e) {}
    return 'lib_local_';
  }
  function readLib() { try { return JSON.parse(localStorage.getItem(S.libKey) || 'null'); } catch (e) { return null; } }
  function pushLib(force) {
    var st = S; if (!st || st.isTrailer) return;
    var ak = null; try { ak = JSON.parse(localStorage.getItem('authKey') || 'null'); } catch (e) {}
    if (!ak) return; var it = readLib(); if (!it || !it._id) return;
    var n = Date.now(); if (!force && n - st.lastPush < 60000) return; st.lastPush = n;
    xpost('https://api.strem.io/api/datastorePut', { authKey: ak, collection: 'libraryItem', changes: [it] });
  }
  function saveProgress() {
    var st = S, v = st && st.v, o = st && st.o; if (!v || !v.duration || !o.id || st.isTrailer || v.duration === Infinity) return;
    var now = new Date().toISOString(), it = readLib();
    if (!it || !it.state) it = { state: {}, _id: o.id, removed: true, temp: true, _ctime: now, name: o.name || '', type: o.type, poster: o.poster || '', posterShape: 'poster', background: o.bg || '', logo: o.logoEn || o.logo || '', year: '' }; // the account's copy: never the translated logo
    else { if (!it.name && o.name) it.name = o.name; if (!it.poster && o.poster) it.poster = o.poster; if (!it.type && o.type) it.type = o.type; if (!it.posterShape) it.posterShape = 'poster'; }
    var s = it.state;
    s.timeOffset = Math.round(v.currentTime * 1000); s.duration = Math.round(v.duration * 1000); s.video_id = st.vidId; s.lastWatched = now; s.timeWatched = s.timeOffset;
    if (s.overallTimeWatched == null) s.overallTimeWatched = s.timeOffset; if (s.timesWatched == null) s.timesWatched = 0; if (s.flaggedWatched == null) s.flaggedWatched = 0;
    if (s.season == null) s.season = 0; if (s.episode == null) s.episode = 0; if (!s.watchedEpisodes) s.watchedEpisodes = []; if (s.noNotif == null) s.noNotif = false; if (s.watched == null) s.watched = '';
    it.state = s; it._mtime = now; if (it.removed == null) it.removed = true; if (it.temp == null) it.temp = true;
    lsPut(st.libKey, JSON.stringify(it));
  }
  function markWatched() {
    var st = S; if (!st || st.isTrailer || st.marked) return;
    try {
      var it = readLib(); if (!it || !it.state) return;
      var wv = st.vidId; if (!it.state.watchedEpisodes) it.state.watchedEpisodes = [];
      for (var i = 0; i < it.state.watchedEpisodes.length; i++) if (it.state.watchedEpisodes[i] === wv) { st.marked = true; return; }
      it.state.watchedEpisodes.push(wv); it.state.flaggedWatched = 1; it.state.timesWatched = (it.state.timesWatched || 0) + 1;
      it.state.lastWatched = new Date().toISOString(); it._mtime = it.state.lastWatched;
      lsPut(st.libKey, JSON.stringify(it)); st.marked = true; pushLib(true);
    } catch (e) {}
  }
  function tryResume() {
    var st = S; if (st.didResume || st.isTrailer) return; st.didResume = true;
    if (st.o.startAt < 0) return; // "Watch from the beginning"
    if (st.o.startAt > 0) { doSeek(st.o.startAt); return; } // another source: same moment
    var it = readLib();
    if (it && it.state && it.state.video_id === st.vidId && it.state.timeOffset > 5000) {
      var sec = it.state.timeOffset / 1000;
      if (!it.state.duration || sec < it.state.duration / 1000 - 30) { try { doSeek(sec); api.toast(T('Resuming from ') + fmt(sec)); } catch (e) {} }
    }
  }

  // ---------------------------------------------------------------- audio
  function autoAudio() {
    var st = S; if (st.autoAudDone || lsGet('enableDefaultAudioTrack', 'false') !== 'true') return;
    var want = (lsGet('defaultAudioTrack', '') || '').toLowerCase(); if (!want) return;
    try { var ts = st.v.audioTracks; if (!ts || !ts.length) return; for (var i = 0; i < ts.length; i++) if (langMatch(ts[i].language, want)) { st.autoAudDone = true; setAudio(i); return; } } catch (e) {}
  }
  function setAudio(i) { var st = S; st.curAud = i; try { var ts = st.v.audioTracks; for (var j = 0; j < ts.length; j++) ts[j].enabled = (j === i); } catch (e) {} paintInfo(); }

  // ---------------------------------------------------------------- subtitles
  function wantSub() { var r = lsGet('subsLang', null); if (r == null) r = lsGet('subtitles', null); return (r == null ? 'eng' : r).toLowerCase(); } // never set = English; "" = Off
  function sizeIdx() { var i = parseInt(lsGet('subtitleSize', '2'), 10); return (i >= 0 && i < SUB_SIZES.length) ? i : 2; }
  function bgIdx() { var i = SUB_BGS.indexOf(lsGet('subsBgStyle', '0')); return i < 0 ? 0 : i; }
  function subStyle() {
    var o = lsGet('subsOutlineColor', '#000000'), size = Math.round(38 * SUB_SIZES[sizeIdx()] / 100), bo = parseFloat(SUB_BGS[bgIdx()]) || 0;
    var sh = 'text-shadow:-2px 0 ' + o + ',2px 0 ' + o + ',0 -2px ' + o + ',0 2px ' + o + ',-1px -1px ' + o + ',1px 1px ' + o + ',0 0 5px ' + o + ';';
    return 'font-size:' + size + 'px;color:' + lsGet('subsColor', '#ffffff') + ';' + sh + (bo > 0 ? 'background:rgba(0,0,0,' + bo + ');padding:2px 16px;border-radius:8px;' : '');
  }
  function autoSub() {
    var st = S, w = wantSub(); if (st.autoSubDone || st.curSub !== 'off') return;
    if (st.isTrailer) {
      if (!st.extSubs.length) return; var pick = st.extSubs[0];
      for (var p = 0; p < st.extSubs.length; p++) if (langMatch(st.extSubs[p].lang, w)) { pick = st.extSubs[p]; break; }
      st.autoSubDone = true; setExtSub(pick.u); return;
    }
    if (!w) return;
    var em = null; if (st.embTracks) for (var j = 0; j < st.embTracks.length; j++) if (langMatch(st.embTracks[j].lang, w) && (!em || em.forced && !st.embTracks[j].forced)) em = st.embTracks[j];
    if (em) { st.autoSubDone = true; setEmbSub(em.n); return; } // embedded wins: it is in sync with the file
    if (st.embLoading && !st.embWaitOver) { if (!st.embWaitT) st.embWaitT = later(function () { st.embWaitOver = true; autoSub(); }, 8000); return; }
    for (var i = 0; i < st.extSubs.length; i++) if (langMatch(st.extSubs[i].lang, w)) { st.autoSubDone = true; setExtSub(st.extSubs[i].u); return; }
  }
  function loadExtSubs(n) {
    var st = S, o = st.o; if (!o.type || !st.vidId) return;
    st.extLoading = true;
    xhr(SRV + '/subs?type=' + encodeURIComponent(o.type) + '&vid=' + encodeURIComponent(st.vidId), function (j) {
      if (S !== st) return;
      if (j && j.subtitles && j.subtitles.length) { st.extLoading = false; st.extSubs = j.subtitles; autoSub(); refreshTray('subs'); }
      else if (n < 3) later(function () { loadExtSubs(n + 1); }, (n + 1) * 15000);
      else { st.extLoading = false; refreshTray('subs'); }
    }, 20000);
  }
  function loadEmbTracks(n, now) {
    var st = S;
    xhr(SRV + '/embtracks?u=' + encodeURIComponent(st.o.url) + '&t=' + ((st.v && st.v.currentTime) | 0) + (st.isP2p && !now ? '&lazy=1' : ''), function (j) {
      if (S !== st) return;
      if (j && j.later) { st.embLoading = false; st.embLater = true; st.embTracks = []; refreshTray('subs'); return; } // a torrent MP4: listed when Subtitles opens
      st.embLoading = false; st.embTracks = (j && j.tracks) || []; st.embErr = (j && j.err) || '';
      if (!st.embTracks.length && st.isP2p && n < 2) { st.embLoading = true; later(function () { loadEmbTracks(n + 1); }, (n + 1) * 25000); return; }
      if (!st.autoSubDone) autoSub(); refreshTray('subs');
    }, 30000);
  }
  function bufAhead() { try { var b = S.v.buffered, t = S.v.currentTime; for (var i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return Math.round(b.end(i) - t); } catch (e) {} return -1; }
  function embPos() { var st = S; if (st.embN < 0 && st.embTracks && st.embTracks.length && st.v) xhr(SRV + '/embpos?u=' + encodeURIComponent(st.o.url) + '&t=' + (st.v.currentTime | 0) + '&b=' + bufAhead()); }
  function embQS() { var st = S; return 'u=' + encodeURIComponent(st.o.url) + '&n=' + st.embN + '&id=' + encodeURIComponent(st.o.id) + '&vid=' + encodeURIComponent(st.vidId); }
  function ensureHelper() { // the helper restarts itself when its memory runs high: bring it back
    var st = S; if (Date.now() - st.helperAt < 30000) return; st.helperAt = Date.now();
    if (api.ensureHelper) api.ensureHelper();
  }
  // lines are numbered by the helper (q); it drops lines far from the playhead on very long
  // tracks and bumps the epoch (ep): we then take its whole list, so both always match
  function embTake(list, reset) {
    var st = S; if (reset || !st.cues) { st.cues = []; st.embQ = 0; }
    for (var i = 0; i < list.length; i++) { st.cues.push(list[i]); if (list[i].q >= st.embQ) st.embQ = list[i].q + 1; }
    E.sub._t = null; renderSub();
  }
  function pollEmb() {
    var st = S; if (st.embN < 0 || st.embPolling || st.embDone || !st.v) return;
    var want = st.embN; st.embPolling = true; later(function () { st.embPolling = false; }, 3000);
    xhr(SRV + '/embcues?' + embQS() + '&since=' + st.embQ + '&ep=' + st.embEp + '&t=' + (st.v.currentTime | 0) + '&b=' + bufAhead(), function (j) {
      if (S !== st) return; st.embPolling = false;
      if (want !== st.embN) return;
      if (!j) { if (++st.embFails >= 3) { st.embFails = 0; ensureHelper(); } return; }
      st.embFails = 0;
      if (j.gone) { setEmbSub(st.embN); return; } // helper restarted / job reaped: start again
      if (j.ep != null) st.embEp = j.ep;
      if (j.reset) embTake(j.cues || [], true); else if (j.cues && j.cues.length) embTake(j.cues, false);
      if (j.done) st.embDone = true;
      if (j.err && !(st.cues && st.cues.length)) api.toast(T('Subtitle extraction failed'));
    }, 12000);
  }
  function fastPoll() {
    var st = S; if (st.embN < 0 || st.fastN++ > 40 || !st.v) return;
    var t = st.v.currentTime, near = false;
    if (st.cues) for (var i = 0; i < st.cues.length; i++) if (st.cues[i].e >= t - 2 && st.cues[i].s <= t + 20) { near = true; break; }
    if (near && st.fastN > 2) return;
    pollEmb(); later(fastPoll, 350);
  }
  function seekBurst() { // after a seek the helper reads the new spot in about a second
    var st = S; if (st.embN < 0) return;
    var d = [0, 350, 700, 1200, 2000, 3000], k = 0;
    (function b() { if (S !== st || st.embN < 0 || k >= d.length) return; pollEmb(); var w = (d[k + 1] || 0) - d[k]; k++; if (k < d.length) later(b, w); })();
  }
  function setEmbSub(n) {
    var st = S; st.curSub = 'emb:' + n; st.embN = n; st.cues = []; st.embQ = 0; st.embEp = 0; st.embDone = false; st.fastN = 0;
    E.sub.innerHTML = ''; E.subP.innerHTML = '';
    xhr(SRV + '/embstart?' + embQS() + '&t=' + ((st.v && st.v.currentTime) | 0), function (j) {
      if (S !== st || st.embN !== n) return;
      if (!j) { ensureHelper(); return; } // the 4 s poll starts it again once the helper is back
      st.embEp = j.ep || 0; embTake(j.cues || [], true); if (j.done) st.embDone = true;
      if (j.started && !j.done) { st.fastN = 0; fastPoll(); } else if (j.err) api.toast(T('No embedded subtitles'));
    }, 15000);
    paintInfo(); refreshTray('subs');
  }
  // Auto-sync: the helper lines this subtitle up with the file's own subtitle tracks (or its speech) and answers
  // with new time = old * f + d; applied to the original lines (running it again never adds up), Reset undoes it
  function runSync() {
    var st = S, u = st.curSub.indexOf('ext:') === 0 ? st.curSub.slice(4) : ''; if (!u || st.syncBusy || !st.v) return;
    st.syncBusy = true; st.syncSt = T('Syncing…'); refreshTray('subs');
    xhr(SRV + '/subsync?' + embQS() + '&sub=' + encodeURIComponent(u) + '&t=' + Math.round(st.v.currentTime), function (j) {
      if (S !== st) return; st.syncBusy = false;
      if (st.curSub !== 'ext:' + u) return;
      if (!j || !j.ok) { st.syncSt = !j ? T('Couldn’t sync') : j.why === 'noref' ? T('Nothing to sync against') : j.why === 'unsure' ? T('Not sure: unchanged') : j.why === 'notyet' ? T('Still reading the film’s subtitles: try again in a minute') : T('Couldn’t sync'); refreshTray('subs'); return; }
      var base = st.cuesOrig || st.cues || []; st.cuesOrig = base;
      st.cues = base.map(function (c) { var n = {}; for (var k in c) n[k] = c[k]; n.s = c.s * j.f + j.d; n.e = c.e * j.f + j.d; return n; });
      st.subDelay = 0; E.sub._t = null; renderSub();
      st.syncSt = T('Synced') + ' ' + (j.d >= 0 ? '+' : '') + T('{n} s', { n: j.d.toFixed(1) }) + (Math.abs(j.f - 1) > 0.001 ? '  ·  ' + T('speed fixed') : '');
      refreshTray('subs'); api.toast(st.syncSt);
    }, 110000);
  }
  function setExtSub(u) {
    var st = S; st.curSub = 'ext:' + u; st.embN = -1; st.cues = null; st.cuesOrig = null; st.syncSt = ''; st.syncBusy = false; E.sub.innerHTML = ''; E.subP.innerHTML = '';
    xhr(SRV + '/sub?u=' + encodeURIComponent(u), function (j) { if (S !== st || st.curSub !== 'ext:' + u) return; st.cues = (j && j.cues) || []; E.sub._t = null; renderSub(); }, 20000);
    paintInfo(); refreshTray('subs');
  }
  function subsOff() { var st = S; st.curSub = 'off'; st.embN = -1; st.cues = null; E.sub.innerHTML = ''; E.subP.innerHTML = ''; E.sub._t = null; paintInfo(); refreshTray('subs'); }
  function cueHtml(c) { return c.h || esc(c.t).replace(/\n/g, '<br>'); }
  function vBox() { var v = S.v, W = window.innerWidth, H = window.innerHeight, vw = (v && v.videoWidth) || 16, vh = (v && v.videoHeight) || 9, k = Math.min(W / vw, H / vh); return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k }; }
  function placeCue(c, b) { // ASS lines with an anchor (an 1-9) and/or a position, over the PICTURE (no letterbox)
    var an = c.an || 2, col = (an - 1) % 3, row = an <= 3 ? 2 : (an <= 6 ? 1 : 0), st = '';
    if (c.x != null) st = 'left:' + (b.x + b.w * c.x / 100) + 'px;top:' + (b.y + b.h * c.y / 100) + 'px;-webkit-transform:translate(' + (-50 * col) + '%,' + (-50 * row) + '%);transform:translate(' + (-50 * col) + '%,' + (-50 * row) + '%);';
    else {
      var mx = b.x + b.w * 0.05, my = b.y + b.h * 0.07;
      st = (col === 0 ? 'left:' + mx + 'px;' : col === 2 ? 'right:' + mx + 'px;' : 'left:0;right:0;') + (row === 0 ? 'top:' + my + 'px;' : row === 2 ? 'bottom:' + my + 'px;' : 'top:50%;-webkit-transform:translateY(-50%);transform:translateY(-50%);') + (col === 0 ? 'text-align:left;' : col === 2 ? 'text-align:right;' : '');
    }
    return '<div style="' + st + '"><span style="' + subStyle() + '">' + cueHtml(c) + '</span></div>';
  }
  function renderSub() {
    var st = S; if (!st || st.curSub === 'off' || !st.v) return;
    var bot = [], pos = [], key = '', cs = st.cues;
    if (cs && cs.length) { var t = st.v.currentTime - st.subDelay; for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (t >= c.s && t <= c.e) { if (c.an || c.x != null) pos.push(c); else bot.push(c); key += i + ','; } } }
    if (E.sub._t === key) return; E.sub._t = key;
    bot.sort(function (a, z) { return a.s - z.s || (a.l || 0) - (z.l || 0); }); if (bot.length > 2) bot = bot.slice(-2);
    var hb = ''; for (var j = 0; j < bot.length; j++) hb += (j ? '<br>' : '') + cueHtml(bot[j]);
    E.sub.innerHTML = hb ? '<span style="' + subStyle() + '">' + hb + '</span>' : '';
    var hp = ''; if (pos.length) { var b = vBox(); pos.sort(function (a, z) { return (a.l || 0) - (z.l || 0); }); for (var k = 0; k < pos.length && k < 4; k++) hp += placeCue(pos[k], b); }
    E.subP.innerHTML = hp;
  }
  function restyle() { E.sub._t = null; E.sub.innerHTML = ''; E.subP.innerHTML = ''; renderSub(); }

  // ---------------------------------------------------------------- trays
  // One tray component for Episodes, Sources, Subtitles (+ style), Audio and Aspect ratio: it
  // grows out of its button, takes what it needs up to 40% of the screen, and the film keeps
  // playing in view.
  function openTray(id, opts) {
    var st = S; st.mode = 'tray'; clearTimeout(st.hideT);
    st.tray = { btn: id, kind: id, idx: -1, zone: 'row', row: [], opts: opts || {} };
    if (id === 'eps') { var cur = seasonOf(st.vidId); st.tray.season = cur; }
    if (id === 'subs' && st.embLater) { st.embLater = false; st.embLoading = true; loadEmbTracks(2, true); }
    renderTray(true);
    trayOrigin(id);
    paintBtns();
    // drawn first at full size (an invisible 1%) so its tiles exist at full resolution, then it starts
    // from the button and grows: on this TV a layer that animates before its tiles are drawn shows
    // empty for a few frames
    var t0 = st.tray; cls('tr', false); cls('trp', true);
    raf(function () { raf(function () { setTimeout(function () {
      if (S !== st || st.tray !== t0) return;
      E.tray.style.webkitTransition = E.tray.style.transition = 'none'; cls('trp', false);
      void getComputedStyle(E.tray).opacity; // the start (small, at the button) is applied before the grow begins
      E.tray.style.webkitTransition = E.tray.style.transition = ''; cls('tr', true);
    }, 40); }); });
  }
  // it grows out of the button that opened it and goes back into it: the scale origin is that button's
  // centre relative to the tray, measured without transforms (offset*). Measured again on close: a tray
  // that filled up after opening (Sources) is bigger and placed differently, and shrank to the wrong spot
  function trayOrigin(id) {
    var st = S, b = null; for (var i = 0; i < st.btns.length; i++) if (st.btns[i].id === id) b = st.btns[i].el;
    if (!b) return;
    var ox = 0, oy = 0, n = b; while (n && n !== root) { ox += n.offsetLeft; oy += n.offsetTop; n = n.offsetParent; }
    var tl = E.tray.offsetLeft, tt = E.tray.offsetTop;
    E.tray.style.webkitTransformOrigin = E.tray.style.transformOrigin = Math.round(ox + b.offsetWidth / 2 - tl) + 'px ' + Math.round(oy + b.offsetHeight / 2 - tt) + 'px';
  }
  function closeTray() { var st = S; if (st.tray) trayOrigin(st.tray.btn); st.mode = 'osd'; st.tray = null; cls('tr', false); cls('trp', false); paintBtns(); armHide(); }
  function trayBack() { var t = S.tray; if (t.onBtn) { closeTray(); return; } if (t.zone === 'tabs' && t.idx >= 0) { t.zone = 'row'; paintTray(); return; } if (t.kind === 'epsrc') { t.kind = 'eps'; t.tab = t.backTab; t.zone = 'row'; t.streams = null; renderTray(true); t.idx = t.backIdx; paintTray(); return; } closeTray(); }
  function refreshTray(kind) { if (S && S.tray && S.tray.kind === kind) renderTray(false); }
  function seasons() {
    var vids = S.o.videos || [], map = {}, out = [];
    for (var i = 0; i < vids.length; i++) { var n = vids[i].season == null ? 1 : vids[i].season; if (!map[n]) { map[n] = []; out.push(n); } map[n].push(vids[i]); }
    out.sort(function (a, b) { return (a === 0) - (b === 0) || a - b; }); // specials last
    for (var j = 0; j < out.length; j++) map[out[j]].sort(function (a, b) { return (a.episode || 0) - (b.episode || 0); });
    return { list: out, map: map };
  }
  function seasonOf(vid) { var p = String(vid || '').split(':'); return p.length > 2 ? parseInt(p[p.length - 2], 10) : 1; }
  // The trays are horizontal panels above the buttons: Episodes (seasons on top, episode cards
  // in a row), Sources (one tab per addon, source cards in a row), Audio (a row), Subtitles
  // (four columns side by side: in the file, OpenSubtitles, style, delay).
  // A tray: { kind, tabs, tab, zone ('tabs'|'row'|'cols'), row: [items], idx, cols: [{ title, items }], c, r: [] }
  function trayData() {
    var st = S, t = st.tray, o = st.o, i, it;
    t.tabs = null; t.cols = null; t.row = []; t.title = '';
    if (t.kind === 'subs') {
      var c1 = [], c2 = [], c3 = [], c4 = [];
      c1.push({ k: 'off', lb: T('Off'), on: st.curSub === 'off' });
      if (!st.isTrailer) {
        if (st.embLoading || st.embTracks === null) { c1.push({ k: 'sk' }); c1.push({ k: 'sk' }); }
        else if (!st.embTracks.length) c1.push({ k: 'note', lb: st.embErr || T('None in this file') });
        else for (i = 0; i < st.embTracks.length; i++) { var e = st.embTracks[i]; c1.push({ k: 'emb', n: e.n, lb: e.name || e.lang || ('#' + (e.n + 1)), on: st.curSub === 'emb:' + e.n }); }
      }
      var cnt = {}, seen = {};
      for (i = 0; i < st.extSubs.length; i++) cnt[st.extSubs[i].lang] = (cnt[st.extSubs[i].lang] || 0) + 1;
      for (i = 0; i < st.extSubs.length; i++) {
        var x = st.extSubs[i], L = x.lang; seen[L] = (seen[L] || 0) + 1;
        c2.push({ k: 'ext', u: x.u, lb: x.name + (cnt[L] > 1 ? '  ' + seen[L] : ''), on: st.curSub === 'ext:' + x.u });
      }
      if (!c2.length) { if (st.extLoading && !st.isTrailer) { c2.push({ k: 'sk' }); c2.push({ k: 'sk' }); c2.push({ k: 'sk' }); } else c2.push({ k: 'note', lb: T('None found') }); }
      var ci = SUB_COLORS.indexOf(lsGet('subsColor', '#ffffff').toLowerCase());
      c3.push({ k: 'size', lb: T('Size'), vl: SUB_SIZES[sizeIdx()] + '%' });
      c3.push({ k: 'color', lb: T('Colour'), vl: T(ci >= 0 ? SUB_COLOR_NAMES[ci] : 'White'), sw: ci >= 0 ? SUB_COLORS[ci] : '#ffffff' });
      c3.push({ k: 'bg', lb: T('Background'), vl: T(SUB_BG_NAMES[bgIdx()]) });
      if (st.curSub.indexOf('ext:') === 0) c4.push({ k: 'sync', lb: T('Auto-sync'), vl: st.syncSt || '' });
      c4.push({ k: 'dly', d: -0.5, lb: T('{n} s', { n: '−0.5' }) }); c4.push({ k: 'dly', d: 0.5, lb: T('{n} s', { n: '+0.5' }) }); c4.push({ k: 'dly', d: 0, lb: T('Reset') });
      t.cols = [{ title: st.isTrailer ? T('Subtitles') : T('In the file'), items: c1 }, { title: st.isTrailer ? T('Languages') : 'OpenSubtitles', items: c2 },
        { title: T('Style'), items: c3 }, { title: T('Delay'), vl: T('{n} s', { n: (st.subDelay > 0 ? '+' : '') + st.subDelay.toFixed(1) }), items: c4 }];
      if (st.isTrailer) { t.cols[0].items = c1.slice(0, 1).concat(c2[0].k === 'note' ? [] : c2); t.cols.splice(1, 1); }
    } else if (t.kind === 'aud') {
      t.title = T('Audio');
      try { var ts = st.v.audioTracks, sel = st.curAud;
        if (sel < 0) { for (i = 0; i < ts.length; i++) if (ts[i].enabled) { sel = i; break; } if (sel < 0 && ts.length) sel = 0; }
        for (i = 0; i < ts.length; i++) t.row.push({ k: 'aud', i: i, lb: ts[i].label || ts[i].language || (T('Audio') + ' ' + (i + 1)), sub: ts[i].language && ts[i].label ? ts[i].language : '', on: i === sel });
      } catch (e2) {}
      if (!t.row.length) t.row.push({ k: 'note', lb: T('None') });
    } else if (t.kind === 'eps') {
      var ss = seasons(); t.tabs = ss.list.map(function (n) { return n === 0 ? T('Specials') : T('Season {n}', { n: n }); });
      if (ss.list.indexOf(t.season) < 0) t.season = ss.list[0];
      t.tab = ss.list.indexOf(t.season); t.seasonList = ss.list;
      var eps = ss.map[t.season] || [], now = Date.now();
      for (i = 0; i < eps.length; i++) {
        var v = eps[i], up = v.released && new Date(v.released).getTime() > now;
        var th = v.thumbnail || (/^tt\d+$/.test(o.id) && v.episode != null ? 'https://episodes.metahub.space/' + o.id + '/' + v.season + '/' + v.episode + '/w300.jpg' : '');
        t.row.push({ k: 'ep', v: v, lb: (v.episode != null ? v.episode + '. ' : '') + (v.name || v.title || T('Episode {n}', { n: v.episode })),
          sub: (up ? T('Upcoming · {d}', { d: dateOf(v.released) }) : dateOf(v.released || v.firstAired)), ov: v.overview || v.description || '', th: th ? still(th) : '', on: v.id === st.vidId });
      }
    } else if (t.kind === 'src' || t.kind === 'epsrc') {
      var vid = t.kind === 'epsrc' ? t.vid : st.vidId;
      t.title = t.kind === 'epsrc' ? t.epLabel : T('Sources');
      if (!t.streams) loadStreams(t, vid);
      if (t.streams.length > 1) { t.tabs = t.streams.map(function (g) { return g.name; }); if (t.tab == null || t.tab >= t.tabs.length) t.tab = 0; }
      else t.tab = 0;
      var g = t.streams[t.tab || 0];
      if (g) for (i = 0; i < g.items.length; i++) { var s = g.items[i]; t.row.push({ k: 'src', s: s, lb: s.lb, sub: s.sub, on: s.url === st.o.url || s.url === st.alt || (!!st.o.sname && infoOf(s.raw).slice(0, 200) === String(st.o.sname).slice(0, 200) && (s.raw.addon || '') === (st.o.saddon || s.raw.addon || '')) }); }
      if (t.loading) t.row.push({ k: 'note', lb: T('Searching streams…'), spin: true });
      else if (!t.streams.length) t.row.push({ k: 'note', lb: T('No streams found.') });
    }
  }
  function loadStreams(t, vid) {
    var st = S, tok = {}, ck = st.srcCache || (st.srcCache = {}), hit = ck[vid];
    // opened again (Sources, an episode's sources): the lists from the last 10 min, not every addon asked and
    // parsed again on the TV (stress-flipping through them piled up work and memory)
    if (hit && Date.now() - hit.at < 600000) { t.streams = hit.streams; t.loading = false; return; }
    t.streams = []; t.loading = true; t.tok = tok;
    api.streams(st.o.type, vid, function (list, group) {
      if (S !== st || t.tok !== tok) return;
      var items = [];
      for (var i = 0; i < list.length && items.length < 30; i++) {
        var s = list[i]; if (!s || !s.url) continue;
        var nm = String(s.name || s.addon || '').replace(/\n+/g, '  ·  '), tt = String(s.title || s.description || '').split('\n').slice(0, 3).join('\n');
        items.push({ url: s.url, raw: s, lb: nm || group, sub: tt });
      }
      if (items.length) t.streams.push({ name: group || T('Addon'), items: items });
      soon();
    }, function () { if (S !== st || t.tok !== tok) return; t.loading = false;
      ck[vid] = { at: Date.now(), streams: t.streams }; var ks = Object.keys(ck); if (ks.length > 6) delete ck[ks[0]];
      soon(); });
    function soon() { if (t.rT) return; t.rT = setTimeout(function () { t.rT = null; if (S === st && S.tray === t) renderTray(false); }, 0); } // results may arrive while the tray is being drawn
  }
  function focusable(it) { return it && it.k !== 'note' && it.k !== 'sk'; }
  function firstOn(list) { var i; for (i = 0; i < list.length; i++) if (list[i].on && focusable(list[i])) return i; for (i = 0; i < list.length; i++) if (focusable(list[i])) return i; return -1; }
  function card(it) {
    if (it.k === 'sk') return '<div class="cd ch skel"><i></i></div>';
    if (it.k === 'note') return '<div class="nt">' + (it.spin ? '<span class="spn"></span>' : '') + esc(it.lb) + '</div>';
    if (it.k === 'ep') return '<div class="cd ep' + (it.on ? ' on' : '') + '"><div class="th"' + (it.th ? '' : ' style="background-image:url(&quot;' + esc(S.o.bg) + '&quot;)"') + '>' + (it.th ? '<img src="' + esc(it.th) + '">' : '') + (it.on ? '<span class="now">' + esc(T('Playing')) + '</span>' : '') + '</div>' +
      '<div class="a">' + esc(it.lb) + '</div>' + (it.sub ? '<div class="b">' + esc(it.sub) + '</div>' : '') + (it.ov ? '<div class="c">' + esc(it.ov) + '</div>' : '') + '</div>';
    if (it.k === 'src') return '<div class="cd sr' + (it.on ? ' on' : '') + '"><div class="a">' + esc(it.lb) + '</div>' + (it.sub ? '<div class="c">' + esc(it.sub).replace(/\n/g, '<br>') + '</div>' : '') + (it.on ? '<span class="now">' + esc(T('Playing')) + '</span>' : '') + '</div>';
    var tool = it.k === 'size' || it.k === 'color' || it.k === 'bg' || it.k === 'dly' || it.k === 'sync'; // settings, not choices: no tick
    return '<div class="cd ch' + (it.on ? ' on' : '') + (tool ? ' tl' : '') + '">' + (tool ? '' : '<span class="ck"></span>') + '<span class="a">' + esc(it.lb) + '</span>' + (it.sub ? '<span class="b">' + esc(it.sub) + '</span>' : '') +
      (it.sw ? '<i class="swc" style="background:' + it.sw + '"></i>' : '') + (it.vl ? '<span class="vl">' + esc(it.vl) + '</span>' : '') + '</div>';
  }
  function renderTray(fresh) {
    var st = S, t = st.tray, i, j, keep = trayCur();
    trayData();
    var hd = '';
    if (t.tabs) { for (i = 0; i < t.tabs.length; i++) hd += '<div class="tab">' + esc(t.tabs[i]) + '</div>'; hd = (t.kind === 'epsrc' ? '<div class="tt sm">' + esc(t.title) + '</div>' : '') + '<div class="tabs"><div class="tw">' + hd + '</div></div>'; }
    else if (t.title) hd = '<div class="tt">' + esc(t.title) + '</div>';
    if (E.hd._h !== hd) { E.hd._h = hd; E.hd.innerHTML = hd; } var tc = 'isl k-' + t.kind + (t.cols ? ' cols' : ' rowm'); if (E.tray.className !== tc) E.tray.className = tc;
    var h = '';
    if (t.cols) {
      for (i = 0; i < t.cols.length; i++) {
        var col = t.cols[i]; h += '<div class="col"><div class="ch2">' + esc(col.title) + (col.vl ? '<span>' + esc(col.vl) + '</span>' : '') + '</div><div class="cl"><div class="cin"><i class="cpl"></i>';
        for (j = 0; j < col.items.length; j++) h += card(col.items[j]);
        h += '</div></div></div>';
      }
    } else { for (i = 0; i < t.row.length; i++) h += card(t.row[i]); h += '<i class="ring"></i>'; }
    if (E.lin._h !== h) { E.lin._h = h; E.lin.innerHTML = h; } // (a 'var same' here shadowed same() below: every refresh threw before painting = focus gone)
    var imgs = E.lin.getElementsByTagName('img'); // a missing still: the show's backdrop instead
    for (i = 0; i < imgs.length; i++) imgs[i].onerror = function () { var p = this.parentNode; if (p) { p.style.backgroundImage = 'url("' + String(st.o.bg).replace(/"/g, '%22') + '")'; p.removeChild(this); } };
    // keep the focus on the same entry across refreshes (tracks arriving, a choice made)
    function same(a, b) { return a && b && a.k === b.k && a.lb === b.lb && a.u === b.u && a.n === b.n && a.v === b.v && a.d === b.d; }
    if (t.cols) {
      if (!t.r || t.r.length !== t.cols.length) { t.r = []; for (i = 0; i < t.cols.length; i++) t.r.push(firstOn(t.cols[i].items)); }
      for (i = 0; i < t.cols.length; i++) { if (!focusable(t.cols[i].items[t.r[i]])) t.r[i] = firstOn(t.cols[i].items); if (!fresh && keep) for (j = 0; j < t.cols[i].items.length; j++) if (same(t.cols[i].items[j], keep)) { t.c = i; t.r[i] = j; } }
      if (t.c == null || t.r[t.c] < 0) { t.c = 0; for (i = 0; i < t.cols.length; i++) if (t.r[i] >= 0) { t.c = i; break; } }
      t.zone = 'cols';
    } else {
      var idx = -1;
      if (!fresh && keep) for (i = 0; i < t.row.length; i++) if (same(t.row[i], keep)) { idx = i; break; }
      if (idx < 0 && !fresh && focusable(t.row[t.idx])) idx = t.idx;
      if (idx < 0) idx = firstOn(t.row);
      t.idx = idx;
      if (t.zone !== 'tabs' || !t.tabs) t.zone = idx >= 0 ? 'row' : (t.tabs ? 'tabs' : 'row');
    }
    paintTray();
  }
  function trayCur() { var t = S.tray; if (!t) return null; if (t.cols) return t.cols[t.c] && t.cols[t.c].items[t.r[t.c]]; return t.row && t.row[t.idx]; }
  function paintTray() {
    var st = S, t = st.tray, i, j;
    var tabs = E.hd.getElementsByClassName('tab');
    for (i = 0; i < tabs.length; i++) tabs[i].className = 'tab' + (i === t.tab ? ' on' : '') + (t.zone === 'tabs' && i === t.tab ? ' f' : '');
    var tw = E.hd.getElementsByClassName('tw')[0], ct = tabs[t.tab]; // the chosen tab stays in view
    if (tw && ct) { var vw = tw.parentNode.offsetWidth, x = Math.max(0, Math.min(ct.offsetLeft + ct.offsetWidth / 2 - vw / 2, tw.offsetWidth - vw)); tw.style.webkitTransform = tw.style.transform = 'translateX(' + (-x) + 'px)'; }
    if (t.cols) {
      // columns never scroll sideways: drop the offset a scrolled Sources / Episodes row left behind
      // (it put the subtitle columns off to the left = a blank tray until a row tray reset it)
      if (E.lin._x !== 0) { E.lin._x = 0; E.lin.style.webkitTransform = E.lin.style.transform = ''; }
      var cols = E.lin.children;
      for (i = 0; i < cols.length; i++) {
        var cards = cols[i].getElementsByClassName('cd'), cin = cols[i].getElementsByClassName('cin')[0], items = t.cols[i].items, k = 0, fe = null;
        cols[i].className = 'col' + (i === t.c ? ' cur' : '');
        for (j = 0; j < items.length; j++) { if (items[j].k === 'note') continue; var el = cards[k++]; if (!el) continue; if (!el._base) el._base = el.className; var f = !t.onBtn && i === t.c && j === t.r[i]; el.className = el._base + (f ? ' f' : ''); if (j === t.r[i]) fe = el; }
        var y = 0, hgt = cin.parentNode.offsetHeight; if (fe && cin.offsetHeight > hgt) y = Math.max(0, Math.min(fe.offsetTop - hgt / 2 + fe.offsetHeight / 2, cin.offsetHeight - hgt));
        // the column's plate glides to its focused item (only the current column shows it: moving across
        // columns it fades out here and in there)
        var pl = cin.getElementsByClassName('cpl')[0];
        if (pl) { var pon = !!fe && i === t.c && !t.onBtn;
          if (pon) { if (pl._h !== fe.offsetHeight) { pl._h = fe.offsetHeight; pl.style.height = fe.offsetHeight + 'px'; }
            var tv = 'translateY(' + fe.offsetTop + 'px)';
            if (pl.className !== 'cpl on') { pl.style.webkitTransition = pl.style.transition = 'none'; pl.style.webkitTransform = pl.style.transform = tv; void pl.offsetWidth; pl.style.webkitTransition = pl.style.transition = ''; pl.className = 'cpl on'; }
            else pl.style.webkitTransform = pl.style.transform = tv;
          } else if (pl.className !== 'cpl') pl.className = 'cpl'; }
        cin.style.webkitTransform = cin.style.transform = 'translateY(' + (-y) + 'px)';
      }
      return;
    }
    var rows = E.lin.children, fi = null;
    var ring = null;
    for (i = 0; i < rows.length; i++) { var r = rows[i]; if (r.className === 'ring' || r._ring) { ring = r; r._ring = true; continue; } if (!r._base) r._base = r.className; var on = t.zone === 'row' && !t.onBtn && i === t.idx; r.className = r._base + (on ? ' f' : ''); if (i === t.idx) fi = r; }
    // one white outline slides to the focused card (transform only; the cards never repaint)
    if (ring) { if (fi && t.zone === 'row' && !t.onBtn && fi.className.indexOf('nt') < 0) { if (ring._w !== fi.offsetWidth || ring._h !== fi.offsetHeight) { ring._w = fi.offsetWidth; ring._h = fi.offsetHeight; ring.style.width = ring._w + 'px'; ring.style.height = ring._h + 'px'; }
      ring.style.webkitTransform = ring.style.transform = 'translate(' + fi.offsetLeft + 'px,' + fi.offsetTop + 'px)'; ring.className = 'ring on'; } else ring.className = 'ring'; }
    var xx = 0, w = E.lst.offsetWidth; // the focused card sits second from the left, the row never shows empty space at its end
    if (fi) { var prev = rows[Math.max(0, t.idx - 1)]; xx = Math.max(0, Math.min(t.idx > 0 ? prev.offsetLeft - 8 : 0, E.lin.scrollWidth - w)); }
    E.lin._x = xx; E.lin.style.webkitTransform = E.lin.style.transform = 'translateX(' + (-xx) + 'px)';
  }
  function stepIn(list, from, d) { for (var i = from + d; i >= 0 && i < list.length; i += d) if (focusable(list[i])) return i; return -1; }
  function trayKey(k) {
    var st = S, t = st.tray;
    if (t.onBtn) { // focus on the tray's own button: OK closes the tray (OK there again opens it)
      if (k === 13) closeTray();
      else if (k === 38) { t.onBtn = false; paintTray(); }
      else if (k === 37 || k === 39) { closeTray(); st.bIdx = k === 39 ? Math.min(st.btns.length - 1, st.bIdx + 1) : Math.max(0, st.bIdx - 1); paintBtns(); }
      return true;
    }
    if (t.zone === 'tabs') {
      if ((k === 37 && t.tab > 0) || (k === 39 && t.tab < t.tabs.length - 1)) {
        t.tab += k === 39 ? 1 : -1; if (t.kind === 'eps') t.season = t.seasonList[t.tab];
        t.idx = -1; renderTray(true); t.zone = 'tabs'; paintTray();
      } else if ((k === 40 || k === 13) && t.idx >= 0) { t.zone = 'row'; paintTray(); }
      else if (k !== 13) nudge(E.hd, k);
      return true;
    }
    if (t.zone === 'cols') {
      var col = t.cols[t.c];
      if (k === 38 || k === 40) { var n = stepIn(col.items, t.r[t.c], k === 40 ? 1 : -1); if (n >= 0) { t.r[t.c] = n; paintTray(); } else if (k === 40) { t.onBtn = true; paintTray(); } else nudge(E.lin.children[t.c], k); }
      else if (k === 37 || k === 39) { var c0 = t.c; for (var c = t.c + (k === 39 ? 1 : -1); c >= 0 && c < t.cols.length; c += k === 39 ? 1 : -1) if (t.r[c] >= 0) { t.c = c; paintTray(); break; } if (t.c === c0) nudge(E.lin.children[c0], k); }
      else if (k === 13) choose(trayCur());
      return true;
    }
    if (k === 37) { var a = stepIn(t.row, t.idx, -1); if (a >= 0) { t.idx = a; paintTray(); } else nudge(E.lst, k); }
    else if (k === 39) { var b = stepIn(t.row, t.idx, 1); if (b >= 0) { t.idx = b; paintTray(); } else nudge(E.lst, k); }
    else if (k === 38) { if (t.tabs) { t.zone = 'tabs'; paintTray(); } else nudge(E.lst, k); }
    else if (k === 40) { t.onBtn = true; paintTray(); }
    else if (k === 13 && trayCur()) choose(trayCur());
    return true;
  }
  function choose(it) {
    var st = S, t = st.tray; if (!it) return;
    if (it.k === 'off') subsOff();
    else if (it.k === 'emb') setEmbSub(it.n);
    else if (it.k === 'ext') setExtSub(it.u);
    else if (it.k === 'size' || it.k === 'color' || it.k === 'bg') adjust(it, 1);
    else if (it.k === 'dly') { st.subDelay = it.d ? Math.round((st.subDelay + it.d) * 10) / 10 : 0; if (!it.d && st.cuesOrig) { st.cues = st.cuesOrig; st.cuesOrig = null; st.syncSt = ''; } restyle(); renderTray(false); }
    else if (it.k === 'sync') runSync();
    else if (it.k === 'aud') { setAudio(it.i); renderTray(false); }
    else if (it.k === 'ep') { // an episode: its sources, right here
      var v = it.v; t.backIdx = t.idx; t.backTab = t.tab; t.kind = 'epsrc'; t.vid = v.id; t.streams = null; t.idx = -1; t.tab = 0; t.zone = 'row';
      t.epLabel = 'S' + v.season + ':E' + v.episode + '  ·  ' + (v.name || v.title || ''); renderTray(true);
    } else if (it.k === 'src') {
      var same = t.kind === 'src', vid = same ? st.vidId : t.vid;
      api.play(it.s.raw, { type: st.o.type, id: st.o.id, vid: vid, startAt: same && st.v ? st.v.currentTime : 0 });
    }
  }
  function adjust(it, d) {
    if (it.k === 'size') lsPut('subtitleSize', String((sizeIdx() + d + SUB_SIZES.length) % SUB_SIZES.length));
    else if (it.k === 'color') { var ci = SUB_COLORS.indexOf(lsGet('subsColor', '#ffffff').toLowerCase()); lsPut('subsColor', SUB_COLORS[((ci < 0 ? 0 : ci) + d + SUB_COLORS.length) % SUB_COLORS.length]); }
    else if (it.k === 'bg') lsPut('subsBgStyle', SUB_BGS[(bgIdx() + d + SUB_BGS.length) % SUB_BGS.length]);
    restyle(); renderTray(false);
  }

  // ---------------------------------------------------------------- Magic Remote pointer
  // Moving brings the controls; pointing at a button, the bar, a prompt or a tray card highlights it, and a
  // click acts there as OK does: on the bar it seeks to that spot on release (a bubble shows the time under the
  // pointer), on the picture it plays / pauses, beside an open tray it puts the tray away. The wheel arrives
  // as the Up/Down arrows (index.html).
  function nudge(el, k) { if (window.sbNudge) window.sbNudge(el, k); } // the app's edge push (an arrow that leads nowhere)
  function ptrIn(t, el) { for (var n = t; n; n = n.parentNode) if (n === el) return true; return false; }
  function ptrHv(x) { // the time under the pointer, over the bar
    var st = S, v = st.v, on = x != null && v && v.duration && v.duration !== Infinity;
    if (on) { var r = E.trk.getBoundingClientRect(), p = Math.max(0, Math.min(1, (x - r.left) / (r.width || 1))), tx = fmt(p * v.duration);
      if (E.hv._t !== tx) { E.hv._t = tx; E.hv.firstChild.textContent = tx; }
      E.hv.style.webkitTransform = E.hv.style.transform = 'translateX(' + Math.round(p * r.width) + 'px)'; E.hv._p = p; }
    var c = on ? 'hv on' : 'hv'; if (E.hv.className !== c) E.hv.className = c;
  }
  function ptrTray(t, down) {
    var st = S, tr = st.tray, i, j, tabs = E.hd.getElementsByClassName('tab');
    for (i = 0; i < tabs.length; i++) if (ptrIn(t, tabs[i])) {
      if (down && i !== tr.tab) { tr.tab = i; if (tr.kind === 'eps') tr.season = tr.seasonList[i]; tr.idx = -1; renderTray(true); tr.zone = 'tabs'; paintTray(); }
      return; }
    var ch = E.lin.children;
    if (tr.cols) {
      for (i = 0; i < ch.length; i++) if (ptrIn(t, ch[i])) {
        var cards = ch[i].getElementsByClassName('cd'), items = tr.cols[i].items, k = 0;
        for (j = 0; j < items.length; j++) { if (items[j].k === 'note') continue; var el = cards[k++];
          if (el && ptrIn(t, el)) { if (!focusable(items[j])) return;
            if (tr.c !== i || tr.r[i] !== j || tr.onBtn) { tr.c = i; tr.r[i] = j; tr.onBtn = false; tr.zone = 'cols'; paintTray(); }
            if (down) choose(items[j]); return; } }
        return; }
      return; }
    for (i = 0; i < ch.length; i++) { var r = ch[i]; if (r._ring || r.className === 'ring') continue;
      if (ptrIn(t, r)) { if (!focusable(tr.row[i])) return;
        if (tr.idx !== i || tr.zone !== 'row' || tr.onBtn) { tr.idx = i; tr.zone = 'row'; tr.onBtn = false; paintTray(); }
        if (down) choose(tr.row[i]); return; } }
  }
  function ptr(type, t, x, y) {
    var st = S; if (!st || st.closing || !st.v) return; // the art is up (resolving): nothing to point at
    if (x != null) { st.px = x; st.py = y; }
    if (type === 'up') { // the bar seeks on release, where the pointer is then
      if (st.barDown && ptrIn(t, E.trk.parentNode)) { ptrHv(x); if (E.hv._p != null && st.v.duration && st.v.duration !== Infinity) { st.seekT = E.hv._p * st.v.duration; cls('sk', false); commitSeek(); paintBar(); } }
      st.barDown = false; return;
    }
    var down = type === 'down', i;
    if (st.mode === 'tray') {
      if (ptrIn(t, E.tray)) { ptrTray(t, down); return; }
      if (down) { var ob = st.tray.btn; closeTray(); // beside the tray: it goes away (on another button: that one acts)
        for (i = 0; i < st.btns.length; i++) if (st.btns[i].id !== ob && ptrIn(t, st.btns[i].el)) { st.row = 'btns'; st.bIdx = i; paintBtns(); act(st.btns[i].id); } }
      return;
    }
    var p = st.prompt;
    if (p && ptrIn(t, E.prompt)) { // skip intro / recap, the next-up card (all of it)
      var pi = -1, pe = E.prompt.children;
      if (p.k === 'outro' && st.o.next) pi = p.btns.length - 1; else for (i = 0; i < pe.length; i++) if (ptrIn(t, pe[i])) pi = i;
      if (pi >= 0) { if (st.mode !== 'prompt' || st.promptIdx !== pi) { if (st.mode === 'video') showOsd(true); st.mode = 'prompt'; st.promptIdx = pi; paintBtns(); paintPrompt(); }
        ptrHv(null); if (down) promptGo(p.btns[pi]); return; }
    }
    if (st.mode === 'video' || st.mode === 'prompt') { if (st.mode === 'prompt') st.mode = 'video'; showOsd(true); } else armHide(); // moving brings the controls
    for (i = 0; i < st.btns.length; i++) if (ptrIn(t, st.btns[i].el)) {
      if (st.row !== 'btns' || st.bIdx !== i) { st.row = 'btns'; st.bIdx = i; paintBtns(); paintPrompt(); }
      ptrHv(null); if (down) act(st.btns[i].id); return; }
    if (ptrIn(t, E.trk.parentNode)) { // the bar, its times included (the track alone is a few pixels high)
      if (st.row !== 'bar') { st.row = 'bar'; paintBtns(); }
      ptrHv(x); if (down) st.barDown = true;
      return; }
    ptrHv(null);
    if (down) { if (st.seekT >= 0) commitSeek(); else toggle(); showOsd(true); } // the picture: play / pause
  }

  // ---------------------------------------------------------------- next episode, closest source
  // "Next episode" plays the next one straight away from the source most like the current one:
  // same addon, resolution, HDR, audio, release group, debrid vs torrent. The art covers the
  // switch; with no source at all it falls back to the title page's list.
  function infoOf(s) { var bh = s.behaviorHints || {}; return String([s.name || s.addon || '', s.title || '', s.description || '', bh.filename || ''].join(' ')).replace(/\s+/g, ' ').trim(); }
  function relGroup(s) { var m = /-([a-z0-9]{2,12})(?:\.(?:mkv|mp4|avi))?(?:\s|$)/i.exec(s); return m ? m[1].toLowerCase() : ''; }
  function srcKind(s) { s = s.toLowerCase(); return /remux/.test(s) ? 'remux' : /blu-?ray|bdrip|brrip/.test(s) ? 'bluray' : /web-?dl|webrip|\bweb\b|amzn|nf\b|dsnp|hmax|atvp/.test(s) ? 'web' : /hdtv/.test(s) ? 'tv' : ''; }
  function likeness(cur, s) {
    var a = cur.info, b = infoOf(s), sc = 0;
    if (cur.addon && (s.addon || '') === cur.addon) sc += 20;
    var r1 = resOf(a), r2 = resOf(b), RS = ['SD', '720p', '1080p', '1440p', '4K'];
    if (r1 && r1 === r2) sc += 30; else if (r1 && r2) sc -= 12 * Math.abs(RS.indexOf(r1) - RS.indexOf(r2));
    if (hdrOf(a) === hdrOf(b)) sc += 12;
    var a1 = audioOf(a).split(' ')[0], a2 = audioOf(b).split(' ')[0]; if (a1 && a1 === a2) sc += 10;
    var g1 = relGroup(a), g2 = relGroup(b); if (g1 && g1 === g2) sc += 25;
    var k1 = srcKind(a), k2 = srcKind(b); if (k1 && k1 === k2) sc += 10;
    var c1 = /\[[a-z]{2,3}\+\]|⚡|cached/i.test(a), c2 = /\[[a-z]{2,3}\+\]|⚡|cached/i.test(b); if (c1 === c2) sc += c1 ? 15 : 5;
    var p1 = /127\.0\.0\.1:8080\/p2p/.test(cur.url), p2 = /127\.0\.0\.1:8080\/p2p/.test(s.url || ''); sc += p1 === p2 ? 15 : -15;
    var h1 = /[?&]ih=([0-9a-f]{40})/i.exec(cur.url) || /\/torrents\/([0-9a-f]{40})\//i.exec(cur.url), h2 = /[?&]ih=([0-9a-f]{40})/i.exec(s.url || '');
    if (h1 && h2 && h1[1].toLowerCase() === h2[1].toLowerCase()) sc += 60; // the same season pack: the next file of the very same torrent
    return sc;
  }
  function nextAuto() {
    var st = S, o = st.o; if (!o.next) return goNext();
    markWatched(); saveProgress(); pushLib(true);
    var cur = { info: o.sname || '', url: /127\.0\.0\.1:8080\/p2p/.test(st.alt) ? st.alt : (o.url || ''), addon: o.saddon || '' }, nv = o.next.vid, type = o.type, id = o.id;
    var p = String(nv).split(':');
    prepare({ type: type, id: id, vid: nv, name: o.name, dname: o.dname, logo: o.logo, logoEn: o.logoEn, bg: o.bg, poster: o.poster, videos: o.videos, season: p[p.length - 2], episode: p[p.length - 1] });
    var st2 = S, best = null, bs = -1e9, done = false;
    setStatus(T('Finding the closest source…'));
    function finish() {
      if (done || S !== st2) return; done = true;
      if (best) api.play(best, { type: type, id: id, vid: nv, startAt: 0 });
      else close({ go: function () { api.onNext({ type: type, id: id, vid: nv }); } });
    }
    api.streams(type, nv, function (list) {
      if (S !== st2 || done) return;
      for (var i = 0; i < list.length; i++) { var s = list[i]; if (!s || !s.url) continue; var v = likeness(cur, s); if (v > bs) { bs = v; best = s; } }
      if (bs >= 95) finish(); // same addon, quality, group: no need to wait for the slow ones
    }, finish);
    later(finish, 15000);
  }

  return {
    prepare: prepare, start: start, status: setStatus, fail: fail, updateArt: updateArt,
    close: function () { close(); }, back: back, key: key, ptr: ptr,
    isOpen: function () { return isOpen; },
    // remote-debug hooks (CDP, preview): read state; try the skip prompts with given segments
    skipsForTest: function (sk) { if (S) { sk.ok = true; S.skips = sk; S.dismissed = {}; checkPrompt(); paintMarks(); } },
    debug: function () { var st = S; return st ? { aspect: st.aspect, mode: st.mode, cur: st.curSub, cues: st.cues ? st.cues.length : null, t: st.v ? st.v.currentTime : -1, paused: st.v ? st.v.paused : null, tracks: st.embTracks, prompt: st.prompt && st.prompt.k, skips: st.skips } : null; }
  };
};
})();
