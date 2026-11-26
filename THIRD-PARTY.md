# Third-party media engine

VideoDrop's extension interface, detection, manifest parsing, download orchestration are independently written. No CocoCut implementation or assets are used.

The VideoDrop 1.3.3 Full Chrome extension includes **YouTube.js (youtubei.js) 18.3.0** under the MIT license. The vendor script verifies the official npm artifact against its pinned SHA-512 integrity and removes hard-coded Google API key defaults from the browser bundle. The installed extension obtains an anonymous session from YouTube at runtime. The patched browser bundle, license and provenance are in `youtube/vendor/` and are copied to `vendor/youtube/` in the extension. Provenance records the packaged files' SHA-256 hashes. Player retrieval and remote-script evaluation are disabled in VideoDrop's integration.

- [YouTube.js source](https://github.com/LuanRT/YouTube.js)
- [Pinned YouTube.js npm artifact](https://registry.npmjs.org/youtubei.js/-/youtubei.js-18.3.0.tgz)
- [YouTube.js license](https://github.com/LuanRT/YouTube.js/blob/main/LICENSE)

The extension uses the bundled FFmpeg WebAssembly engine described below. The separate Windows setup embeds the same extension ZIP and uses the Windows .NET Framework to extract it and open Chrome. Media processing takes place inside Chrome.

The extension includes the unmodified single-thread `@ffmpeg/core` 0.12.10 JavaScript and WebAssembly files, distributed under GPL-2.0-or-later. The license is at `extension/vendor/ffmpeg/COPYING.GPLv2`. `provenance.json` records the official npm artifact, its SHA-512 integrity and every bundled artifact's SHA-256.

- [Upstream source and reproducible build files at release v12.15](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15)
- [Release corresponding to core 0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)
- [FFmpeg 5.1.4 source](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4)
- [FFmpeg core build dependencies and source references](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/Dockerfile)
- [Pinned npm artifact](https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz)

The original VideoDrop source remains under the root MIT license. The bundled FFmpeg core and its included libraries retain their own upstream licenses; the root license does not replace them. `tools/vendor-media.mjs` verifies the official npm integrity before copying the engine and its license.

The historical 1.2.0 helper release uses yt-dlp, yt-dlp-ejs, Python and PyInstaller, and invokes locally installed FFmpeg and Node.js. It is not used or included in the current extension package. Those tools retain their upstream licenses. Its archived installer can download Node.js from nodejs.org and FFmpeg from the Gyan build distributor linked by ffmpeg.org, verifying their published SHA-256 hashes, if suitable local tools are absent.

- [yt-dlp source and license](https://github.com/yt-dlp/yt-dlp)
- [yt-dlp-ejs source and license](https://github.com/yt-dlp/ejs)
- [PyInstaller license and bootloader exception](https://pyinstaller.org/en/stable/license.html)
- [Python license](https://docs.python.org/3/license.html)
- [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE)
- [FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)



