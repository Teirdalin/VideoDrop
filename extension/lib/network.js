import { httpUrl } from "./media.js";
import { readLimited, MAX_PLAYLIST_BYTES } from "./hls.js";
import { MAX_HLS_BYTES } from "./hls.js";
import { assertSourceAllowed } from "../edition.js";

export async function getResource(part, { signal, fetcher = fetch, maxBytes = 512 * 1024 * 1024, attempts = 3, beforeFetch = async () => null, afterFetch = async () => {} } = {}) {
  const url = httpUrl(part.url);
  if (!url) throw new Error("The media address is invalid.");
  assertSourceAllowed(url);
  const rule = await beforeFetch(url);
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]);
      try {
        const headers = part.range ? { Range: `bytes=${part.range.start}-${part.range.end}` } : {};
        const response = await fetcher(url, { headers, credentials: "include", cache: "no-store", signal: timeout });
        try { assertSourceAllowed(response.url || url); }
        catch (error) { await response.body?.cancel(); throw error; }
        if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
          await response.body?.cancel();
          await delay(300 * (attempt + 1), signal); continue;
        }
        const bytes = await readLimited(response, part.range ? Math.min(maxBytes, part.range.end - part.range.start + 1) : maxBytes, timeout);
        if (!bytes.length) throw new Error("The server returned an empty media segment.");
        if (part.range) {
          const wanted = part.range.end - part.range.start + 1;
          if (response.status === 206) {
            if (!response.headers.get("content-range")?.startsWith(`bytes ${part.range.start}-${part.range.end}/`)) throw new Error("The server returned the wrong part of this video.");
            if (bytes.length !== wanted) throw new Error("The server returned an incomplete video segment.");
          } else throw new Error("The server ignored a required byte range. Scan again after playing the video.");
        }
        return { bytes, url: response.url || url, mime: response.headers.get("content-type") || "", contentRange: response.headers.get("content-range") || "" };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if ((error.name === "TypeError" || error.name === "TimeoutError") && attempt + 1 < attempts) { await delay(300 * (attempt + 1), signal); continue; }
        throw error;
      }
    }
  } finally { await afterFetch(rule); }
}

export async function getText(url, options) {
  const result = await getResource({ url }, { ...options, maxBytes: MAX_PLAYLIST_BYTES });
  return { text: new TextDecoder().decode(result.bytes), url: result.url };
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export function serverError(reason = "") {
  if (/SERVER|NETWORK|FILE_FAILED/.test(reason)) return `The site could not serve this media link (${reason}). Replay the video and scan again to refresh the address.`;
  return reason === "USER_CANCELED" ? "Download canceled." : `Download interrupted${reason ? ` (${reason})` : ""}. Please try again.`;
}
export async function fetchWholeFile(url, options = {}, onProgress = () => {}) {
  const first = await getResource({ url }, { ...options, maxBytes: MAX_HLS_BYTES });
  if (/text\/html|application\/json/i.test(first.mime)) throw new Error("The site returned a page instead of this video. Play the video and scan again.");
  const pieces = [first.bytes];
  let received = first.bytes.length, total = received;
  if (first.contentRange) {
    const match = first.contentRange.match(/^bytes 0-(\d+)\/(\d+)$/);
    if (!match || Number(match[1]) + 1 !== received) throw new Error("The server returned an incomplete first portion of this video.");
    total = Number(match[2]);
    if (!Number.isSafeInteger(total) || total < received || total > MAX_HLS_BYTES) throw new Error("This protected-file fallback exceeds the 512 MB memory limit.");
  }
  await onProgress({ received, totalBytes: total });
  while (received < total) {
    const end = Math.min(total - 1, received + 4 * 1024 * 1024 - 1);
    const next = await getResource({ url, range: { start: received, end } }, { ...options, maxBytes: total - received });
    pieces.push(next.bytes); received += next.bytes.length;
    await onProgress({ received, totalBytes: total });
  }
  return new Blob(pieces, { type: /^video\//.test(first.mime) ? first.mime.split(";")[0] : "video/mp4" });
}
