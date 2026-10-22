// Static file server with HTTP Range, for testing service/mkvsubs.js on the Mac.
//   node tools/mkvsubs-test/range-server.js <dir> [port]
// Path prefixes change the behaviour:  /slow/<file>  adds 150 ms per request (a CDN far away)
//                                      /norange/<file> ignores Range (always 200, whole file)
//                                      /cut/<file>  ends every response after 300 bytes
// GET /__stats returns { requests, bytes } since the last /__reset.
'use strict';
var http = require('http'), fs = require('fs'), path = require('path');
var dir = process.argv[2], port = parseInt(process.argv[3] || '8897', 10);
if (!dir) { console.error('usage: range-server.js <dir> [port]'); process.exit(2); }
var stats = { requests: 0, bytes: 0 };
var TYPES = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.webm': 'video/webm' };
http.createServer(function (req, res) {
  var u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/__stats') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify(stats)); }
  if (u === '/__reset') { stats = { requests: 0, bytes: 0 }; res.writeHead(200); return res.end('ok'); }
  var mode = '', m = /^\/(slow|norange|cut)(\/.*)$/.exec(u);
  if (m) { mode = m[1]; u = m[2]; }
  var file = path.join(dir, path.normalize(u).replace(/^(\.\.[\/\\])+/, ''));
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    stats.requests++;
    var size = st.size, start = 0, end = size - 1, code = 200;
    var r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (r && mode !== 'norange') {
      if (r[1] === '') { start = Math.max(0, size - parseInt(r[2], 10)); } else { start = parseInt(r[1], 10); if (r[2] !== '') end = Math.min(size - 1, parseInt(r[2], 10)); }
      if (start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      code = 206;
    }
    var hdr = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Access-Control-Allow-Origin': '*' };
    if (code === 206) hdr['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    function send() {
      res.writeHead(code, hdr);
      if (req.method === 'HEAD') return res.end();
      var s = fs.createReadStream(file, { start: start, end: mode === 'cut' ? Math.min(end, start + 299) : end });
      s.on('data', function (d) { stats.bytes += d.length; });
      s.pipe(res);
      if (mode === 'cut') s.on('end', function () { res.destroy(); });
    }
    if (mode === 'slow') setTimeout(send, 150); else send();
  });
}).listen(port, '127.0.0.1', function () { console.log('range server on http://127.0.0.1:' + port + '/ serving ' + dir); });
