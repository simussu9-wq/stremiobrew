#!/bin/bash
# Builds the installable IPK (app + helper service) into dist/.
# Nothing prebuilt is needed: the helper runs on the TV's own Node, and the only
# binary — a minimal LGPL ffmpeg — is built from source by tools/build-ffmpeg.sh
# (set ZIG=/path/to/zig if zig isn't on PATH).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG="$ROOT/dist/bin/ffmpeg"
[ -f "$FFMPEG" ] || "$ROOT/tools/build-ffmpeg.sh"
NUVIO="$ROOT/dist/bin/nuvio-bridge"
# the P2P engine: nuvio-engine behind tools/nuvio/nuvio-bridge.cpp (tools/build-nuvio.sh); rebuilt if missing
grep -qs stremiobrew "$ROOT/dist/bin/nuvio-bridge.version" && [ -f "$NUVIO" ] || "$ROOT/tools/build-nuvio.sh"


STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/app" "$STAGE/service/bin"
cp "$ROOT"/app/{appinfo.json,index.html,player.js,player.css,i18n.js,icon.png,logo.png,splashicon.png,splashbg.jpg} "$STAGE/app/"
cp -R "$ROOT/app/i18n" "$STAGE/app/"
cp "$ROOT"/app/fonts.css "$STAGE/app/"; mkdir -p "$STAGE/app/fonts"; cp "$ROOT"/app/fonts/*.woff2 "$ROOT"/app/fonts/LICENSE.txt "$STAGE/app/fonts/"
cp "$ROOT"/service/{launch.js,package.json,services.json,tvserver.js,mkvsubs.js,qrcode.js,cacert.pem} "$STAGE/service/"
cp -R "$ROOT/service/licenses" "$STAGE/service/"
cp "$ROOT/dist/bin/ffmpeg.buildinfo" "$STAGE/service/licenses/FFMPEG-BUILD-INFO.txt"
cp "$FFMPEG" "$STAGE/service/bin/ffmpeg"; chmod 755 "$STAGE/service/bin/ffmpeg"
cp "$NUVIO" "$STAGE/service/bin/nuvio-bridge"; chmod 755 "$STAGE/service/bin/nuvio-bridge"
# nuvio-engine is GPL-3.0-or-later; libtorrent BSD-3-Clause; Boost BSL-1.0
NS="$ROOT/.build-nuvio"
cp "$NS/nuvio-src/LICENSE" "$STAGE/service/licenses/NUVIO-ENGINE-GPL-3.0.txt"
cp "$NS/nuvio-src/THIRD_PARTY_NOTICES.md" "$STAGE/service/licenses/NUVIO-ENGINE-THIRD-PARTY-NOTICES.md"
cp "$NS/deps/nuvio_libtorrent-src/LICENSE" "$STAGE/service/licenses/LIBTORRENT-BSD.txt"
cp "$NS/deps/nuvio_boost-src/LICENSE_1_0.txt" "$STAGE/service/licenses/BOOST-BSL-1.0.txt"

# compilers keep build paths (the builder's home folder) in binaries and in the ffmpeg build info:
# swapped for a neutral same-length path, and the package is refused if anything personal is left
python3 "$ROOT/tools/scrub-paths.py" --root "$ROOT" "$STAGE/service/bin/ffmpeg" "$STAGE/service/bin/nuvio-bridge" "$STAGE/service/licenses/FFMPEG-BUILD-INFO.txt"
if grep -rl -e "$HOME" -e "$(basename "$HOME")@" "$STAGE" >/dev/null 2>&1; then echo "personal path still in the package:"; grep -rl -e "$HOME" "$STAGE"; exit 1; fi

mkdir -p "$ROOT/dist"
ares-package -n -o "$ROOT/dist" "$STAGE/app" "$STAGE/service"
ls -l "$ROOT"/dist/*.ipk
