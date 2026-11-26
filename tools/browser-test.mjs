// Isolated, local-only integration tests. No personal browser profile is opened.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runStreamScenarios } from "./browser-scenarios.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = path.join(root, ".tmp", `browser-${Date.now()}`);
const extension = path.resolve(root, process.env.VIDEODROP_EXTENSION || "extension");
const extensionName = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8")).name;
const storeEdition = /Web Store/.test(JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8")).version_name || "");
const ffmpeg = process.env.VIDEODROP_FFMPEG || "ffmpeg";
const ffprobe = process.env.VIDEODROP_FFPROBE || "ffprobe";
const mediaDir = path.join(run, "media"), downloads = path.join(run, "downloads");
await mkdir(mediaDir, { recursive: true }); await mkdir(downloads);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; }
    await pause(150);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ""}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.pending = new Map(); this.next = 0;
    ws.addEventListener("message", event => {
      const result = JSON.parse(event.data);
      if (result.id && this.pending.has(result.id)) {
        const { resolve, reject } = this.pending.get(result.id);
        this.pending.delete(result.id);
        result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(id) { return (await this.send("Target.attachToTarget", { targetId: id, flatten: true })).sessionId; }
  async evaluate(expression, session) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

const report = { startedAt: new Date().toISOString(), run, extension, checks: [] };
function passed(name, details = {}) { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); }
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let browser, proc, server, log, popupSession, extensionId, fixtureTab, diagnosticWorker;
const slowControllers = new Set();

try {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-c:a", "aac", "-movflags", "+faststart", path.join(mediaDir, "sample.mp4")], { windowsHide: true });
  for (const [folder, format] of [["ts", "mpegts"], ["fmp4", "fmp4"]]) {
    await mkdir(path.join(mediaDir, folder));
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_type", format, path.join(mediaDir, folder, "index.m3u8")], { windowsHide: true, cwd: path.join(mediaDir, folder) });
  }
  for (const folder of ["dash", "separate"]) await mkdir(path.join(mediaDir, folder));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-c", "copy", "-f", "dash", "-seg_duration", "1", "-use_template", "1", "-use_timeline", "1", path.join(mediaDir, "dash", "index.mpd")], { windowsHide: true, cwd: path.join(mediaDir, "dash") });
  const numbered = (await readFile(path.join(mediaDir, "dash", "index.mpd"), "utf8")).replace(/(<SegmentTemplate\b[^>]*)(>)([\s\S]*?)<\/SegmentTemplate>/g, (_all, tag, _close, inner) => `${tag} duration="${inner.match(/\bd="(\d+)"/)[1]}"/>`);
  await writeFile(path.join(mediaDir, "dash", "numbered.mpd"), numbered);
  await mkdir(path.join(mediaDir, "list"));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-c", "copy", "-f", "dash", "-seg_duration", "1", "-single_file", "1", path.join(mediaDir, "list", "index.mpd")], { windowsHide: true, cwd: path.join(mediaDir, "list") });
  const listPath = path.join(mediaDir, "list", "index.mpd");
  await writeFile(listPath, (await readFile(listPath, "utf8")).replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_match, filename) => `<BaseURL>${path.basename(filename)}</BaseURL>`));
  await mkdir(path.join(mediaDir, "indexed"));
  const indexedTracks = [];
  for (const [kind, selector] of [["video", "0:v:0"], ["audio", "0:a:0"]]) {
    const filename = path.join(mediaDir, "indexed", `${kind}.mp4`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-map", selector, "-c", "copy", "-movflags", "+frag_keyframe+empty_moov+dash+global_sidx", filename], { windowsHide: true });
    const bytes = await readFile(filename);
    let position = 0;
    while (position + 8 < bytes.length && bytes.subarray(position + 4, position + 8).toString() !== "sidx") position += bytes.readUInt32BE(position);
    assert.ok(position + 8 < bytes.length, "generated global SIDX");
    const size = bytes.readUInt32BE(position);
    indexedTracks.push(`<AdaptationSet contentType="${kind}" mimeType="${kind}/mp4"><Representation id="${kind}"${kind === "video" ? ' height="180"' : ""}><BaseURL>${kind}.mp4</BaseURL><SegmentBase indexRange="${position}-${position + size - 1}"><Initialization range="0-${position - 1}"/></SegmentBase></Representation></AdaptationSet>`);
  }
  await writeFile(path.join(mediaDir, "indexed", "index.mpd"), `<MPD mediaPresentationDuration="PT3S"><Period>${indexedTracks.join("")}</Period></MPD>`);
  for (const [kind, selector] of [["video", "0:v:0"], ["audio", "0:a:0"]]) execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-map", selector, "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", `${kind}-init.mp4`, path.join(mediaDir, "separate", `${kind}.m3u8`)], { windowsHide: true, cwd: path.join(mediaDir, "separate") });
  await writeFile(path.join(mediaDir, "separate", "master.m3u8"), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,LANGUAGE="en",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,AUDIO="audio"\nvideo.m3u8\n');
  await writeFile(path.join(mediaDir, "protected.mp4"), await readFile(path.join(mediaDir, "sample.mp4")));
  await writeFile(path.join(mediaDir, "master.m3u8"), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.64000b,mp4a.40.2"\nts/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x90\nfmp4/index.m3u8\n');
  await writeFile(path.join(mediaDir, "encrypted.m3u8"), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:3,\nts/index0.ts\n#EXT-X-ENDLIST');
  await writeFile(path.join(mediaDir, "live.m3u8"), '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nts/index0.ts');
  await writeFile(path.join(mediaDir, "slow.m3u8"), '#EXTM3U\n#EXTINF:3,\nslow.ts\n#EXT-X-ENDLIST');
  const requests = [];
  let growingReads = 0;
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      requests.push(url.pathname);
      if (url.pathname === "/redirect-excluded.mp4") { res.writeHead(302, { Location: `http://rr1.googlevideo.com:${server.address().port}/excluded.mp4` }); res.end(); return; }
      if (url.pathname === "/" || url.pathname === "/empty") {
        res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "videodrop_session=allowed; Path=/; HttpOnly; SameSite=Lax" });
        res.end(`<!doctype html><title>Mountain Light - A Short Film</title><style>body{font:18px system-ui;background:#ecf2e8;padding:40px}video{width:480px}</style><h1>Mountain Light - A Short Film</h1>${url.pathname === "/" ? '<video controls preload="metadata" src="/sample.mp4"></video>' : '<p>No video on this page.</p>'}`);
        return;
      }
      if (url.pathname === "/protected.mp4" || url.pathname.startsWith("/locked/")) {
        (report.contextRequests ||= []).push({ path: url.pathname, referrer: req.headers.referer || "", hasCookie: !!req.headers.cookie?.includes("videodrop_session=allowed") });
        if (req.headers.referer !== `http://${req.headers.host}/` || !req.headers.cookie?.includes("videodrop_session=allowed")) { res.writeHead(404); res.end("File unavailable without the page context"); return; }
      }
      if (url.pathname === "/growing.m3u8" || url.pathname === "/endless.m3u8") {
        const all = (await readFile(path.join(mediaDir, "ts", "index.m3u8"), "utf8")).replace(/^(index\d+\.ts)$/gm, "ts/$1");
        const initial = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\nts/index0.ts';
        const content = url.pathname === "/endless.m3u8" ? all.replace("#EXT-X-ENDLIST", "") : ++growingReads <= 2 ? initial : all;
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }); res.end(content); return;
      }
      if (url.pathname === "/slow.ts") {
        slowControllers.add(res);
        res.writeHead(200, { "Content-Type": "video/mp2t" });
        res.on("close", () => slowControllers.delete(res));
        return;
      }
      if (url.pathname === "/delayed.m3u8") {
        // Let popup polling run before an offscreen document exists.
        await pause(2200);
        const playlist = (await readFile(path.join(mediaDir, "ts", "index.m3u8"), "utf8")).replace(/^(index\d+\.ts)$/gm, "ts/$1");
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(playlist);
        return;
      }
      const target = path.resolve(mediaDir, `.${url.pathname.replace(/^\/locked\//, "/")}`);
      if (!target.startsWith(mediaDir + path.sep)) { res.writeHead(403); res.end(); return; }
      const bytes = await readFile(target);
      const mime = { ".mp4": "video/mp4", ".m3u8": "application/vnd.apple.mpegurl", ".mpd": "application/dash+xml", ".ts": "video/mp2t", ".m4s": "video/iso.segment" }[path.extname(target)] || "application/octet-stream";
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : bytes.length - 1;
        res.writeHead(206, { "Content-Type": mime, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Accept-Ranges": "bytes" });
        res.end(bytes.subarray(start, end + 1));
      } else { res.writeHead(200, { "Content-Type": mime, "Content-Length": bytes.length }); res.end(bytes); }
    } catch { res.writeHead(404); res.end("Not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executable = process.env.VIDEODROP_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  log = await open(path.join(run, "browser.log"), "w");
  proc = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--host-resolver-rules=MAP rr1.googlevideo.com 127.0.0.1", `--user-data-dir=${path.join(run, "profile")}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  const devtools = await until(async () => (await readFile(path.join(run, "profile", "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/), "isolated browser startup");
  browser = await CDP.connect(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`);
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  report.browser = await browser.send("Browser.getVersion");
  const workerSessions = new Map();
  const worker = await until(async () => {
    const targets = (await browser.send("Target.getTargets")).targetInfos.filter(target => target.type === "service_worker" && target.url.endsWith("/background.js"));
    for (const target of targets) {
      if (!workerSessions.has(target.targetId)) {
        const session = await browser.attach(target.targetId);
        await browser.send("Runtime.enable", {}, session);
        workerSessions.set(target.targetId, session);
      }
      const name = await browser.evaluate("typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().name", workerSessions.get(target.targetId)).catch(() => "");
      if (name === extensionName) return target;
    }
  }, "VideoDrop service worker (verified by manifest name)");
  extensionId = new URL(worker.url).host;
  const workerSession = workerSessions.get(worker.targetId);
  diagnosticWorker = workerSession;
  await browser.send("Runtime.enable", {}, workerSession);
  const sw = expression => browser.evaluate(expression, workerSession);
  await until(() => sw("typeof chrome !== 'undefined' && !!chrome.tabs"), "extension API initialization");
  const tabInfo = await sw(`chrome.tabs.create({url:${JSON.stringify(origin + "/")},active:true})`);
  fixtureTab = tabInfo.id;
  const fixtureTarget = await until(async () => (await browser.send("Target.getTargets")).targetInfos.find(target => target.url === origin + "/"), "fixture page");
  const fixtureSession = await browser.attach(fixtureTarget.targetId);
  await until(async () => (await sw(`chrome.storage.session.get('tab:${fixtureTab}')`))[`tab:${fixtureTab}`]?.items?.some(item => item.url.endsWith("/sample.mp4")), "real network/DOM media discovery");
  passed("Extension loads and detects an actual playing-page MP4");

  async function openPopup() {
    const tab = await sw(`chrome.tabs.create({url:chrome.runtime.getURL('popup.html'),active:false})`);
    const target = await until(async () => (await browser.send("Target.getTargets")).targetInfos.find(target => target.url === `chrome-extension://${extensionId}/popup.html`), "popup target");
    popupSession = await browser.attach(target.targetId);
    await browser.send("Runtime.enable", {}, popupSession);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 585, deviceScaleFactor: 1, mobile: false }, popupSession);
    await until(async () => browser.evaluate(`document.querySelector('#page-title')?.textContent === 'Mountain Light - A Short Film'`, popupSession), "popup loaded");
    return tab.id;
  }
  let popupTab = await openPopup();
  const ui = expression => browser.evaluate(expression, popupSession);
  if (storeEdition) {
    await until(async () => (await sw("chrome.declarativeNetRequest.getDynamicRules()")).some(rule => rule.id === 12001), "store exclusion rule initialized");
    assert.match(await ui("document.querySelector('#build-info').textContent"), /Chrome Web Store/);
    const blockedFetch = await sw(`fetch(${JSON.stringify(`http://rr1.googlevideo.com:${server.address().port}/excluded.mp4`)}).then(()=>false,()=>true)`);
    assert.equal(blockedFetch, true);
    assert.equal(requests.includes('/excluded.mp4'), false);
    passed("Web Store package blocks extension requests to YouTube media hosts before network access");
  }
  async function capture(filename) {
    const height = await ui("Math.ceil(document.querySelector('main').getBoundingClientRect().height)");
    await writeFile(path.join(run, filename), Buffer.from((await browser.send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 360, height: Math.min(height, 600), scale: 1 }, captureBeyondViewport: true }, popupSession)).data, "base64"));
  }
  const message = message => ui(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  async function savedPath(job) {
    const [item] = await sw(`chrome.downloads.search({id:${job.downloadId}})`);
    assert.equal(item.state, "complete");
    assert.ok(path.resolve(item.filename).startsWith(downloads + path.sep), "download stays in the isolated test folder");
    return item.filename;
  }
  await until(() => ui(`!document.querySelector('#download').disabled`), "enabled MP4 download");
  assert.match(await ui(`document.querySelector('#video-picker').textContent`), /MP4/);
  const links = await ui(`[...document.querySelectorAll('#support a')].map(a=>a.href)`);
  assert.deepEqual(links, ["https://www.patreon.com/cw/Teirdalin", "https://ko-fi.com/teirdalin"]);
  const activeColor = await ui("getComputedStyle(document.querySelector('#download')).backgroundColor");
  await capture("popup.png");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, popupSession);
  await capture("popup-dark.png");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, popupSession);
  await ui(`document.querySelector('#preferences').open=true`);
  await capture("popup-preferences.png");
  await ui(`document.querySelector('#preferences').open=false`);
  assert.equal(await ui("document.documentElement.scrollWidth <= innerWidth"), true);
  passed("Popup displays the video selector, download button and exact support links");
  await ui(`document.querySelector('#download').click()`);
  async function waitJob(kind, state, count = 1) {
    return until(async () => {
      const all = await sw("chrome.storage.session.get(null)");
      const entries = Object.entries(all).filter(([key, value]) => key.startsWith("job:") && value.kind === kind && value.state === state).map(([, value]) => value).sort((a, b) => b.createdAt - a.createdAt);
      return entries.length >= count && entries[0];
    }, `${kind} ${state} job`);
  }
  const direct = await waitJob("file", "complete");
  const directFile = await readFile(await savedPath(direct));
  assert.equal(hash(directFile), hash(await readFile(path.join(mediaDir, "sample.mp4"))));
  passed("Click Download saves a byte-identical MP4", { sha256: hash(directFile) });

  await ui(`document.querySelector('#preferences').open=true;document.querySelector('#show-support').click()`);
  await until(() => ui(`document.querySelector('#support').hidden`), "hide support links");
  const stored = await sw(`chrome.storage.local.get('settings')`);
  assert.equal(stored.settings.showSupport, false);
  await ui(`document.querySelector('#show-support').click()`);
  await until(() => ui(`!document.querySelector('#support').hidden`), "show support links");
  passed("Support links are optional and the preference is persisted");

  await ui(`document.querySelector('#preferences').open=false`);
  popupTab = await runStreamScenarios({ browser, fixtureSession, origin, ui, message, sw, until, pause, passed, savedPath, mediaDir, run, ffmpeg, ffprobe, openPopup, slowControllers, popupTab, popupSession: () => popupSession, capture });

  if (storeEdition) {
    await browser.evaluate("fetch('/redirect-excluded.mp4').then(r=>r.text()).catch(()=>{})", fixtureSession);
    await until(async () => (await sw(`chrome.storage.session.get('tab:${fixtureTab}')`))[`tab:${fixtureTab}`]?.items.some(item=>item.url.endsWith('/redirect-excluded.mp4')), "redirect source discovered");
    // The page's own discovery request can follow the redirect. Only downloads
    // requested through VideoDrop must be excluded, without blocking page traffic.
    const excludedRequestsBefore = requests.filter(url=>url==='/excluded.mp4').length;
    const blockedDownload = await message({type:'DOWNLOAD',tabId:fixtureTab,url:origin+'/redirect-excluded.mp4'});
    assert.equal(blockedDownload.ok,false);
    assert.equal(requests.filter(url=>url==='/excluded.mp4').length,excludedRequestsBefore);
    assert.equal((await sw("chrome.downloads.search({})")).some(item=>item.url===origin+'/redirect-excluded.mp4'),false);
    passed("VideoDrop rejects a direct-file redirect to excluded YouTube media before handing it to Chrome", { error: blockedDownload.error });
    const blockedManifest = `#EXTM3U\n#EXTINF:3,\nhttp://rr1.googlevideo.com:${server.address().port}/excluded.mp4\n#EXT-X-ENDLIST`;
    await writeFile(path.join(mediaDir, 'excluded.m3u8'), blockedManifest);
    const before = Object.keys(await sw("chrome.storage.session.get(null)"));
    await browser.evaluate("fetch('/excluded.m3u8').then(r=>r.text())", fixtureSession);
    await until(async () => (await sw(`chrome.storage.session.get('tab:${fixtureTab}')`))[`tab:${fixtureTab}`]?.items.some(item=>item.url.endsWith('/excluded.m3u8')), "excluded manifest discovered");
    const started = await message({type:'DOWNLOAD',tabId:fixtureTab,url:origin+'/excluded.m3u8'});
    assert.equal(started.ok,true);
    const rejected = await until(async()=>{
      const data=await sw("chrome.storage.session.get(null)");
      return Object.entries(data).find(([key,value])=>!before.includes(key)&&key.startsWith('job:')&&value.state==='failed')?.[1];
    }, "excluded HLS segment rejected");
    assert.match(rejected.error,/not supported/);
    assert.equal(requests.filter(url=>url==='/excluded.mp4').length,excludedRequestsBefore);
    passed("An ordinary HLS manifest cannot fetch an excluded YouTube segment");
  }

  await browser.evaluate(`location.href='/empty'`, fixtureSession);
  await until(async () => !(await sw(`chrome.storage.session.get('tab:${fixtureTab}')`))[`tab:${fixtureTab}`]?.items?.length, "navigation clears discovered URLs");
  await until(() => ui(`document.querySelector('#download').disabled && document.querySelector('#video-picker').textContent.includes('No videos')`), "empty page UI");
  await sw("chrome.storage.session.get(null).then(data=>chrome.storage.session.remove(Object.keys(data).filter(key=>key.startsWith('job:'))))");
  await until(()=>ui("document.querySelector('#jobs-section').hidden"), "clean empty state");
  assert.equal(await ui("document.querySelector('#page-context').hidden"), true);
  assert.notEqual(await ui("getComputedStyle(document.querySelector('#download')).backgroundColor"), activeColor);
  assert.ok(await ui("document.querySelector('main').getBoundingClientRect().height <= 250"));
  await capture("popup-empty.png");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, popupSession);
  await capture("popup-empty-dark.png");
  assert.ok(requests.every(url => url.startsWith("/")));
  passed("Navigation clears old media; compact empty state hides redundant page context and distinguishes disabled controls");
  report.result = "passed";
  report.screenshots = [path.join(run, "popup.png"), path.join(run, "popup-hls.png"), path.join(run, "popup-dash.png")];
} catch (error) {
  report.result = "failed"; report.error = error.stack;
  console.error(error.stack);
  if (browser && diagnosticWorker) {
    report.session = await browser.evaluate("chrome.storage.session.get(null)", diagnosticWorker).catch(() => null);
    console.error(JSON.stringify(report.session, null, 2));
  }
  if (browser && popupSession) {
    report.popup = await browser.evaluate("document.body.innerText", popupSession).catch(() => null);
    console.error(report.popup);
  }
  if (browser) console.error(JSON.stringify(await browser.send("Target.getTargets").catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  for (const res of slowControllers) res.destroy();
  if (browser) { await browser.send("Browser.close").catch(() => {}); browser.ws.close(); }
  if (proc && proc.exitCode === null) proc.kill();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await log?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, ".tmp", "latest-browser-report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(root, ".tmp", "latest-browser-report.json")}`);
}
