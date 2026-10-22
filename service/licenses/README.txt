Third-party components bundled in this package
==============================================

1. FFmpeg 7.1.1  (bin/ffmpeg)
   Licence : GNU LGPL v2.1 or later — see FFMPEG-LGPLv2.1.txt
   Source  : https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz (unmodified)
   Build   : minimal static ARMv7 build, no GPL / version3 / nonfree parts.
             Exact configure line, toolchain and source checksums: FFMPEG-BUILD-INFO.txt
             Build script: tools/build-ffmpeg.sh in https://github.com/simussu9-wq/stremiobrew

2. zlib 1.3.1  (statically linked into bin/ffmpeg)
   Licence : zlib licence — see ZLIB-LICENSE.txt
   Source  : https://zlib.net/fossils/zlib-1.3.1.tar.gz

3. Mozilla CA certificate bundle  (cacert.pem)
   Licence : MPL 2.0 — https://www.mozilla.org/MPL/2.0/
   Source  : https://curl.se/ca/cacert.pem (Mozilla NSS root store, extracted by curl)

4. Inter 4 by Rasmus Andersson / The Inter Project Authors  (app/fonts/*.woff2)
   Licence : SIL Open Font License 1.1 -- app/fonts/LICENSE.txt
   Source  : https://github.com/rsms/inter (npm @fontsource/inter@5.0.18, unmodified)
   Its Cyrillic subset (app/fonts/inter-cyrillic-*.woff2) comes from npm @fontsource/inter@5.1.0.

5. nuvio-engine 0.1.5 by NuvioMedia  (bin/nuvio-bridge, statically linked)
   Licence : GNU GPL v3.0 or later -- NUVIO-ENGINE-GPL-3.0.txt, NUVIO-ENGINE-THIRD-PARTY-NOTICES.md
   Source  : https://github.com/NuvioMedia/nuvio-engine (commit 99a1860) plus
             tools/nuvio/stremiobrew-nuvio.patch and tools/nuvio/nuvio-bridge.cpp, built by
             tools/build-nuvio.sh in https://github.com/simussu9-wq/stremiobrew
   Includes: libtorrent 2.0.12 (BSD 3-Clause -- LIBTORRENT-BSD.txt, https://github.com/arvidn/libtorrent
             commit 740a0b9 with the engine's patches) and Boost 1.86 headers (BSL 1.0 -- BOOST-BSL-1.0.txt).

6. Noto Sans Arabic by Google  (app/fonts/noto-sans-arabic-sb-*.woff2)
   Licence : SIL Open Font License 1.1 -- app/fonts/LICENSE.txt
   Source  : npm @fontsource/noto-sans-arabic@5.1.0
   Modified: unitsPerEm 1000 -> 909 (letters 10% larger, level with Inter) and line metrics
             (ascent/descent 1.05 / 0.42 em); renamed -sb- to mark the change.

7. StremioBrew logo (app/logo.png from assets/brand.svg; app/icon.png and app/splashicon.png are the mug cut
   from it) -- original artwork combining the webOS Homebrew Channel mug motif with a play symbol.

8. QR Code Generator for JavaScript by Kazuhiko Arase  (service/qrcode.js)
   Licence : MIT -- notice at the top of the file
   Source  : https://github.com/kazuhikoarase/qrcode-generator

No JavaScript runtime is bundled: the helper service runs on the TV's own Node.js.
Apart from service/qrcode.js (item 8), the application code in app/ and service/ is the project's own
source, licensed GPL-3.0-or-later (LICENSE in https://github.com/simussu9-wq/stremiobrew).
