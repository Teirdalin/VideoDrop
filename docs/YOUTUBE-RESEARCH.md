# YouTube investigation — October 24, 2026

## Upload manifest repair in 1.3.2

The developer dashboard rejected the development-only `key` field. It is removed from the single distribution and blocked by build/package assertions. The previous static YouTube request rules also depended on that fixed development ID. They are now installed atomically as dynamic rules scoped to `chrome.runtime.id` before the offscreen document fetches media, so an ID assigned by the store or by unpacked installation works without a manifest key. Header changes remain limited to the extension's own requests.

Sources: [Chrome's manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key) describes the development-ID purpose; [request-rule documentation](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) documents dynamic rules and initiator matching. Connected tests discover the installed ID rather than deriving one from a public key.

## Reproduced cause

The user reported the exact message “YouTube downloading is not available in this Web Store edition.” It came from the former base `extension/popup.js`. That folder's background had no YouTube page provider, while the complete browser-only code was built into `chrome-extension`. Loading/reloading the original folder therefore retained the disabled feature even though another ZIP supported it.

The repair unifies the product: `extension` contains the complete YouTube provider, offscreen downloader, packaged YouTube.js metadata parser and FFmpeg WebAssembly mux/MP3 worker. Both build commands package the same extension. Settings identifies the running version. A regression test exercises GET_MODEL and stream inspection from the main folder on a YouTube URL, rather than merely checking that another artifact contains a YouTube file.

## Methods considered

1. **Direct, signed, complete tracks from public format metadata.** Retained: YouTube.js obtains a server-issued public session and VISIONOS format response. The extension selects compatible tracks, fetches exact byte ranges through their final byte, then merges or encodes MP3 locally. The actual Chrome transfers verify this method. No remotely fetched player script is evaluated.
2. **Manifest delivery through HLS.** A possible future fallback, using the existing complete-segment downloader. It is unnecessary for the reported disabled-edition message, so a new transport was not introduced without a reproduced transport failure.
3. **Capture the playing page in real time.** Technically a different capture workflow; it requires waiting for playback and may not preserve original media. It was not substituted for the requested quality-based download.
4. **A native helper or remote conversion service.** Excluded by the user's requirement that everything run inside the Chrome extension.

## Primary sources consulted

- [YouTube.js configuration](https://ytjs.dev/guide/getting-started): browser runtime support, session generation, custom fetch, and player retrieval/deciphering options. VideoDrop sets `retrieve_player: false` and `generate_session_locally: false`.
- [YouTube.js source and releases](https://github.com/LuanRT/YouTube.js/releases): the packaged browser library and its VISIONOS support. The pinned 18.3.0 artifact has integrity hashes and an MIT license in the extension.
- [Chrome Web Store troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting#prohibited-products): the distribution restriction explains the historical split. It does not require a desktop implementation. The current product is one manually loaded Chrome extension, with no feature-stripped alternative.

The user's error is a packaging/entry-point defect. This investigation does not claim that every YouTube video or account-restricted source is downloadable. Connected tests cover the official public Blender test film and actual MP4/MP3 outputs; their reports distinguish that evidence from local fixture checks.
