#!/bin/bash
# Reproducible build of the minimal, LGPL-2.1+ ffmpeg bundled with StremioBrew.
#
#   Target : LG webOS 4.x+ TVs — ARMv7 hard-float, fully static (musl), no runtime deps.
#   Toolchain: zig (as a clang cross-compiler), https://ziglang.org — tested with 0.17.0.
#   Usage  : ZIG=/path/to/zig tools/build-ffmpeg.sh [workdir]   -> dist/bin/ffmpeg
#            NATIVE=1 tools/build-ffmpeg.sh  -> same components for the build host
#            (.build-ffmpeg/native-ffmpeg), to test tvserver.js against this exact feature set
#
# Only what tvserver.js uses is enabled (see service/tvserver.js, every spawn(FFMPEG)):
#   input   : http (always our 127.0.0.1 /proxy — node does TLS + DNS), file, pipe
#   demux   : matroska/webm, mov/mp4, avi, mpegts, jpeg/png/webp image pipes
#   decode  : h264 hevc mpeg4 mpeg2video vp9 (preview frames), mjpeg png webp (/bgz),
#             subrip ass ssa mov_text webvtt text (embedded subtitles)
#   encode  : mjpeg (thumbnails), subrip (embedded subtitles -> srt)
#   mux     : mjpeg, srt          filters: scale (+ the ones ffmpeg auto-inserts)
#   audio   : the usual film codecs -> mono 8 kHz PCM (s16le) for subtitle auto-sync (speech timing)
# No --enable-gpl / --enable-version3 / nonfree: the result is LGPL v2.1 or later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIG="${ZIG:-zig}"
WORK="$(mkdir -p "${1:-$ROOT/.build-ffmpeg}" && cd "${1:-$ROOT/.build-ffmpeg}" && pwd)"
FFMPEG_VER=7.1.1
FFMPEG_SHA256=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
ZLIB_VER=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

TARGET=arm-linux-musleabihf
# ARMv7-A + NEON: every webOS 4.x TV SoC is Cortex-A9/A53 class with NEON. ffmpeg's
# configure only builds its NEON asm (big win for hevc/h264 preview decodes) when the
# compiler targets NEON.
CPU=generic+v7a+neon+thumb2
CC="$ZIG cc -target $TARGET -mcpu=$CPU"
NATIVE="${NATIVE:-}"
if [ -n "$NATIVE" ]; then CC=cc; fi

mkdir -p "$WORK/src" "$WORK/sysroot"
cd "$WORK/src"
fetch() { # url file sha256
  [ -f "$2" ] || curl -sSLf -o "$2" "$1"
  echo "$3  $2" | shasum -a 256 -c -
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz" "ffmpeg-$FFMPEG_VER.tar.xz" "$FFMPEG_SHA256"
fetch "https://zlib.net/fossils/zlib-$ZLIB_VER.tar.gz" "zlib-$ZLIB_VER.tar.gz" "$ZLIB_SHA256"

# ---- zlib (static) — matroska compressed tracks + png decoder ----
rm -rf "zlib-$ZLIB_VER"; tar xzf "zlib-$ZLIB_VER.tar.gz"
( cd "zlib-$ZLIB_VER"   # plain compile: zlib's configure picks Apple libtool on a Mac host
  for f in adler32 crc32 deflate infback inffast inflate inftrees trees zutil compress uncompr gzclose gzlib gzread gzwrite; do
    $CC -O2 -fPIC -D_LARGEFILE64_SOURCE=1 -DHAVE_HIDDEN -c $f.c -o $f.o
  done
  mkdir -p "$WORK/sysroot/lib" "$WORK/sysroot/include"
  rm -f libz.a; if [ -n "$NATIVE" ]; then ar rcs libz.a *.o; else $ZIG ar rcs libz.a *.o; fi
  cp libz.a "$WORK/sysroot/lib/"; cp zlib.h zconf.h "$WORK/sysroot/include/" )

# ---- ffmpeg ----
rm -rf "ffmpeg-$FFMPEG_VER"; tar xJf "ffmpeg-$FFMPEG_VER.tar.xz"
cd "ffmpeg-$FFMPEG_VER"
if [ -n "$NATIVE" ]; then
  PLATFORM=(--cc=cc --extra-cflags="-O2 -I$WORK/sysroot/include" --extra-ldflags="-L$WORK/sysroot/lib")
else
  PLATFORM=(--enable-cross-compile --target-os=linux --arch=arm
    --cc="$CC" --ar="$ZIG ar" --ranlib="$ZIG ranlib" --nm=nm
    --extra-cflags="-O2 -I$WORK/sysroot/include" --extra-ldflags="-static -s -L$WORK/sysroot/lib")
fi
CONFIGURE=(
  --pkg-config=false
  --enable-static --disable-shared --enable-pic
  --disable-everything --disable-autodetect --enable-zlib --enable-pthreads
  --disable-doc --disable-debug --disable-programs --enable-ffmpeg
  --disable-avdevice --disable-postproc --enable-swresample
  --enable-network
  --enable-protocol=http,tcp,file,pipe
  --enable-demuxer=matroska,mov,avi,mpegts,image_jpeg_pipe,image_png_pipe,image_webp_pipe
  --enable-decoder=h264,hevc,mpeg4,mpeg2video,vp9,mjpeg,png,webp,subrip,srt,ass,ssa,movtext,webvtt,text,aac,aac_latm,ac3,eac3,dca,opus,mp3,mp3float,flac,vorbis,truehd,mlp,alac,pcm_s16le,pcm_s24le,pcm_s16be,pcm_bluray,pcm_dvd
  --enable-parser=h264,hevc,mpeg4video,mpegvideo,vp9,av1,aac,ac3,dca,mpegaudio,opus,vorbis,flac,mjpeg,png,webp
  --enable-encoder=mjpeg,subrip,srt,pcm_s16le
  --enable-muxer=mjpeg,srt,s16le
  --enable-filter=scale,format,null,anull,copy,aresample,aformat
)
./configure "${PLATFORM[@]}" "${CONFIGURE[@]}" > "$WORK/configure.log" 2>&1 || { tail -30 ffbuild/config.log; exit 1; }
make -j8 ffmpeg > "$WORK/make.log" 2>&1 || { tail -40 "$WORK/make.log"; exit 1; }

if [ -n "$NATIVE" ]; then cp ffmpeg "$WORK/native-ffmpeg"; ls -l "$WORK/native-ffmpeg"; exit 0; fi
mkdir -p "$ROOT/dist/bin"
cp ffmpeg "$ROOT/dist/bin/ffmpeg"
{ echo "FFmpeg $FFMPEG_VER (sha256 $FFMPEG_SHA256), zlib $ZLIB_VER (sha256 $ZLIB_SHA256)"
  echo "zig $("$ZIG" version), target $TARGET, cpu $CPU"
  echo "configure: ${PLATFORM[*]} ${CONFIGURE[*]}"; } > "$ROOT/dist/bin/ffmpeg.buildinfo"
ls -l "$ROOT/dist/bin/ffmpeg"
