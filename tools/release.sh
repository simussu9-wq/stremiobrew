#!/bin/bash
# A release in one step:  tools/release.sh VERSION [site-dir]
# Sets the version (app + helper), builds the IPK (tools/package.sh) and writes the Homebrew Channel files
# into the site folder - the GitHub Pages repository users add to the Homebrew Channel:
#   <id>_<version>_all.ipk, api/apps/<id>/manifest.json (+ releases/latest.json, full_description.html)
#   and the repository list (apps.json + api/apps.json). Review, commit, push: the Homebrew Channel offers
#   the update once GitHub Pages has republished (a minute or two). The version must go up every time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:?usage: tools/release.sh VERSION [site-dir]}"
SITE="${2:-$ROOT/../stremiobrew-publish}"
ID=tv.stremiobrew.app
BASE="https://simussu9-wq.github.io/stremiobrew"
SRC="https://github.com/simussu9-wq/stremiobrew"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 2.0.1"; exit 1; }
[ -d "$SITE" ] || { echo "site folder not found: $SITE"; exit 1; }

python3 - "$ROOT" "$VER" <<'EOF'
import json, sys
root, ver = sys.argv[1], sys.argv[2]
for f in ('app/appinfo.json', 'service/package.json'):
    p = root + '/' + f; j = json.load(open(p)); j['version'] = ver
    open(p, 'w').write(json.dumps(j, indent=2, ensure_ascii=False) + '\n')
EOF

rm -f "$ROOT/dist/${ID}_${VER}_all.ipk"
"$ROOT/tools/package.sh"
IPK="$ROOT/dist/${ID}_${VER}_all.ipk"
[ -f "$IPK" ] || { echo "no $IPK"; exit 1; }
SHA=$(shasum -a 256 "$IPK" | cut -d' ' -f1)

rm -f "$SITE"/${ID}_*_all.ipk
cp "$IPK" "$SITE/"
python3 - "$SITE" "$ID" "$VER" "$SHA" "$BASE" "$SRC" <<'EOF'
import json, os, sys
site, pid, ver, sha, base, src = sys.argv[1:]
short = 'Stremio-compatible client for rooted LG webOS TVs (webOS 3+)'
manifest = {
  'id': pid, 'version': ver, 'type': 'web', 'title': 'StremioBrew',
  'appDescription': short + ': your own account and addons, debrid and P2P playback, subtitles, 11 languages. Unofficial.',
  'iconUri': base + '/icon.png', 'sourceUrl': src, 'rootRequired': True,
  'ipkUrl': '%s/%s_%s_all.ipk' % (base, pid, ver), 'ipkHash': {'sha256': sha}}
d = os.path.join(site, 'api', 'apps', pid)
os.makedirs(os.path.join(d, 'releases'), exist_ok=True)
for f in (os.path.join(d, 'manifest.json'), os.path.join(d, 'releases', 'latest.json')):
    open(f, 'w').write(json.dumps(manifest, indent=2) + '\n')
listing = {'paging': {'page': 1, 'count': 1, 'maxPage': 1, 'itemsTotal': 1}, 'packages': [{
  'id': pid, 'title': 'StremioBrew', 'iconUri': base + '/icon.png', 'pool': 'main',
  'manifestUrl': '%s/api/apps/%s/manifest.json' % (base, pid), 'shortDescription': short + '.',
  'fullDescriptionUrl': 'apps/%s/full_description.html' % pid, 'manifest': manifest}]}
open(os.path.join(site, 'api', 'apps.json'), 'w').write(json.dumps(listing, indent=2) + '\n')
listing['packages'][0]['fullDescriptionUrl'] = 'api/' + listing['packages'][0]['fullDescriptionUrl'] # same list at the root: paths from there
open(os.path.join(site, 'apps.json'), 'w').write(json.dumps(listing, indent=2) + '\n')
open(os.path.join(d, 'full_description.html'), 'w').write(
  '<p><b>StremioBrew</b> &mdash; an unofficial, Stremio-compatible client for older <b>rooted</b> LG webOS TVs (webOS 3 and later).</p>\n'
  '<p>Bring your own Stremio account and addons: the app ships empty and plays only the links your addons return. '
  'Debrid and P2P playback, embedded and external subtitles with auto-sync, skip intro/credits, 11 languages.</p>\n'
  '<p>Requires a rooted TV with the Homebrew Channel, webOS 3.0 or later on 32-bit ARM; tested on webOS 4.4. Not affiliated with Stremio.</p>\n'
  '<p>Source: <a href="%s">%s</a></p>\n' % (src, src))
print('site updated:', pid, ver, sha)
EOF
ls -l "$SITE"/${ID}_*_all.ipk
