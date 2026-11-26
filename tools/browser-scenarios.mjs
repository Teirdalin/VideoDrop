import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function runStreamScenarios(context) {
  const { browser, fixtureSession, origin, ui, message, sw, until, pause, passed, savedPath, mediaDir, run, ffmpeg, ffprobe, openPopup, slowControllers, capture } = context;
  let popupTab = context.popupTab;
  const snapshot = async () => Object.entries(await sw("chrome.storage.session.get(null)")).filter(([key]) => key.startsWith("job:")).map(([, value]) => value);
  async function waitState(id, state = "complete") {
    return until(async () => {
      const job = (await snapshot()).find(item => item.id === id);
      if (job?.state === "failed") { const error = new Error(job.error); error.fatal = true; throw error; }
      return job?.state === state && job;
    }, `${id} ${state}`, 45000);
  }
  async function selectSource(route) {
    await browser.evaluate(`fetch(${JSON.stringify(route)}).then(r=>r.arrayBuffer())`, fixtureSession);
    await until(() => ui(`(()=>{const p=document.querySelector('#video-picker'),url=${JSON.stringify(origin+route)};const option=[...p.options].find(o=>o.value===url||o.value.startsWith(url+'|'));if(!option)return false;if(p.value!==option.value){p.value=option.value;p.dispatchEvent(new Event('change'));}return !document.querySelector('#download').disabled&&(p.value===url||p.value.startsWith(url+'|'));})()`), `${route} discovered and inspected`);
  }
  async function clickDownload() {
    await until(() => ui(`!document.querySelector('#download').disabled`), "Download enabled");
    const previous = new Set((await snapshot()).map(job => job.id));
    await ui(`document.querySelector('#download').click()`);
    return until(async () => (await snapshot()).find(job => !previous.has(job.id)), "new download job");
  }
  const sourceFrames = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(mediaDir, "sample.mp4"), "-map", "0:v:0", "-f", "framemd5", "pipe:1"], { windowsHide: true, encoding: "utf8" }).split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
  async function verifyAV(job, name) {
    const filename = await savedPath(job);
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets,duration:format=duration", "-of", "json", filename], { windowsHide: true, encoding: "utf8" }));
    const audio = probe.streams.find(stream => stream.codec_type === "audio"); assert.ok(audio);
    assert.ok(Number(audio.nb_read_packets) >= 129, `${name}: the complete AAC audio track is retained`);
    const video = probe.streams.find(stream => stream.codec_type === "video"); assert.ok(video);
    assert.ok(Number(video.nb_read_packets) >= 36, `${name}: all 36 video packets are retained`);
    assert.ok(Number(probe.format.duration) >= 2.9 && Number(probe.format.duration) < 3.5, `${name}: full three-second duration`);
    const frames = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", filename, "-map", "0:v:0", "-f", "framemd5", "pipe:1"], { windowsHide: true, encoding: "utf8" }).split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
    assert.deepEqual(frames, sourceFrames, `${name}: decoded frames, including the final frame, match the source`);
    const bytes = await readFile(filename);
    passed(name, { sha256: createHash("sha256").update(bytes).digest("hex"), duration: probe.format.duration, videoPackets: video.nb_read_packets });
  }

  await selectSource("/protected.mp4");
  await verifyAV(await waitState((await clickDownload()).id), "Referrer/cookie-protected direct media downloads instead of returning file unavailable");

  await selectSource("/master.m3u8");
  await until(() => ui(`document.querySelector('#video-picker').selectedOptions[0].textContent.includes('180p')`), "HLS quality expanded");
  await capture("popup-hls.png");
  assert.equal(await ui("document.documentElement.scrollWidth <= innerWidth"), true);
  await verifyAV(await waitState((await clickDownload()).id), "HLS MPEG-TS downloads every segment and remuxes the full video/audio to MP4");

  // Discovery can refresh the list while the previous download completes.
  await selectSource('/master.m3u8');
  await ui(`{const p=document.querySelector('#video-picker');p.value=[...p.options].find(o=>o.textContent.includes('90p')).value;p.dispatchEvent(new Event('change'));}`);
  await verifyAV(await waitState((await clickDownload()).id), "HLS fragmented MP4 retains initialization, full duration, audio and final video frame");

  await selectSource("/locked/separate/master.m3u8");
  assert.match(await ui("document.querySelector('#video-picker').selectedOptions[0].textContent"), /180p/);
  await capture("popup-separate.png");
  await verifyAV(await waitState((await clickDownload()).id), "Separate HLS audio/video tracks merge automatically with source referrer and cookies");

  await selectSource("/locked/dash/index.mpd");
  assert.match(await ui("document.querySelector('#selection-meta').textContent"), /DASH/);
  await capture("popup-dash.png");
  await verifyAV(await waitState((await clickDownload()).id), "DASH timeline video and separate audio merge into a complete playable MP4");

  for (const [route, label] of [["/dash/numbered.mpd", "DASH Number templates fetch the final video and audio fragments"], ["/list/index.mpd", "DASH SegmentList byte ranges preserve the full video and audio"], ["/indexed/index.mpd", "DASH SegmentBase SIDX indexes resolve complete ranged tracks"]]) {
    await selectSource(route);
    await verifyAV(await waitState((await clickDownload()).id), label);
  }

  await selectSource("/delayed.m3u8");
  await verifyAV(await waitState((await clickDownload()).id), "Slow manifest downloads survive status polling");

  await selectSource("/growing.m3u8");
  await verifyAV(await waitState((await clickDownload()).id), "Growing HLS records newly published segments and saves automatically at ENDLIST");

  await selectSource("/endless.m3u8");
  const endless = await clickDownload(); await waitState(endless.id, "recording");
  await sw(`chrome.tabs.remove(${popupTab})`); await pause(500); popupTab = await openPopup();
  await until(() => ui(`document.querySelector('#jobs').textContent.includes('Finish & save')`), "Finish control after reopening popup");
  await capture("popup-live.png");
  await ui(`[...document.querySelectorAll('#jobs button')].find(b=>b.textContent==='Finish & save').click()`);
  await verifyAV(await waitState(endless.id), "Live HLS survives popup closure and Finish & save creates a complete recorded file");

  await browser.evaluate(`fetch('/encrypted.m3u8').then(r=>r.text())`, fixtureSession);
  await until(() => ui(`[...document.querySelector('#video-picker').options].some(o=>o.value.endsWith('/encrypted.m3u8'))`), "encrypted source discovered");
  await ui(`{const p=document.querySelector('#video-picker');p.value=${JSON.stringify(origin + "/encrypted.m3u8")};p.dispatchEvent(new Event('change'));}`);
  await until(() => ui(`document.querySelector('#selection-meta').textContent.includes('Encrypted') && document.querySelector('#download').disabled`), "encryption explained");
  passed("Encrypted streams remain clearly explained and are not saved as unusable files");

  await selectSource("/slow.m3u8"); const slow = await clickDownload();
  await until(() => slowControllers.size === 1, "pending media request");
  const cancel = await message({ type: "CANCEL", id: slow.id }); assert.equal(cancel.ok, true);
  await waitState(slow.id, "canceled");
  await until(() => slowControllers.size === 0, "cancellation aborts fetching");
  const contexts = Object.keys(await sw("chrome.storage.session.get(null)")).filter(key => key.startsWith("context:"));
  assert.equal(contexts.length, 0);
  passed("Cancel aborts segment fetching and releases temporary referrer rules");
  return popupTab;
}
