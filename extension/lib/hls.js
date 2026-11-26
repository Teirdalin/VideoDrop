import { httpUrl } from "./media.js";

export const MAX_SEGMENTS = 12000;
export const MAX_HLS_BYTES = 512 * 1024 * 1024;
export const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

export function attributes(value) {
  const result = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of value.matchAll(pattern)) result[match[1]] = match[2].replace(/^"|"$/g, "");
  return result;
}

function resource(value, base) {
  const url = httpUrl(value, base);
  if (!url) throw new Error("This playlist contains an unsupported media address.");
  return url;
}

function byteRange(value, previous, url) {
  const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
  if (!match) throw new Error("This playlist has an invalid byte range.");
  const length = Number(match[1]);
  const offset = match[2] === undefined ? (previous?.url === url ? previous.end + 1 : NaN) : Number(match[2]);
  const end = offset + length - 1;
  if (!length || !Number.isSafeInteger(end) || offset < 0 || !Number.isSafeInteger(offset)) throw new Error("This playlist has an invalid byte range.");
  return { start: offset, end };
}

export function parsePlaylist(text, base) {
  if (typeof text !== "string" || text.length > MAX_PLAYLIST_BYTES) throw new Error("The video playlist is too large.");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("The server did not return a video playlist. Try playing the video again.");
  const variants = [];
  const renditions = [];
  const segments = [];
  let pendingVariant = null, pendingRange = null, pendingDuration = null, map = null;
  let lastRange = null, endList = false, encrypted = false, gap = false, discontinuity = false;
  let sequence = 0, targetDuration = 4;
  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) pendingVariant = attributes(line.slice(18));
    else if (line.startsWith("#EXT-X-MEDIA:")) renditions.push(attributes(line.slice(13)));
    else if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
      const attr = attributes(line.slice(line.indexOf(":") + 1));
      if (attr.METHOD !== "NONE") encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attr = attributes(line.slice(11));
      const url = resource(attr.URI, base);
      const range = attr.BYTERANGE ? byteRange(attr.BYTERANGE, null, url) : null;
      map = { url, range };
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) pendingRange = line.slice(17);
    else if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(pendingDuration) || pendingDuration < 0) throw new Error("This playlist has an invalid segment duration.");
    } else if (line === "#EXT-X-ENDLIST") endList = true;
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.slice(22));
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("This playlist has an invalid media sequence.");
    }
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice(22));
      if (!Number.isFinite(targetDuration) || targetDuration <= 0) throw new Error("This playlist has an invalid target duration.");
    }
    else if (line === "#EXT-X-GAP") gap = true;
    else if (line === "#EXT-X-DISCONTINUITY") discontinuity = true;
    else if (!line.startsWith("#")) {
      const url = resource(line, base);
      if (pendingVariant) {
        const dimensions = (pendingVariant.RESOLUTION || "").split("x").map(Number);
        variants.push({ url, height: dimensions[1] || 0, bandwidth: Number(pendingVariant.BANDWIDTH) || 0, audioGroup: pendingVariant.AUDIO || "", codecs: pendingVariant.CODECS || "" });
        pendingVariant = null;
      } else {
        if (pendingDuration === null) throw new Error("This playlist is missing a segment duration.");
        const range = pendingRange ? byteRange(pendingRange, lastRange, url) : null;
        segments.push({ url, range, duration: pendingDuration, map: map ? { ...map } : null, discontinuity, sequence: sequence + segments.length });
        discontinuity = false;
        lastRange = range ? { url, ...range } : null;
        pendingRange = null;
        pendingDuration = null;
        if (segments.length > MAX_SEGMENTS) throw new Error("This video has too many segments for VideoDrop.");
      }
    }
  }
  if (pendingVariant || pendingDuration !== null || pendingRange) throw new Error("This video playlist is incomplete.");
  if (variants.length) {
    for (const variant of variants) {
      const audio = renditions.filter(item => item.TYPE === "AUDIO" && item["GROUP-ID"] === variant.audioGroup)
        .sort((a, b) => Number(b.DEFAULT === "YES") - Number(a.DEFAULT === "YES") || Number(b.AUTOSELECT === "YES") - Number(a.AUTOSELECT === "YES"))[0];
      variant.audioUrl = audio?.URI ? resource(audio.URI, base) : "";
      variant.audioLanguage = audio?.LANGUAGE || "";
      variant.separateAudio = !!variant.audioUrl;
      variant.blocked = encrypted ? "Encrypted HLS is not supported." : "";
    }
    return { type: "master", variants: variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth) };
  }
  return {
    type: "media", url: base, segments, map, live: !endList, sequence, targetDuration, duration: segments.reduce((sum, segment) => sum + segment.duration, 0),
    ext: map ? "mp4" : "ts",
    blocked: encrypted ? "Encrypted HLS is not supported." : !segments.length && endList ? "This playlist has no video segments." : gap ? "This playlist contains missing segments and cannot be saved completely." : ""
  };
}

// Read incrementally so a hostile or mistaken response cannot grow an unbounded buffer.
export async function readLimited(response, maxBytes, signal) {
  if (!response.ok) throw new Error(`The video server returned HTTP ${response.status}. Try replaying the video, then scan again.`);
  const expected = Number(response.headers.get("content-length"));
  if (expected > maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error("This stream exceeds the 512 MB memory limit, or its manifest is too large."); }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("This stream exceeds the 512 MB memory limit, or its manifest is too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

