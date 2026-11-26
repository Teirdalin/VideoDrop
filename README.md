# VideoDrop

Download public YouTube videos or convert audio to 192 kbps MP3 in Chrome. VideoDrop also supports direct media, unencrypted HLS, static DASH, separate video/audio tracks and live HLS capture.

## Install in Chrome

Download the current version from [GitHub Releases](https://github.com/Teirdalin/VideoDrop/releases/latest).

1. On Windows, run `VideoDrop-Setup-1.3.3.exe` and click **Set up VideoDrop**. The installer copies the extension to `%LOCALAPPDATA%\VideoDrop\Full` and opens Chrome's Extensions page. The setup executable is unsigned.
2. Click **Copy folder** in setup. In Chrome, turn on **Developer mode**, click **Load unpacked**, and paste the folder path into the picker. Chrome requires this step for a GitHub-distributed extension on Windows. [Chrome extension distribution](https://developer.chrome.com/docs/extensions/how-to/distribute)
3. Pin VideoDrop if you want it in the toolbar, reload your video page, then open VideoDrop and choose a format or quality. `Alt+Shift+V` opens the popup.

**ZIP installation:** Extract `VideoDrop-Full-1.3.3.zip` to a permanent folder. In `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.

**Update:** Run the new setup, then click **Reload** on VideoDrop's card in Chrome. If you originally installed from a ZIP, replace the files in the same folder and click **Reload** to retain that Chrome installation's settings.

**Remove:** Remove VideoDrop in `chrome://extensions`, then delete the folder where you installed it.

## Features and limits

Direct MP4, WebM, MOV, M4V and OGV files use Chrome's downloader. VideoDrop can merge separate video and audio tracks, capture live HLS with **Finish & save**, and convert supported YouTube audio to MP3. Prepared jobs have a combined 512 MiB input limit and a 12,000-segment limit. VideoDrop runs one prepared job at a time. DRM, encrypted streams, YouTube livestreams, account-only videos and live or multi-period DASH are unsupported. Download media you have permission to save.

## Build from source

The extension source is in `extension/`. Node.js 22 or newer is required for the build and automated checks.

- `npm test` builds the extension and runs its automated checks.
- `npm run package` creates the extension ZIP in `dist/`.
- `npm run package:windows` creates the setup executable, extension ZIP and `SHA256SUMS.txt` on Windows with the .NET Framework 4.8 compiler.
- `npm run test:browser` runs local media checks in a disposable browser profile with FFmpeg and FFprobe installed.
- `npm run test:youtube` checks public YouTube downloads in a disposable Chrome profile with FFmpeg and FFprobe installed.

The original code is MIT-licensed. See [privacy](PRIVACY.md), [third-party licenses and engine source](THIRD-PARTY.md), and [branding](BRANDING.md).

Optional support is available through [Patreon](https://www.patreon.com/cw/Teirdalin) and [Ko-fi](https://ko-fi.com/teirdalin).
