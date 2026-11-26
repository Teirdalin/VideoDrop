import { pageSource, augmentModel, prepareMedia, initializeEdition, sourceAllowed, assertSourceAllowed, verifyDirectSource } from "./edition.js";
import { DEFAULT_SETTINGS, mergeCandidates, httpUrl, safeFilename, makeCandidate } from "./lib/media.js";
import { serverError } from "./lib/network.js";

const locks = new Map();
const preparations = new Map();
let creatingOffscreen;
const editionReady = initializeEdition();
editionReady.catch(error => console.error("VideoDrop initialization failed", error));
function serial(key, operation) {
  const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
const tabKey = id => `tab:${id}`;
const jobKey = id => `job:${id}`;
async function read(key, fallback) { return (await chrome.storage.session.get(key))[key] ?? fallback; }
async function putJob(id, patch) {
  return serial(jobKey(id), async () => {
    const previous = await read(jobKey(id), {});
    if (["complete", "canceled", "failed"].includes(previous.state) && patch.state && patch.state !== previous.state) return previous;
    const job = { ...previous, ...patch, id, updatedAt: Date.now() };
    await chrome.storage.session.set({ [jobKey(id)]: job });
    return job;
  });
}
async function jobs() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([key]) => key.startsWith("job:")).map(([, value]) => value).sort((a, b) => b.createdAt - a.createdAt);
}
const activeJob = job => ["preparing", "recording", "merging", "downloading", "saving"].includes(job.state);
const streamJob = job => job.kind !== "file" || job.fallback;

async function acquireContext(url, pageUrl, owner) {
  assertSourceAllowed(url); assertSourceAllowed(pageUrl);
  const media = httpUrl(url), referrer = httpUrl(pageUrl);
  if (!media || !referrer) throw new Error("This media source has no usable page context. Reload the page and scan again.");
  return serial("request-context", async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ruleId = Math.max(100000, await read("ruleCounter", 100000), ...rules.map(rule => rule.id)) + 1;
    const escaped = media.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const condition = { initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest", "media", "other"], isUrlFilterCaseSensitive: true };
    if (escaped.length < 1600) condition.regexFilter = `^${escaped}$`;
    else condition.urlFilter = `|${media}|`;
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: ruleId, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: referrer }] }, condition }] });
    await chrome.storage.session.set({ ruleCounter: ruleId, [`context:${ruleId}`]: { owner, createdAt: Date.now() } });
    return ruleId;
  });
}
async function removeContext(ruleId) {
  if (!Number.isInteger(ruleId) || ruleId <= 100000) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  await chrome.storage.session.remove(`context:${ruleId}`);
}
async function contextPage(context) {
  if (context?.jobId) {
    const job = await read(jobKey(context.jobId), null);
    if (!job || !activeJob(job)) throw new Error("This download is no longer active.");
    return job.referrer;
  }
  const data = await read(tabKey(context?.tabId), { items: [] });
  const source = data.items.find(item => item.url === context?.sourceUrl && item.kind !== "file");
  if (!source) throw new Error("This source is no longer on the page. Scan again.");
  return (await chrome.tabs.get(context.tabId)).url;
}

async function collect(tabId, items, flags = {}, pageUrl = "") {
  return serial(tabKey(tabId), async () => {
    const tab = await read(tabKey(tabId), { items: [], pageUrl, updatedAt: Date.now() });
    if (!sourceAllowed(pageUrl || tab.pageUrl)) return;
    // Ignore reports sent by the previous document while a new navigation is starting.
    if (pageUrl && tab.pageUrl && pageUrl !== tab.pageUrl) return;
    tab.items = mergeCandidates(tab.items, items).filter(item => sourceAllowed(item.url));
    tab.hasBlob ||= !!flags.hasBlob;
    tab.hasProtected ||= !!flags.hasProtected;
    tab.updatedAt = Date.now();
    await chrome.storage.session.set({ [tabKey(tabId)]: tab });
    await chrome.action.setBadgeText({ tabId, text: tab.items.length ? String(tab.items.length) : "" }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#247768" }).catch(() => {});
  });
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
  const header = name => details.responseHeaders?.find(item => item.name.toLowerCase() === name)?.value || "";
  const contentRange = header("content-range");
  const bytes = contentRange ? Number(contentRange.split("/")[1]) : Number(header("content-length"));
  const candidate = makeCandidate({ url: details.url, mime: header("content-type"), bytes, source: "network" });
  if (candidate && sourceAllowed(details.initiator || details.documentUrl || "")) editionReady.then(() => chrome.tabs.get(details.tabId)).then(tab => collect(details.tabId, [candidate], {}, tab.url)).then(prune).catch(() => {});
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading") {
    serial(tabKey(tabId), async () => {
      await chrome.storage.session.set({ [tabKey(tabId)]: { items: [], pageUrl: tab.url || "", updatedAt: Date.now() } });
      await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener(tabId => { serial(tabKey(tabId), () => chrome.storage.session.remove(tabKey(tabId))).catch(() => {}); });

async function prune() {
  const all = await chrome.storage.session.get(null);
  const tabs = Object.entries(all).filter(([key]) => key.startsWith("tab:")).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const finished = Object.entries(all).filter(([key, value]) => key.startsWith("job:") && !activeJob(value)).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const stale = [...tabs.slice(20), ...finished.slice(8)].map(([key]) => key);
  if (stale.length) await chrome.storage.session.remove(stale);
}

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    await editionReady;
    await prepareMedia();
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!existing.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS", "WORKERS"], justification: "Fetch complete HLS/DASH tracks and merge audio/video locally in a bundled WebAssembly worker." });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function releaseBlob(job) {
  if (streamJob(job)) await chrome.runtime.sendMessage({ target: "offscreen", type: "RELEASE", jobId: job.id }).catch(() => {});
  if (job.ruleId) await removeContext(job.ruleId).catch(() => {});
}

async function refreshJobs() {
  const list = await jobs();
  for (const job of list.filter(activeJob)) {
    if (Number.isInteger(job.downloadId)) {
      const [download] = await chrome.downloads.search({ id: job.downloadId });
      if (!download || download.state === "interrupted") {
        if (await retryDirect(job, download?.error)) continue;
        await putJob(job.id, { state: "failed", error: serverError(download?.error) });
        await releaseBlob(job);
      } else if (download.state === "complete") {
        await putJob(job.id, { state: "complete", received: download.bytesReceived, totalBytes: download.totalBytes });
        await releaseBlob(job);
      } else await putJob(job.id, { received: download.bytesReceived, totalBytes: download.totalBytes });
    } else if (streamJob(job) && !preparations.has(job.id)) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (!contexts.length) await putJob(job.id, { state: "failed", error: "Video preparation was interrupted. Please try again." });
    }
  }
  return jobs();
}

async function retryDirect(job, reason) {
  if (job.kind !== "file" || !/^(SERVER_|NETWORK_FAILED|NETWORK_INVALID_REQUEST|FILE_FAILED)/.test(reason || "")) return false;
  return serial(`fallback:${job.id}`, async () => {
    const latest = await read(jobKey(job.id), null);
    if (!latest || !activeJob(latest) || latest.fallback) return true;
    if ((await jobs()).some(other => other.id !== job.id && streamJob(other) && activeJob(other))) return false;
    const controller = new AbortController(); preparations.set(job.id, controller);
    try {
      await putJob(job.id, { state: "preparing", fallback: true, downloadId: null, ruleId: null, error: "", saveAs: latest.saveAs });
      if (latest.ruleId) await removeContext(latest.ruleId);
      await ensureOffscreen(); controller.signal.throwIfAborted();
      const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "FETCH_FILE", jobId: job.id, source: { url: latest.sourceUrl, ext: latest.ext }, saveAs: latest.saveAs });
      if (!response?.ok) throw new Error(response?.error || "The site could not serve this media link.");
      if (controller.signal.aborted) await releaseBlob({ ...latest, fallback: true });
    } catch (error) { if (!controller.signal.aborted) await putJob(job.id, { state: "failed", error: error.message }); }
    finally { preparations.delete(job.id); }
    return true;
  });
}

async function startDownload(message) {
  const tab = await chrome.tabs.get(message.tabId);
  assertSourceAllowed(tab.url); assertSourceAllowed(message.url);
  if (message.variantUrl) assertSourceAllowed(message.variantUrl);
  const data = await read(tabKey(tab.id), { items: [] });
  const pageItem = pageSource(tab);
  const item = pageItem?.url === message.url ? pageItem : data.items.find(entry => entry.url === message.url);
  if (!item) throw new Error("This video is no longer on the list. Scan the page again.");
  if (!httpUrl(message.variantUrl || item.url)) throw new Error("The video address is invalid.");
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings };
  const id = crypto.randomUUID();
  const base = { tabId: tab.id, kind: item.kind, title: tab.title || item.title, sourceUrl: item.url, ext: item.ext, saveAs: settings.saveAs, filename: safeFilename(tab.title || item.title, item.kind === "file" ? item.ext : "mp4"), referrer: tab.url, state: "preparing", received: 0, createdAt: Date.now() };
  if (item.kind === "file") {
    await putJob(id, base);
    const controller = new AbortController(); preparations.set(id, controller);
    try {
      let ruleId = await acquireContext(item.url, tab.url, id);
      await putJob(id, { ruleId });
      const downloadUrl = await verifyDirectSource(item.url, controller.signal);
      controller.signal.throwIfAborted();
      if (downloadUrl !== item.url) {
        await removeContext(ruleId);
        ruleId = await acquireContext(downloadUrl, tab.url, id);
        await putJob(id, { ruleId });
      }
      const downloadId = await chrome.downloads.download({ url: downloadUrl, filename: base.filename, conflictAction: "uniquify", saveAs: settings.saveAs });
      const latest = await read(jobKey(id), null);
      if (latest?.state === "canceled") { await chrome.downloads.cancel(downloadId).catch(() => {}); await removeContext(ruleId); }
      else await putJob(id, { downloadId, state: "downloading" });
    } catch (error) {
      await putJob(id, { state: "failed", error: error.message });
      await releaseBlob(await read(jobKey(id), base));
      throw error;
    } finally { preparations.delete(id); }
  } else {
    await serial("stream-start", async () => {
      if ((await jobs()).some(job => streamJob(job) && activeJob(job))) throw new Error("A stream is already downloading. Wait for it to finish, or cancel it below.");
      await putJob(id, base);
      const controller = new AbortController();
      preparations.set(id, controller);
      try {
        await ensureOffscreen();
        controller.signal.throwIfAborted();
        const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "START_STREAM", jobId: id, source: { url: item.url, kind: item.kind }, selection: { variantUrl: message.variantUrl, variantId: message.variantId }, saveAs: settings.saveAs });
        if (!response?.ok) throw new Error(response?.error || "Could not start the video downloader.");
        if (controller.signal.aborted) await releaseBlob({ id, kind: item.kind });
      } catch (error) {
        if (!controller.signal.aborted) await putJob(id, { state: "failed", error: error.message });
        throw error;
      } finally { preparations.delete(id); }
    });
  }
  prune().catch(() => {});
  return { id };
}

async function handle(message, sender) {
  await editionReady;
  if (message.type === "SCAN_RESULT" && sender.tab) {
    if (!sourceAllowed(sender.url || "")) return { ok: true };
    // The main page URL identifies the navigation; frame URLs are deliberately not used.
    await collect(sender.tab.id, Array.isArray(message.items) ? message.items.slice(0, 80) : [], message, sender.tab.url || "");
    await prune();
    return { ok: true };
  }
  const internal = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!internal) throw new Error("Open VideoDrop from the toolbar to use this action.");
  const isOffscreen = sender.url === chrome.runtime.getURL("offscreen.html");
  if (message.type === "MEDIA_CONTEXT" && isOffscreen) {
    const pageUrl = await contextPage(message.context);
    return { ok: true, ruleId: await acquireContext(message.url, pageUrl, message.context.jobId || `inspect:${message.context.tabId}`) };
  }
  if (message.type === "RELEASE_CONTEXT" && isOffscreen) {
    await removeContext(message.ruleId); return { ok: true };
  }
  if (message.type === "STREAM_PROGRESS" && isOffscreen) {
    const job = await read(jobKey(message.jobId), null);
    if (job && activeJob(job) && ["preparing", "recording", "merging"].includes(message.phase)) await putJob(job.id, { state: message.phase, received: message.received, totalBytes: message.totalBytes, done: message.done, total: message.total, capturedSeconds: message.capturedSeconds, live: message.live, detail: message.detail });
    return { ok: true };
  }
  if (message.type === "STREAM_READY" && isOffscreen) {
    const job = await read(jobKey(message.jobId), null);
    if (!job || !["preparing", "recording", "merging"].includes(job.state)) { await releaseBlob({ id: message.jobId, kind: "hls" }); return { ok: false }; }
    try {
      const filename = safeFilename(job.title, message.ext);
      await putJob(job.id, { state: "saving", filename, detail: message.detail });
      const downloadId = await chrome.downloads.download({ url: message.blobUrl, filename, conflictAction: "uniquify", saveAs: !!message.saveAs });
      const latest = await read(jobKey(job.id), null);
      if (latest?.state === "canceled") { await chrome.downloads.cancel(downloadId); await releaseBlob(job); }
      else await putJob(job.id, { state: "downloading", downloadId });
    } catch (error) { await putJob(job.id, { state: "failed", error: error.message }); await releaseBlob(job); }
    return { ok: true };
  }
  if (message.type === "STREAM_FAILED" && isOffscreen) {
    const job = await read(jobKey(message.jobId), null);
    if (job && job.state !== "canceled") await putJob(job.id, { state: "failed", error: message.error });
    return { ok: true };
  }
  if (isOffscreen) throw new Error("Unknown downloader message.");
  switch (message.type) {
    case "GET_MODEL": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const data = tab ? await read(tabKey(tab.id), { items: [] }) : { items: [] };
      return augmentModel({ ok: true, ...data, tabId: tab?.id, title: tab?.title || "This page", pageUrl: tab?.url || "", settings: { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings }, jobs: await refreshJobs() }, tab);
    }
    case "RESCAN":
      await chrome.tabs.sendMessage(message.tabId, { type: "SCAN_NOW" }).catch(() => {});
      return { ok: true };
    case "INSPECT_STREAM": {
      const data = await read(tabKey(message.tabId), { items: [] });
      const tab = await chrome.tabs.get(message.tabId);
      assertSourceAllowed(tab.url); assertSourceAllowed(message.url);
      const pageItem = pageSource(tab);
      const source = pageItem?.url === message.url ? pageItem : data.items.find(item => item.url === message.url && item.kind !== "file");
      if (!source) throw new Error("Scan the page again to find this video.");
      await ensureOffscreen();
      return chrome.runtime.sendMessage({ target: "offscreen", type: "INSPECT", source: { url: source.url, kind: source.kind }, context: { tabId: message.tabId, sourceUrl: source.url } });
    }
    case "DOWNLOAD": return { ok: true, ...await startDownload(message) };
    case "FINISH": {
      const job = await read(jobKey(message.id), null);
      if (job?.state === "recording") await chrome.runtime.sendMessage({ target: "offscreen", type: "FINISH", jobId: job.id });
      return { ok: true };
    }
    case "CANCEL": {
      const job = await read(jobKey(message.id), null);
      if (!job || !activeJob(job)) return { ok: true };
      await putJob(job.id, { state: "canceled" });
      preparations.get(job.id)?.abort();
      if (Number.isInteger(job.downloadId)) await chrome.downloads.cancel(job.downloadId).catch(() => {});
      await releaseBlob(job);
      return { ok: true };
    }
    case "SET_SETTINGS": {
      const settings = { saveAs: !!message.settings.saveAs, showSupport: !!message.settings.showSupport };
      await chrome.storage.local.set({ settings });
      return { ok: true };
    }
    case "SHOW_DOWNLOADS": await chrome.tabs.create({ url: "chrome://downloads/" }); return { ok: true };
    case "SHOW_FILE": {
      const job = await read(jobKey(message.id), null);
      if (job?.state === "complete" && Number.isInteger(job.downloadId)) chrome.downloads.show(job.downloadId);
      return { ok: true };
    }
    default: throw new Error("Unknown VideoDrop action.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") return false;
  handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message || "Something went wrong. Please try again." }));
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state) return;
  (async () => {
    const job = (await jobs()).find(entry => entry.downloadId === delta.id && activeJob(entry));
    if (!job) return;
    if (delta.state.current === "complete") await putJob(job.id, { state: "complete" });
    else if (delta.state.current === "interrupted") {
      if (await retryDirect(job, delta.error?.current)) return;
      await putJob(job.id, { state: "failed", error: serverError(delta.error?.current) });
    }
    else return;
    await releaseBlob(job);
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { prune().catch(() => {}); });
