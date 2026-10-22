#!/bin/bash
# Builds StremioBrew's P2P engine runner: tools/nuvio/nuvio-bridge.cpp on nuvio-engine
# (github.com/NuvioMedia/nuvio-engine, GPL-3.0, libtorrent 2.0.12) at a pinned commit plus
# tools/nuvio/stremiobrew-nuvio.patch:
#   - Nuvio Native Legacy's streaming window (#334): pieces far from the playhead are punched out
#     of the payload file so a 100 GB torrent plays inside a few hundred MB of flash; its
#     libtorrent drop-piece patch regenerated WITH context against the 0.1.5 patch stack
#   - live download/upload limits in the C API (the helper's Auto pacing)
#   - verified pieces served from disk instead of read_piece() (no 2x piece size RAM spikes)
#   - no UPnP / NAT-PMP port mapping
#
#   tools/build-nuvio.sh        -> dist/bin/nuvio-bridge          (TV: armv7, static musl, stripped)
#   tools/build-nuvio.sh mac    -> .build-nuvio/nuvio-bridge-mac  (development on a Mac)
#
# Needs cmake, ninja, git; zig (ZIG_DIR or on PATH) for the TV; Homebrew openssl@3 for the Mac.
# The TV build has no OpenSSL: libtorrent's built-in SHA-1/RC4 (peer encryption still works),
# only HTTPS trackers are unavailable (the helper's tracker list is UDP but one).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NUVIO_COMMIT=99a1860   # 0.1.5
WORK="$ROOT/.build-nuvio"
SRC="${NUVIO_SRC:-$WORK/nuvio-src}"
ZIG_DIR="${ZIG_DIR:-}"   # the folder holding zig, when it is not on PATH
TARGET="${1:-tv}"
mkdir -p "$WORK"

if [ ! -d "$SRC/.git" ]; then
  git clone -q https://github.com/NuvioMedia/nuvio-engine "$SRC"
fi
git -C "$SRC" checkout -q "$NUVIO_COMMIT"
git -C "$SRC" reset -q --hard "$NUVIO_COMMIT"
git -C "$SRC" clean -qfd -- src include tests cmake
git -C "$SRC" apply "$ROOT/tools/nuvio/stremiobrew-nuvio.patch"

# Boost and libtorrent sources are fetched once into $WORK/deps and shared by the Mac and TV
# builds (each target keeps its own build folders). Same pins as cmake/Dependencies.cmake; the
# engine's CMake applies its libtorrent patches in place (each guarded by a sentinel).
DEPS="$WORK/deps"
mkdir -p "$DEPS"
if [ ! -f "$DEPS/nuvio_boost-src/boost/version.hpp" ]; then
  curl -fsSL -o "$DEPS/boost.tar.bz2" https://archives.boost.io/release/1.86.0/source/boost_1_86_0.tar.bz2
  echo "1bed88e40401b2cb7a1f76d4bab499e352fa4d0c5f31c0dbae64e24d34d7513b  $DEPS/boost.tar.bz2" | shasum -a 256 -c -
  rm -rf "$DEPS/nuvio_boost-src"; mkdir -p "$DEPS/nuvio_boost-src"
  tar -xjf "$DEPS/boost.tar.bz2" -C "$DEPS/nuvio_boost-src" --strip-components 1
  rm -f "$DEPS/boost.tar.bz2"
fi
if [ ! -d "$DEPS/nuvio_libtorrent-src/.git" ]; then
  git clone -q https://github.com/arvidn/libtorrent.git "$DEPS/nuvio_libtorrent-src"
  git -C "$DEPS/nuvio_libtorrent-src" checkout -q 740a0b9aeabe00e762cc0efe4a0f27593db2550b
  git -C "$DEPS/nuvio_libtorrent-src" submodule update -q --init deps/try_signal
fi
COMMON=(-G Ninja -DNUVIO_ENGINE_ENABLE_LIBTORRENT=ON -DNUVIO_ENGINE_BUILD_TESTS=OFF
        -DFETCHCONTENT_SOURCE_DIR_NUVIO_BOOST="$DEPS/nuvio_boost-src"
        -DFETCHCONTENT_SOURCE_DIR_NUVIO_LIBTORRENT="$DEPS/nuvio_libtorrent-src")

[ -n "$ZIG_DIR" ] && export PATH="$ZIG_DIR:$PATH"
if [ "$TARGET" = mac ]; then
  # zig's libc++ (Apple's clang 15 libc++ has no std::jthread/stop_token, which the engine uses)
  TC="$WORK/zig-mac"; mkdir -p "$TC"
  printf '#!/bin/sh\nexec zig cc "$@"\n' > "$TC/cc"; printf '#!/bin/sh\nexec zig c++ "$@"\n' > "$TC/c++"
  chmod 755 "$TC/cc" "$TC/c++"
  B="$WORK/mac"
  OSSL="$(brew --prefix openssl@3)"
  cmake -S "$SRC" -B "$B" "${COMMON[@]}" -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR="$OSSL" \
    -DCMAKE_C_COMPILER="$TC/cc" -DCMAKE_CXX_COMPILER="$TC/c++" >/dev/null
  ninja -C "$B" nuvio_engine
  "$TC/c++" -std=c++20 -O2 -I"$SRC/include" "$ROOT/tools/nuvio/nuvio-bridge.cpp" \
    "$B/libnuvio_engine.a" "$B/_deps/nuvio_libtorrent-build/libtorrent-rasterbar.a" \
    "$OSSL/lib/libssl.a" "$OSSL/lib/libcrypto.a" -framework Security -framework CoreFoundation \
    -framework SystemConfiguration -lpthread -o "$WORK/nuvio-bridge-mac"
  echo "built $WORK/nuvio-bridge-mac"
  exit 0
fi

# ---- TV: armv7 hard-float, static musl, through zig ----
TC="$WORK/zig-arm"
mkdir -p "$TC"
ZT="-target arm-linux-musleabihf -mcpu=cortex_a7"   # armv7-a + VFPv4/NEON (any webOS 4 SoC)
printf '#!/bin/sh\nexec zig cc %s "$@"\n' "$ZT" > "$TC/cc"
printf '#!/bin/sh\nexec zig c++ %s "$@"\n' "$ZT" > "$TC/c++"
printf '#!/bin/sh\nexec zig ar "$@"\n' > "$TC/ar"
printf '#!/bin/sh\nexec zig ranlib "$@"\n' > "$TC/ranlib"
chmod 755 "$TC/cc" "$TC/c++" "$TC/ar" "$TC/ranlib"
cat > "$TC/toolchain.cmake" <<T
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER $TC/cc)
set(CMAKE_CXX_COMPILER $TC/c++)
set(CMAKE_AR $TC/ar)
set(CMAKE_RANLIB $TC/ranlib)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
T
B="$WORK/arm"
cmake -S "$SRC" -B "$B" "${COMMON[@]}" -DCMAKE_TOOLCHAIN_FILE="$TC/toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON -DCMAKE_DISABLE_FIND_PACKAGE_GnuTLS=ON -DCMAKE_DISABLE_FIND_PACKAGE_LibGcrypt=ON \
  -DCMAKE_C_FLAGS="-ffunction-sections -fdata-sections -D_LARGEFILE64_SOURCE" \
  -DCMAKE_CXX_FLAGS="-ffunction-sections -fdata-sections -D_LARGEFILE64_SOURCE" >/dev/null
ninja -C "$B" nuvio_engine
"$TC/c++" -std=c++20 -Os -ffunction-sections -fdata-sections -I"$SRC/include" "$ROOT/tools/nuvio/nuvio-bridge.cpp" \
  "$B/libnuvio_engine.a" "$B/_deps/nuvio_libtorrent-build/libtorrent-rasterbar.a" \
  -static -Wl,--gc-sections -lpthread -o "$WORK/nuvio-bridge.arm"
mkdir -p "$ROOT/dist/bin"
python3 "$ROOT/tools/strip-elf.py" "$WORK/nuvio-bridge.arm" "$ROOT/dist/bin/nuvio-bridge"
chmod 755 "$ROOT/dist/bin/nuvio-bridge"
echo "nuvio-engine 0.1.5+stremiobrew" > "$ROOT/dist/bin/nuvio-bridge.version"
ls -l "$ROOT/dist/bin/nuvio-bridge"
