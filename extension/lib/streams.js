import { parsePlaylist, MAX_HLS_BYTES, MAX_SEGMENTS } from "./hls.js";
import { parseDash, parseSidx } from "./dash.js";
import { getResource, getText } from "./network.js";

function hlsAddress(url) {
  const address = new URL(url);
  for (const key of ["_HLS_msn", "_HLS_part", "_HLS_skip"]) address.searchParams.delete(key);
  return address.href;
}
async function hls(url, options) {
  const result = await getText(hlsAddress(url), options);
  return parsePlaylist(result.text, result.url);
}
async function dash(url, options) {
  const result = await getText(url, options);
  return parseDash(result.text, result.url);
}
export async function inspectStream(source, options) {
  if (source.kind === "dash") {
    const parsed = await dash(source.url, options);
    return { type: "dash", blocked: parsed.blocked, variants: parsed.variants.map(item => ({ id: item.id, height: item.height, bandwidth: item.bandwidth, blocked: item.blocked, separateAudio: !!item.audio, ext: item.ext })) };
  }
  const parsed = await hls(source.url, options);
  return parsed.type === "master" ? parsed : { type: "media", live: parsed.live, blocked: parsed.blocked, ext: "mp4", duration: parsed.duration };
}
export async function resolveStream(source, selection, options) {
  if (source.kind === "dash") {
    const parsed = await dash(source.url, options);
    if (parsed.blocked) throw new Error(parsed.blocked);
    const variant = parsed.variants.find(item => item.id === selection.variantId) || (!selection.variantId ? parsed.variants.find(item => !item.blocked) : null);
    if (!variant) throw new Error("This quality is no longer available. Scan again to refresh the list.");
    if (variant.blocked) throw new Error(variant.blocked);
    return { kind: "dash", live: false, ext: variant.ext, duration: variant.video.duration, tracks: [variant.video, ...(variant.audio ? [variant.audio] : [])] };
  }
  let video = await hls(source.url, options), audioUrl = "";
  if (video.type === "master") {
    const variant = video.variants.find(item => item.url === selection.variantUrl) || (!selection.variantUrl ? video.variants.find(item => !item.blocked) : null);
    if (!variant) throw new Error("This quality is no longer available. Scan again to refresh the list.");
    if (variant.blocked) throw new Error(variant.blocked);
    audioUrl = variant.audioUrl;
    video = await hls(variant.url, options);
  }
  if (video.type !== "media" || video.blocked) throw new Error(video.blocked || "Nested HLS master playlists are not supported.");
  const tracks = [{ kind: "video", playlist: video, url: video.url }];
  if (audioUrl) {
    const audio = await hls(audioUrl, options);
    if (audio.type !== "media" || audio.blocked) throw new Error(audio.blocked || "The audio source did not return a media playlist.");
    tracks.push({ kind: "audio", playlist: audio, url: audio.url });
  }
  return { kind: "hls", ext: "mp4", live: tracks.some(track => track.playlist.live), duration: video.duration, tracks };
}
function checkMedia(reply) {
  if (/text\/html|application\/(?:json|.*mpegurl|dash\+xml)/i.test(reply.mime)) throw new Error("The site returned a page instead of media data. Replay the video and scan again.");
}
export async function downloadStream(plan, options, control, progress = () => {}) {
  const files = [], inputs = [];
  const budget = { received: 0, done: 0, total: 0, capturedSeconds: 0 };
  let detail = "";
  const live = plan.live;
  const progressNow = phase => progress({ phase, ...budget, total: live ? 0 : budget.total, detail, live });
  async function getPart(part, name) {
    const reply = await getResource(part, { ...options, maxBytes: MAX_HLS_BYTES - budget.received });
    checkMedia(reply);
    budget.received += reply.bytes.length;
    if (budget.received > MAX_HLS_BYTES) throw new Error("This stream exceeds the 512 MB memory limit.");
    files.push({ name, blob: new Blob([reply.bytes]) }); budget.done++;
    return name;
  }
  if (plan.kind === "dash") {
    for (const track of plan.tracks) {
      if (track.index) {
        const reply = await getResource(track.index, { ...options, maxBytes: 2 * 1024 * 1024 });
        track.segments = parseSidx(reply.bytes, track.index.range.start, track.index.url);
      }
      budget.total += track.segments.length + Number(!!track.map);
    }
    for (const [index, track] of plan.tracks.entries()) {
      const pieces = [], parts = [...(track.map ? [track.map] : []), ...track.segments];
      for (let n = 0; n < parts.length; n++) {
        control.signal.throwIfAborted();
        await getPart(parts[n], `dash-${index}-${n}.bin`); pieces.push(files.pop().blob);
        if (track.kind === "video" && n >= Number(!!track.map)) budget.capturedSeconds += parts[n].duration || 0;
        await progressNow("preparing");
      }
      const name = `track-${index}.${/webm/.test(track.mime) ? "webm" : "mp4"}`;
      files.push({ name, blob: new Blob(pieces) }); inputs.push({ name, kind: track.kind });
    }
  } else {
    const states = plan.tracks.map((track, index) => ({ ...track, index, records: [], nextSequence: null, seen: new Set(), maps: new Map(), ended: false }));
    budget.total = states.reduce((sum, track) => sum + track.playlist.segments.length + new Set(track.playlist.segments.filter(segment => segment.map).map(segment => JSON.stringify(segment.map))).size, 0);
    const startedAt = Date.now();
    while (true) {
      control.signal.throwIfAborted();
      for (const track of states) {
        const playlist = track.playlist;
        if (playlist.blocked) throw new Error(playlist.blocked);
        if (track.nextSequence !== null && playlist.segments.length && playlist.segments[0].sequence > track.nextSequence) throw new Error("The live stream advanced before all parts could be fetched. VideoDrop stopped to avoid silently skipping video.");
        for (const segment of playlist.segments) {
          if (track.seen.has(segment.sequence) || track.nextSequence !== null && segment.sequence < track.nextSequence) continue;
          if (track.records.length >= MAX_SEGMENTS) throw new Error("This stream has too many segments to save in one file.");
          let mapName = "";
          if (segment.map) {
            const key = JSON.stringify(segment.map);
            if (!track.maps.has(key)) {
              const name = `hls-${track.index}-init-${track.maps.size}.bin`;
              await getPart(segment.map, name); track.maps.set(key, name);
            }
            mapName = track.maps.get(key);
          }
          const name = `hls-${track.index}-${track.records.length}.bin`;
          await getPart(segment, name);
          track.records.push({ name, duration: segment.duration, mapName, discontinuity: segment.discontinuity });
          track.seen.add(segment.sequence); track.nextSequence = segment.sequence + 1;
          if (track.kind === "video") budget.capturedSeconds += segment.duration;
          await progressNow(live ? "recording" : "preparing");
        }
        track.ended = !playlist.live;
      }
      if (!live || states.every(track => track.ended) || control.finish) break;
      await progressNow("recording");
      if (Date.now() - startedAt > 6 * 60 * 60 * 1000) { detail = "Recording reached the six-hour safety limit."; break; }
      await control.wait(Math.max(500, Math.min(8000, Math.min(...states.map(track => track.playlist.targetDuration)) * 500)));
      if (control.finish) break;
      for (const track of states.filter(track => !track.ended)) track.playlist = await hls(track.url, options);
    }
    if (!states[0].records.length) throw new Error("No complete video segment has arrived yet. Let the stream play briefly and try again.");
    for (const track of states) {
      if (!track.records.length) throw new Error("The stream has not supplied its audio track yet. Let it play briefly and try again.");
      let previousMap = "";
      const playlist = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...track.records.map(item => item.duration))))}`];
      for (const item of track.records) {
        if (item.discontinuity) playlist.push("#EXT-X-DISCONTINUITY");
        if (item.mapName && previousMap !== item.mapName) { playlist.push(`#EXT-X-MAP:URI="${item.mapName}"`); previousMap = item.mapName; }
        playlist.push(`#EXTINF:${item.duration},`, item.name);
      }
      playlist.push("#EXT-X-ENDLIST");
      const name = `track-${track.index}.m3u8`;
      files.push({ name, blob: new Blob([playlist.join("\n") + "\n"]) }); inputs.push({ name, kind: track.kind, hls: true });
    }
  }
  await progressNow("merging");
  return { files, inputs, ext: plan.ext, duration: budget.capturedSeconds || plan.duration, detail, received: budget.received };
}
