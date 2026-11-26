export const MAX_ITEMS = 40;
export const DEFAULT_SETTINGS = { saveAs: false, showSupport: true };
export const SUPPORT = {
  patreon: "https://www.patreon.com/cw/Teirdalin",
  kofi: "https://ko-fi.com/teirdalin"
};

export function httpUrl(value, base) {
  try {
    if (typeof value !== "string" || !value || value.length > 8192) return null;
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function classify(url, mime = "") {
  const safe = httpUrl(url);
  if (!safe) return null;
  // The YouTube page provider handles complete tracks; ignore isolated CDN parts.
  if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com)$/.test(new URL(safe).hostname)) return null;
  const path = new URL(safe).pathname.toLowerCase();
  const type = mime.split(";")[0].trim().toLowerCase();
  if (/\.(ts|m4s|cmfv|cmfa|aac|vtt|key)$/.test(path) || /\/(init|segment[-_]?\d+|seg[-_]?\d+)\.mp4$/.test(path)) return null;
  if (/\.m3u8$/.test(path) || ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(type)) return { kind: "hls", ext: "ts" };
  if (/\.mpd$/.test(path) || type === "application/dash+xml") return { kind: "dash", ext: "mpd" };
  const ext = path.match(/\.(mp4|webm|m4v|mov|ogv|ogg)$/)?.[1];
  if (ext) return { kind: "file", ext: ext === "ogg" ? "ogv" : ext };
  const byMime = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv", "video/x-m4v": "m4v" };
  return byMime[type] ? { kind: "file", ext: byMime[type] } : null;
}

export function makeCandidate(input) {
  const url = httpUrl(input.url);
  const format = classify(url, input.mime);
  if (!format) return null;
  return {
    url, ...format,
    title: String(input.title || "").slice(0, 180),
    width: Math.max(0, Number(input.width) || 0),
    height: Math.max(0, Number(input.height) || 0),
    bytes: Math.max(0, Number(input.bytes) || 0),
    duration: Number.isFinite(input.duration) ? Math.max(0, input.duration) : 0,
    source: input.source === "page" ? "page" : "network"
  };
}

export function mergeCandidates(existing = [], additions = []) {
  const items = new Map(existing.map(item => [item.url, item]));
  for (const input of additions) {
    const item = makeCandidate(input);
    if (!item) continue;
    const previous = items.get(item.url);
    items.set(item.url, previous ? {
      ...previous, ...item,
      title: item.title || previous.title,
      width: item.width || previous.width,
      height: item.height || previous.height,
      bytes: item.bytes || previous.bytes,
      duration: item.duration || previous.duration
    } : item);
  }
  return [...items.values()].slice(-MAX_ITEMS);
}

export function safeFilename(title, ext) {
  let name = String(title || "video").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "")
    .replace(/\.(mp4|webm|m4v|mov|ogv|m3u8|ts|mkv|mp3)$/i, "").slice(0, 120).replace(/[. ]+$/g, "");
  if (!name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = "video";
  return `${name}.${/^(mp4|webm|m4v|mov|ogv|ts|mkv|mp3)$/.test(ext) ? ext : "mp4"}`;
}

export function displayName(item, index = 0) {
  let file = "";
  try { file = decodeURIComponent(new URL(item.url).pathname.split("/").pop()); } catch { /* malformed percent encoding */ }
  const name = item.title || file || `Video ${index + 1}`;
  const quality = item.height ? `${item.height}p` : "";
  return [name.slice(0, 72), quality, item.kind === "hls" ? "HLS" : item.kind === "dash" ? "DASH" : item.ext.toUpperCase(), formatBytes(item.bytes)].filter(Boolean).join(" · ");
}

export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB"][unit]}`;
}
