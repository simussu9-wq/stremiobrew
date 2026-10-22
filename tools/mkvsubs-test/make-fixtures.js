// Builds the MKV fixtures for tools/mkvsubs-test/run.js (needs ffmpeg on PATH or $FFMPEG).
//   node tools/mkvsubs-test/make-fixtures.js <out dir> [minutes]
// sample.mkv: video + English SRT (a line every 3 s) + French ASS (dialogue at the bottom
// and a positioned "sign" at the top every 20 s, overlapping the dialogue) + Arabic SRT.
// nocues.mkv: the same streams remuxed with no Cues element at all (fallback path).
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var out = process.argv[2], mins = parseFloat(process.argv[3] || '6');
var FF = process.env.FFMPEG || 'ffmpeg';
if (!out) { console.error('usage: make-fixtures.js <out dir> [minutes]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
var dur = Math.round(mins * 60);
function srtT(s) { var ms = Math.round(s * 1000), h = (ms / 3600000) | 0; ms -= h * 3600000; var m = (ms / 60000) | 0; ms -= m * 60000; var x = (ms / 1000) | 0; ms -= x * 1000;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x + ',' + ('00' + ms).slice(-3); }
function assT(s) { var cs = Math.round(s * 100), h = (cs / 360000) | 0; cs -= h * 360000; var m = (cs / 6000) | 0; cs -= m * 6000; var x = (cs / 100) | 0; cs -= x * 100;
  return h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x + '.' + (cs < 10 ? '0' : '') + cs; }
var en = [], ar = [], n = 0;
for (var t = 1; t + 2 < dur; t += 3) {
  n++;
  en.push(n + '\n' + srtT(t) + ' --> ' + srtT(t + 2.2) + '\nLine ' + n + ' at ' + t + 's' + (n % 5 === 0 ? '\n<i>second line, italic</i>' : '') + '\n');
  ar.push(n + '\n' + srtT(t) + ' --> ' + srtT(t + 2.2) + '\nالسطر ' + n + ' عند ' + t + ' ثانية\n');
}
var ass = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,30,1',
  'Style: Sign,Arial,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,20,20,30,1',
  '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
n = 0;
for (t = 1; t + 2 < dur; t += 3) {
  n++;
  ass.push('Dialogue: 0,' + assT(t) + ',' + assT(t + 2.2) + ',Default,,0,0,0,,Réplique ' + n + ' à ' + t + 's' + (n % 4 === 0 ? '\\N{\\i1}en italique{\\i0}' : ''));
  if (n % 7 === 0) ass.push('Dialogue: 1,' + assT(t) + ',' + assT(t + 6) + ',Sign,,0,0,0,,{\\pos(320,120)}PANNEAU ' + n);
}
fs.writeFileSync(path.join(out, 'en.srt'), en.join('\n'));
fs.writeFileSync(path.join(out, 'ar.srt'), ar.join('\n'));
fs.writeFileSync(path.join(out, 'fr.ass'), ass.join('\n') + '\n');
function run(args) { var r = cp.spawnSync(FF, args, { stdio: ['ignore', 'ignore', 'pipe'] }); if (r.status !== 0) { console.error(String(r.stderr).slice(-2000)); process.exit(1); } }
run(['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-i', path.join(out, 'en.srt'), '-i', path.join(out, 'fr.ass'), '-i', path.join(out, 'ar.srt'),
  '-t', String(dur), '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-map', '4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-b:v', '1500k', '-c:a', 'aac', '-b:a', '96k', '-c:s:0', 'srt', '-c:s:1', 'ass', '-c:s:2', 'srt',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
  '-metadata:s:s:1', 'language=fre', '-metadata:s:s:1', 'title=Français (signs)',
  '-metadata:s:s:2', 'language=ara',
  '-metadata:s:a:0', 'language=eng', path.join(out, 'sample.mkv')]);
// no Cues: matroska muxer skips the index when the output isn't seekable
var r = cp.spawnSync('sh', ['-c', '"' + FF + '" -y -hide_banner -i "' + path.join(out, 'sample.mkv') + '" -map 0 -c copy -f matroska - > "' + path.join(out, 'nocues.mkv') + '"'], { stdio: ['ignore', 'ignore', 'pipe'] });
if (r.status !== 0) { console.error(String(r.stderr).slice(-2000)); process.exit(1); }
console.log('fixtures in ' + out + ': sample.mkv (' + (fs.statSync(path.join(out, 'sample.mkv')).size / 1e6).toFixed(1) + ' MB), nocues.mkv; ' + en.length + ' lines per track');
