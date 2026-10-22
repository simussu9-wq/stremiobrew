# StremioBrew — webOS compatibility

Last reviewed 2026-10-22, for version 2.0.0.

Engine and Node.js versions are LG's own tables:
[web engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine),
[Node.js for JS services](https://webostv.developer.lge.com/develop/guides/js-service-basics).

| webOS TV | Years | Web engine | Node.js | Status |
|---|---|---|---|---|
| 1.x / 2.x | 2014-15 | WebKit 537/538 | 0.10 | **Not supported**: no Chromium; the app's layout and APIs predate it. |
| 3.x | 2016-17 | Chromium 38 | 0.12.2 | **Should work, untested** (offered from webOS 3.0 up). Accent colours fall back to the default purple (no CSS variables before Chromium 49). Posters aren't pre-shrunk (no `canvas.toBlob` before 50): more decoding while browsing. |
| 4.x | 2018-19 | Chromium 53 | 0.12.2 | **Main target**: built and measured on it (LG, webOS 4.x, rooted). |
| 5.x / 6.0 | 2020-21 | Chromium 68 / 79 | 8.12.0 | **Should work, untested.** Everything the app uses exists; faster than 4.x. |
| 22 / 23 | 2022-23 | Chromium 87 / 94 | 12.21 / 12.22 | **Should work, untested.** |
| 24 / 25 / 26 | 2024-26 | Chromium 108 / 120 / ? | 16.19 / 16.20 / 20.12 | **Should work, untested.** The helper runs unchanged on Node 20. |

## What was checked

- **App code (index.html, player.js, i18n):**
  - ES5 only (no `let`/`const`, arrow functions or template strings).
  - No API newer than Chromium 38 without a fallback:
    - `createImageBitmap`: falls back to `<img>`.
    - `requestIdleCallback`: falls back to a timer.
    - `canvas.toBlob`: the original poster is used.
    - `performance.memory`: guarded.
  - No `fetch`, `Object.assign`, `Array.from`, `.includes` or `.closest`.
- **CSS variables:** every declaration that uses the accent variables has a plain-colour fallback in front. Chromium 38 shows the default purple; 49 and later follow the live accent.
- **Helper (tvserver.js):**
  - Written for Node 0.12.
  - Runs unchanged on Node 20 (`/ping`, `/sug`, `/skips`, `/imgx`, `/logs` tested, no errors or deprecation warnings).
  - No `new Buffer`, no `process.binding`.
  - LAN address detection accepts Node 18's numeric address family.
- **Native binaries (ffmpeg, P2P engine):** static ARMv7, so no library dependencies. They run on every LG ARM TV with 32-bit userland or 32-bit compatibility. All webOS TVs so far ship 32-bit userland on ARM, but this needs a test on a 2023+ set.

## Known limits / risks by area

1. **Root (Homebrew Channel).** The helper is started through hbchannel `exec` as root. On a TV in plain Developer Mode, it can only run as the app's JS service (`service/launch.js`), which is sandboxed. Expect missing pieces there:
   - P2P engine binary execution may be denied;
   - writes outside the app folder may fail.
   Untested.
2. **Audio track switching** uses `video.audioTracks`. Chromium supports it on webOS 4 but keeps it behind a flag on desktop. On newer webOS it may be missing, so the Audio tray would then list nothing.
3. **Magic Remote pointer.** Pointing moves the highlight (the screen follows as for the arrows), a click is OK (held on a card: its menu), the wheel is the Up/Down arrows, and an arrow key puts the pointer away until a real movement. The player's controls, seek bar and trays work by pointer too. In StremioBrew it is tested with simulated pointer events only.
4. **Memory.** Tuned on a 4.x set with ~650 MB RAM. Newer sets have more and should be fine.
   - Screens behind the player release their posters during playback.
   - Background trailers are skipped when the TV has less than 60 MB free, and stop if it drops below 45 MB.
   - If the app is killed, a torrent nobody checks in on for 2 minutes is removed, and the idle P2P engine closes after 2 minutes.
   - The helper frees memory as it streams and reads subtitles; past 150 MB with nothing playing it restarts itself, and the app starts it again if it ever stops answering.
5. **Storage for P2P.** The torrent buffer sizes itself to the app storage's free space at each start (64-512 MB), leaving a quarter of that free space (48-96 MB) for app installs and other apps. Downloads are deleted when the engine stops and when the helper starts.
   With less than about 110 MB free, P2P reports that storage is full; debrid playback is unaffected.
6. **Video formats.** Playback is the TV's own decoder: HEVC/DV/HDR10+/TrueHD/DTS support depends on the model, not the app.

## To verify on hardware (in order of value)

- webOS 5.x or 6.x set (most common in use).
- A 2023+ set (64-bit SoC): native binaries, Node 16/20 helper.
- A 3.x set: accent fallbacks, performance.
- Any set in plain Developer Mode, no root: helper as a JS service, P2P.
