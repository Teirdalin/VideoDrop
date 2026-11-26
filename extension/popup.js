import { displayName, formatBytes } from "./lib/media.js";
import { buildLabel, emptyPageMessage, selectionDetails } from "./edition.js";

const $ = id => document.getElementById(id);
const picker = $("video-picker");
$("build-info").textContent = `VideoDrop ${chrome.runtime.getManifest().version} · ${buildLabel}`;
const ACTIVE = ["preparing", "recording", "merging", "downloading", "saving"];
let model, choices = [], selected = "", busy = false, reading = false, choiceToken = 0;
let signature = "", hlsCache = new Map();
const send = async message => {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "VideoDrop couldn't connect. Reopen the popup and try again.");
  return result;
};
function notice(text = "") { $("notice").textContent = text; $("notice").hidden = !text; }
function selection() { return choices.find(item => item.key === picker.value); }

function describe() {
  const choice = selection();
  $("download").querySelector("span").textContent = busy ? "Starting…" : choice?.variantId === "audio:mp3" ? "Download MP3" : "Download";
  $("download").disabled = busy || !choice || !!choice.blocked;
  if (!choice) return;
  const details = selectionDetails(choice);
  if (details !== null) { $("selection-meta").textContent = details; return; }
  let text = choice.blocked || (choice.item.kind === "file" ? [choices.length > 1 ? choice.item.ext.toUpperCase() : "", formatBytes(choice.item.bytes)].filter(Boolean).join(" · ") : choice.loading ? "Checking available qualities…" : choice.live ? "Live HLS · Use Finish & save to stop" : `${choice.item.kind === "dash" ? "DASH" : "HLS"} stream`);
  $("selection-meta").textContent = text;
}

async function selectVideo() {
  selected = picker.value;
  const token = ++choiceToken;
  describe();
  const choice = selection();
  if (!choice || choice.item.kind === "file" || choice.expanded) return;
  choice.loading = true;
  choice.blocked = "Checking video qualities…";
  describe();
  try {
    const cacheKey = `${model.tabId}:${choice.item.url}`;
    let playlist = hlsCache.get(cacheKey);
    if (!playlist) {
      playlist = (await send({ type: "INSPECT_STREAM", tabId: model.tabId, url: choice.item.url })).playlist;
      hlsCache.set(cacheKey, playlist);
    }
    if (token !== choiceToken) return;
    if (Array.isArray(playlist.variants)) {
      if (playlist.blocked || !playlist.variants.length) {
        Object.assign(choice, { expanded: true, loading: false, blocked: playlist.blocked || "No video qualities were found." });
        describe(); return;
      }
      const variants = playlist.variants.map(variant => ({ key: `${choice.item.url}|${variant.url || variant.id}`, item: choice.item, variantUrl: variant.url, variantId: variant.id, expanded: true, blocked: variant.blocked, ext: variant.ext || "mp4", label: variant.label || `${variant.height ? `${variant.height}p` : "Original quality"}${variant.blocked ? " · unavailable" : ""}` }));
      choices.splice(choices.indexOf(choice), 1, ...variants);
      selected = (variants.find(variant => !variant.blocked) || variants[0])?.key || "";
    } else {
      Object.assign(choice, { expanded: true, loading: false, blocked: playlist.blocked, ext: playlist.ext, live: playlist.live });
    }
    renderChoices();
    describe();
  } catch (error) {
    if (token !== choiceToken) return;
    choice.loading = false;
    choice.blocked = error.message;
    describe();
  }
}

function renderChoices() {
  picker.replaceChildren();
  for (const [index, choice] of choices.entries()) {
    const label = choice.label || (choices.length === 1 && choice.item.kind === "file" ? `${choice.item.height ? `${choice.item.height}p` : "Original"} · ${choice.item.ext.toUpperCase()}` : displayName(choice.item, index));
    const option = new Option(label, choice.key);
    // Keep unavailable choices selectable so their explanation remains readable.
    picker.add(option);
  }
  if (!choices.length) picker.add(new Option("No videos detected", ""));
  picker.disabled = !choices.length;
  if (choices.some(choice => choice.key === selected)) picker.value = selected;
  else { selected = choices[0]?.key || ""; picker.value = selected; }
}

function renderJobs(list) {
  $("jobs-section").hidden = !list.length;
  $("jobs").replaceChildren();
  const visible = [...list.filter(job => ACTIVE.includes(job.state)), ...list.filter(job => !ACTIVE.includes(job.state)).slice(0, 3)];
  for (const job of visible) {
    const active = ACTIVE.includes(job.state);
    const card = document.createElement("div");
    card.className = `job ${job.state}`;
    const top = document.createElement("div"); top.className = "job-top";
    const name = document.createElement("span"); name.className = "job-name"; name.textContent = job.filename; name.title = job.filename;
    top.append(name);
    const actions = document.createElement("span"); actions.className = "job-actions";
    if (job.state === "recording") {
      const finish = document.createElement("button"); finish.type = "button"; finish.textContent = "Finish & save";
      finish.addEventListener("click", async () => {
        finish.disabled = true;
        try { await send({ type: "FINISH", id: job.id }); } catch (error) { notice(error.message); finish.disabled = false; }
      });
      actions.append(finish);
    }
    if (active || job.state === "complete") {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = active ? "Cancel" : "Show";
      button.setAttribute("aria-label", `${active ? "Cancel" : "Show"} ${job.filename}`);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await send({ type: active ? "CANCEL" : "SHOW_FILE", id: job.id }); await refresh(); }
        catch (error) { notice(error.message); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    top.append(actions);
    const state = document.createElement("div"); state.className = "job-state";
    state.textContent = job.state === "preparing" ? `Downloading media${job.total ? ` · ${job.done}/${job.total} parts` : "…"}${job.received ? ` · ${formatBytes(job.received)}` : ""}` : job.state === "recording" ? `Recording · ${Math.floor((job.capturedSeconds || 0) / 60)}:${String(Math.floor((job.capturedSeconds || 0) % 60)).padStart(2, "0")} · ${job.done || 0} parts${job.received ? ` · ${formatBytes(job.received)}` : ""}` : job.state === "merging" ? (job.detail?.startsWith("MP3") ? "Converting to MP3…" : "Merging tracks…") : job.state === "saving" ? "Saving…" : job.state === "complete" ? `Saved${job.detail ? ` · ${job.detail}` : ""}` : job.state === "canceled" ? "Canceled" : job.state === "failed" ? job.error : `Downloading${job.received ? ` · ${formatBytes(job.received)}` : "…"}`;
    card.append(top, state);
    if (active) {
      const progress = document.createElement("progress");
      progress.setAttribute("aria-label", `Download progress for ${job.filename}`);
      if (job.state === "preparing" && job.total) { progress.max = job.total; progress.value = job.done || 0; }
      else if (job.totalBytes > 0) { progress.max = job.totalBytes; progress.value = job.received || 0; }
      card.append(progress);
    }
    $("jobs").append(card);
  }
}

async function refresh() {
  if (reading) return;
  reading = true;
  try {
    const next = await send({ type: "GET_MODEL" });
    const oldTab = model?.tabId;
    model = next;
    const title = model.title === "This page" ? "" : model.title;
    $("page-title").textContent = title;
    $("page-title").title = title;
    $("page-title").hidden = !title;
    $("page-context").hidden = !model.items.length;
    try { $("page-host").textContent = new URL(model.pageUrl).hostname.replace(/^www\./, ""); }
    catch { $("page-host").textContent = ""; }
    $("save-as").checked = model.settings.saveAs;
    $("show-support").checked = model.settings.showSupport;
    $("support").hidden = !model.settings.showSupport;
    $("save-note").textContent = model.settings.saveAs ? "Choose a save location when downloading" : "Saves to your Downloads folder";
    renderJobs(model.jobs);
    const nextSignature = JSON.stringify([model.tabId, model.items]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      if (oldTab !== model.tabId) { hlsCache.clear(); selected = ""; }
      choices = model.items.map(item => ({ key: item.url, item, blocked: "" }));
      renderChoices();
      await selectVideo();
    }
    if (!model.items.length) {
      $("download").disabled = true;
      $("selection-meta").textContent = emptyPageMessage(model.pageUrl) || (!/^https?:\/\//.test(model.pageUrl) ? "Open a video page to get started." : model.hasProtected ? "This player uses protected media." : model.hasBlob ? "Play the video, then rescan for its stream." : "Play a video on this page, then rescan.");
    }
  } catch (error) { notice(error.message); }
  finally { reading = false; }
}

picker.addEventListener("change", () => { notice(); selectVideo(); });
$("rescan").addEventListener("click", async () => {
  $("rescan").disabled = true;
  notice();
  try {
    hlsCache.clear(); signature = "";
    await send({ type: "RESCAN", tabId: model?.tabId });
    await new Promise(resolve => setTimeout(resolve, 450));
    await refresh();
  } catch (error) { notice(error.message); }
  finally { $("rescan").disabled = false; }
});
$("download").addEventListener("click", async () => {
  const choice = selection();
  if (!choice || busy || choice.blocked) return;
  busy = true; describe(); notice();
  $("download").querySelector("span").textContent = "Starting download…";
  try { await send({ type: "DOWNLOAD", tabId: model.tabId, url: choice.item.url, variantUrl: choice.variantUrl, variantId: choice.variantId }); await refresh(); }
  catch (error) { notice(error.message); }
  finally { busy = false; $("download").querySelector("span").textContent = "Download"; describe(); }
});
for (const id of ["save-as", "show-support"]) $(id).addEventListener("change", async () => {
  try { await send({ type: "SET_SETTINGS", settings: { saveAs: $("save-as").checked, showSupport: $("show-support").checked } }); await refresh(); }
  catch (error) { notice(error.message); }
});
$("all-downloads").addEventListener("click", () => send({ type: "SHOW_DOWNLOADS" }).catch(error => notice(error.message)));
await refresh();
setInterval(refresh, 1500);
