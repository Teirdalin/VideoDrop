import test from "node:test";
import assert from "node:assert/strict";

function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); } }; }
function storage() {
  return {
    data: {},
    async get(key) { return key === null ? structuredClone(this.data) : { [key]: structuredClone(this.data[key]) }; },
    async set(values) { Object.assign(this.data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
  };
}
const tab = { id: 7, url: "https://page.test/watch", title: "A good video" };
const session = storage(), local = storage(), downloaded = [], currentDownloads = new Map();
const rules = new Map(), dynamicRules = new Map(), offscreenMessages = [];
let contextExists = false;
globalThis.chrome = {
  storage: { session, local },
  runtime: { id: "test", onMessage: event(), onStartup: event(), getURL: value => `chrome-extension://test/${value}`, getContexts: async () => contextExists ? [{}] : [], sendMessage: async message => { offscreenMessages.push(message); return { ok: true }; } },
  offscreen: { createDocument: async () => { contextExists = true; } },
  declarativeNetRequest: { getSessionRules: async () => [...rules.values()], updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => { for (const id of removeRuleIds) rules.delete(id); for (const rule of addRules) rules.set(rule.id, rule); }, updateDynamicRules: async ({addRules=[],removeRuleIds=[]})=>{for(const id of removeRuleIds)dynamicRules.delete(id);for(const rule of addRules)dynamicRules.set(rule.id,rule);} },
  webRequest: { onHeadersReceived: event() },
  tabs: { onUpdated: event(), onRemoved: event(), get: async () => tab, query: async () => [tab], sendMessage: async () => {}, create: async () => {} },
  downloads: {
    onChanged: event(),
    async download(options) { const id = downloaded.push(options); currentDownloads.set(id, { id, state: "in_progress", bytesReceived: 0 }); return id; },
    async search({ id }) { return currentDownloads.has(id) ? [currentDownloads.get(id)] : []; },
    async cancel(id) { currentDownloads.get(id).state = "interrupted"; },
    show() {}
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
};
await import("../extension/background.js");
const internal = { id: "test", url: "chrome-extension://test/popup.html" };
const page = { id: "test", url: tab.url, tab };
function send(message, sender = internal) {
  return new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, sender, resolve));
}
async function eventually(fn) {
  for (let attempt = 0; attempt < 30; attempt++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Expected asynchronous event did not finish");
}

test("the main extension exposes YouTube and routes quality inspection without a helper", async () => {
  const original=tab.url;
  try {
    tab.url='https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    const model=await send({type:'GET_MODEL'});
    assert.equal(model.items[0].kind,'youtube');
    assert.equal(model.items[0].url,tab.url);
    assert.equal((await send({type:'INSPECT_STREAM',tabId:tab.id,url:tab.url})).ok,true);
    assert.equal(offscreenMessages.at(-1).source.kind,'youtube');
    assert.equal(dynamicRules.size,2);
    assert.ok([...dynamicRules.values()].every(rule=>rule.condition.initiatorDomains.length===1 && rule.condition.initiatorDomains[0]===chrome.runtime.id));
  } finally {tab.url=original;contextExists=false;}
});
test("page messages cannot initiate downloads or change preferences", async () => {
  assert.equal((await send({ type: "DOWNLOAD", tabId: 7, url: "https://page.test/a.mp4" }, page)).ok, false);
  assert.equal((await send({ type: "SET_SETTINGS", settings: { saveAs: true } }, page)).ok, false);
  assert.equal(downloaded.length, 0);
});
test("simultaneous frame reports merge without losing videos", async () => {
  await Promise.all([
    send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/a.mp4", height: 720 }], hasBlob: true }, page),
    send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/b.webm" }], hasProtected: true }, page)
  ]);
  assert.equal(session.data["tab:7"].items.length, 2);
  assert.equal(session.data["tab:7"].hasBlob, true);
  assert.equal(session.data["tab:7"].hasProtected, true);
});
test("network discovery uses total size of a ranged file and ignores failed responses", async () => {
  const handler = chrome.webRequest.onHeadersReceived.listeners[0];
  handler({ tabId: 7, statusCode: 206, url: "https://cdn.test/c.mp4?token=1", responseHeaders: [{ name: "Content-Type", value: "video/mp4" }, { name: "Content-Range", value: "bytes 0-99/10000" }] });
  await eventually(() => session.data["tab:7"].items.some(item => item.url.includes("c.mp4")));
  assert.equal(session.data["tab:7"].items.find(item => item.url.includes("c.mp4")).bytes, 10000);
  handler({ tabId: 7, statusCode: 403, url: "https://cdn.test/expired.mp4" });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session.data["tab:7"].items.some(item => item.url.includes("expired")), false);
});
test("only a detected source can be downloaded and filenames use the page title", async () => {
  assert.equal((await send({ type: "DOWNLOAD", tabId: 7, url: "https://unknown.test/evil.exe" })).ok, false);
  const result = await send({ type: "DOWNLOAD", tabId: 7, url: "https://cdn.test/a.mp4" });
  assert.equal(result.ok, true);
  assert.equal(downloaded.at(-1).filename, "A good video.mp4");
  assert.equal(downloaded.at(-1).saveAs, false);
  assert.equal(downloaded.at(-1).url, "https://cdn.test/a.mp4");
  const rule = [...rules.values()][0];
  assert.equal(rule.action.requestHeaders[0].value, tab.url);
  assert.deepEqual(rule.condition.initiatorDomains, ["test"]);
  assert.equal(new RegExp(rule.condition.regexFilter).test("https://cdn.test/a.mp4"), true);
  assert.equal(new RegExp(rule.condition.regexFilter).test("https://cdn.test/aXmp4"), false);
  currentDownloads.get(downloaded.length).state = "complete";
  const model = await send({ type: "GET_MODEL" });
  assert.equal(model.jobs.find(job => job.id === result.id).state, "complete");
  assert.equal(model.pageUrl, tab.url);
});
test("preferences persist and cancellation reaches Chrome's downloader", async () => {
  await send({ type: "SET_SETTINGS", settings: { saveAs: true, showSupport: false } });
  const result = await send({ type: "DOWNLOAD", tabId: 7, url: "https://cdn.test/b.webm" });
  assert.equal(downloaded.at(-1).saveAs, true);
  await send({ type: "CANCEL", id: result.id });
  const model = await send({ type: "GET_MODEL" });
  assert.equal(model.jobs.find(job => job.id === result.id).state, "canceled");
  assert.equal(currentDownloads.get(downloaded.length).state, "interrupted");
  assert.equal(model.settings.showSupport, false);
});
test("slow offscreen startup survives polling and cancellation prevents segment capture", async () => {
  const originalCreate = chrome.offscreen.createDocument;
  let complete;
  chrome.offscreen.createDocument = () => new Promise(resolve => { complete = () => { contextExists = true; resolve(); }; });
  try {
    await send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/slow.m3u8" }] }, page);
    const started = send({ type: "DOWNLOAD", tabId: 7, url: "https://cdn.test/slow.m3u8" });
    await eventually(() => !!complete);
    const model = await send({ type: "GET_MODEL" });
    const job = model.jobs.find(job => job.kind === "hls");
    assert.equal(job.state, "preparing");
    await send({ type: "CANCEL", id: job.id });
    complete();
    await started;
    assert.equal(session.data[`job:${job.id}`].state, "canceled");
    assert.equal(offscreenMessages.some(message => message.type === "START_STREAM" && message.jobId === job.id), false);
  } finally { chrome.offscreen.createDocument = originalCreate; }
});
test("DASH jobs preserve the chosen representation, merge phase, final extension and scoped request cleanup", async () => {
  await send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/index.mpd" }] }, page);
  const result = await send({ type: "DOWNLOAD", tabId: 7, url: "https://cdn.test/index.mpd", variantId: "720p" });
  assert.equal(result.ok, true);
  assert.equal(offscreenMessages.find(message => message.type === "START_STREAM" && message.jobId === result.id).selection.variantId, "720p");
  const worker = { id: "test", url: "chrome-extension://test/offscreen.html" };
  const context = await send({ type: "MEDIA_CONTEXT", context: { jobId: result.id }, url: "https://cdn.test/audio-1.m4s" }, worker);
  assert.equal(context.ok, true);
  await send({ type: "RELEASE_CONTEXT", ruleId: context.ruleId }, worker);
  assert.equal(rules.has(context.ruleId), false);
  await send({ type: "STREAM_PROGRESS", jobId: result.id, phase: "merging", received: 1000, done: 4, total: 4 }, worker);
  assert.equal(session.data[`job:${result.id}`].state, "merging");
  await send({ type: "STREAM_READY", jobId: result.id, ext: "mkv", blobUrl: "blob:chrome-extension://test/video" }, worker);
  assert.equal(downloaded.at(-1).filename, "A good video.mkv");
  currentDownloads.get(downloaded.length).state = "complete";
  await send({ type: "GET_MODEL" });
  assert.equal(session.data[`job:${result.id}`].state, "complete");
});
test("native file-unavailable errors automatically retry once through page-context fetching", async () => {
  await send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/protected.mp4" }] }, page);
  const started = await send({ type: "DOWNLOAD", tabId: 7, url: "https://cdn.test/protected.mp4" });
  const nativeId = downloaded.length;
  Object.assign(currentDownloads.get(nativeId), { state: "interrupted", error: "SERVER_BAD_CONTENT" });
  const model = await send({ type: "GET_MODEL" });
  const retry = model.jobs.find(job => job.id === started.id);
  assert.equal(retry.state, "preparing");
  assert.equal(retry.fallback, true);
  assert.equal(offscreenMessages.filter(message => message.type === "FETCH_FILE" && message.jobId === started.id).length, 1);
  await send({ type: "GET_MODEL" });
  assert.equal(offscreenMessages.filter(message => message.type === "FETCH_FILE" && message.jobId === started.id).length, 1);
  await send({ type: "CANCEL", id: started.id });
});
test("navigation clears old media and rejects late reports from the old page", async () => {
  chrome.tabs.onUpdated.listeners[0](7, { status: "loading" }, { ...tab, url: "https://new.test/" });
  await eventually(() => session.data["tab:7"].pageUrl === "https://new.test/");
  await send({ type: "SCAN_RESULT", items: [{ url: "https://cdn.test/old.mp4" }] }, page);
  assert.deepEqual(session.data["tab:7"].items, []);
  chrome.tabs.onRemoved.listeners[0](7);
  await eventually(() => !session.data["tab:7"]);
});
