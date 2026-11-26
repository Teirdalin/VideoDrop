import { inspectSource, downloadSource } from "./media-provider.js";
import { fetchWholeFile } from "./lib/network.js";

const running = new Map(), blobs = new Map();
const send = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "The download manager did not respond.");
  return response;
};
function network(context, signal) {
  return { signal,
    beforeFetch: async url => (await send({ type: "MEDIA_CONTEXT", context, url })).ruleId,
    afterFetch: async ruleId => { await send({ type: "RELEASE_CONTEXT", ruleId }).catch(() => {}); }
  };
}
function control() {
  const controller = new AbortController();
  const result = { controller, signal: controller.signal, finish: false, worker: null, wake: null };
  result.wait = ms => new Promise((resolve, reject) => {
    if (result.signal.aborted) { reject(result.signal.reason); return; }
    const done = () => { clearTimeout(timer); result.signal.removeEventListener("abort", abort); result.wake = null; resolve(); };
    const abort = () => { clearTimeout(timer); result.wake = null; reject(result.signal.reason); };
    const timer = setTimeout(done, ms); result.wake = done;
    result.signal.addEventListener("abort", abort, { once: true });
  });
  return result;
}
async function mux(bundle, active) {
  active.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker("mux-worker.js", { type: "module" });
    active.worker = worker;
    const cancel = () => finish(new DOMException("Download canceled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("The local media engine took too long. Please try a lower quality.")), 150000);
    function finish(error, result) {
      clearTimeout(timer); active.signal.removeEventListener("abort", cancel);
      worker.terminate(); active.worker = null;
      error ? reject(error) : resolve(result);
    }
    active.signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) => data.ok ? finish(null, data) : finish(new Error(data.error));
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || "Could not start the bundled media engine. Reload VideoDrop on the extensions page.")); };
    worker.postMessage(bundle);
  });
}
async function run(message, active) {
  try {
    const options = network({ jobId: message.jobId }, active.signal);
    const onProgress = progress => send({ type: "STREAM_PROGRESS", jobId: message.jobId, ...progress });
    const bundle = await downloadSource(message.source, message.selection, options, active, onProgress);
    const result = await mux(bundle, active);
    active.signal.throwIfAborted();
    const mime = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg" }[result.ext];
    const blobUrl = URL.createObjectURL(new Blob([result.bytes], { type: mime }));
    blobs.set(message.jobId, blobUrl);
    await send({ type: "STREAM_READY", jobId: message.jobId, blobUrl, ext: result.ext, saveAs: message.saveAs, detail: bundle.detail });
  } catch (error) {
    if (!active.signal.aborted) await send({ type: "STREAM_FAILED", jobId: message.jobId, error: error.name === "TimeoutError" ? "The site took too long to serve this stream. Play the video and try again." : error.message }).catch(() => {});
    const url = blobs.get(message.jobId);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.jobId);
  } finally { running.delete(message.jobId); }
}
async function fetchFile(message, active) {
  try {
    const blob = await fetchWholeFile(message.source.url, network({ jobId: message.jobId }, active.signal), progress => send({ type: "STREAM_PROGRESS", jobId: message.jobId, phase: "preparing", ...progress }));
    active.signal.throwIfAborted();
    const blobUrl = URL.createObjectURL(blob); blobs.set(message.jobId, blobUrl);
    await send({ type: "STREAM_READY", jobId: message.jobId, blobUrl, ext: message.source.ext, saveAs: message.saveAs });
  } catch (error) {
    if (!active.signal.aborted) await send({ type: "STREAM_FAILED", jobId: message.jobId, error: error.message }).catch(() => {});
    const url = blobs.get(message.jobId);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.jobId);
  } finally { running.delete(message.jobId); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("background.js")) return false;
  if (message.type === "INSPECT") {
    const controller = new AbortController();
    inspectSource(message.source, network(message.context, controller.signal)).then(playlist => respond({ ok: true, playlist }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "START_STREAM" || message.type === "FETCH_FILE") {
    if (running.size || blobs.size) { respond({ ok: false, error: "Another stream is still being saved. Wait for it to finish or cancel it." }); return false; }
    const active = control(); running.set(message.jobId, active);
    respond({ ok: true });
    if (message.type === "FETCH_FILE") fetchFile(message, active); else run(message, active);
  } else if (message.type === "FINISH") {
    const active = running.get(message.jobId);
    if (active) { active.finish = true; active.wake?.(); }
    respond({ ok: true });
  } else if (message.type === "RELEASE") {
    running.get(message.jobId)?.controller.abort();
    const url = blobs.get(message.jobId);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.jobId); respond({ ok: true });
  }
  return false;
});
