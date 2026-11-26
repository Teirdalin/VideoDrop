import { httpUrl } from "./media.js";
import { MAX_PLAYLIST_BYTES, MAX_SEGMENTS } from "./hls.js";

const fail = message => { throw new Error(message); };
function entity(text) {
  return text.replace(/&([^;]+);/g, (_match, value) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, value)) return named[value];
    if (/^#(?:\d+|x[\da-f]+)$/i.test(value)) {
      const number = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      if (number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)) return String.fromCodePoint(number);
    }
    return fail("This DASH manifest contains an invalid XML entity.");
  });
}

// A bounded, non-networked XML reader for MPD data, shared by the worker/tests.
// No DTDs, external entities, HTML evaluation, or third-party parser is used.
export function xmlTree(xml) {
  if (typeof xml !== "string" || xml.length > MAX_PLAYLIST_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail("This DASH manifest contains unsupported XML declarations or is too large.");
  const document = { name: "document", attrs: {}, children: [], text: "" }, stack = [document];
  let pos = 0, nodes = 0;
  while (pos < xml.length) {
    const start = xml.indexOf("<", pos);
    if (start < 0) { stack.at(-1).text += entity(xml.slice(pos)); break; }
    stack.at(-1).text += entity(xml.slice(pos, start));
    if (xml.startsWith("<!--", start)) { const end = xml.indexOf("-->", start + 4); if (end < 0) fail("The DASH manifest has an incomplete XML comment."); pos = end + 3; continue; }
    if (xml.startsWith("<![CDATA[", start)) { const end = xml.indexOf("]]>", start + 9); if (end < 0) fail("The DASH manifest has incomplete XML data."); stack.at(-1).text += xml.slice(start + 9, end); pos = end + 3; continue; }
    let end = start + 1, quote = "";
    for (; end < xml.length; end++) { const c = xml[end]; if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ">") break; }
    if (end >= xml.length) fail("The DASH manifest has incomplete XML.");
    const tag = xml.slice(start + 1, end).trim(); pos = end + 1;
    if (tag.startsWith("?")) continue;
    if (tag.startsWith("!")) fail("The DASH manifest has an unsupported XML declaration.");
    if (tag.startsWith("/")) {
      if (stack.length < 2 || stack.at(-1).tag !== tag.slice(1).trim()) fail("The DASH manifest has mismatched XML elements.");
      stack.pop(); continue;
    }
    const match = tag.match(/^([\w:.-]+)([\s\S]*?)(\/?)$/);
    if (!match) fail("The DASH manifest contains invalid XML.");
    const attrs = {}, tail = match[2];
    let used = 0;
    const pattern = /\s+([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/gy;
    while (used < tail.length) {
      if (!tail.slice(used).trim()) break;
      pattern.lastIndex = used;
      const attribute = pattern.exec(tail);
      if (!attribute) fail("The DASH manifest contains invalid XML attributes.");
      const name = attribute[1].split(":").at(-1);
      if (Object.hasOwn(attrs, name)) fail("The DASH manifest has duplicate XML attributes.");
      attrs[name] = entity(attribute[2].slice(1, -1)); used = pattern.lastIndex;
    }
    const node = { tag: match[1], name: match[1].split(":").at(-1), attrs, children: [], text: "" };
    stack.at(-1).children.push(node);
    if (++nodes > 50000 || stack.length > 40) fail("This DASH manifest is too complex.");
    if (!match[3]) stack.push(node);
  }
  if (stack.length !== 1 || document.children.length !== 1 || document.text.trim().replace(/^\uFEFF/, "")) fail("The DASH manifest is incomplete or invalid.");
  return document.children[0];
}
const children = (node, name) => node?.children.filter(child => child.name === name) || [];
const child = (node, name) => children(node, name)[0];
export function isoDuration(value = "") {
  const match = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : 0;
}
function number(value, fallback = 0) { const parsed = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) fail("The DASH manifest has an invalid segment number or timestamp."); return parsed; }
const address = (value, base) => httpUrl(value, base) || fail("This DASH manifest contains an unsupported media address.");
function inheritedBase(chain, base) {
  for (const node of chain) { const text = child(node, "BaseURL")?.text.trim(); if (text) base = address(text, base); }
  return base;
}
function inherited(chain, name) {
  let result;
  for (const node of chain) {
    const own = child(node, name);
    if (own) result = { attrs: { ...result?.attrs, ...own.attrs }, children: own.children.length ? own.children : result?.children || [] };
  }
  return result;
}
export function templateUrl(template, values, base) {
  if (!template) fail("This DASH representation has no segment URL template.");
  const value = template.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (match, name, width) => {
    if (match === "$$") return "$";
    if (values[name] === undefined) fail("The DASH template uses a missing segment identifier.");
    const size = Number(width || 0);
    if (size > 20) fail("The DASH URL padding is too large.");
    return String(values[name]).padStart(size, "0");
  });
  if (/\$(?:RepresentationID|Bandwidth|Number|Time)(?:%[^$]*)?\$/.test(value)) fail("This DASH URL template is not supported.");
  return address(value, base);
}
function range(value) {
  if (!value) return null;
  const match = value.match(/^(\d+)-(\d+)$/);
  if (!match) fail("The DASH manifest has an invalid byte range.");
  const start = number(match[1]), end = number(match[2]);
  if (end < start) fail("The DASH manifest has a reversed byte range.");
  return { start, end };
}

function makeTrack(chain, manifestUrl, duration, index) {
  const rep = chain.at(-1), adaptation = chain.at(-2);
  const attr = Object.assign({}, ...chain.map(node => node.attrs));
  const base = inheritedBase(chain, manifestUrl);
  const kind = attr.contentType || (attr.mimeType || "").split("/")[0] || (/^(?:avc|hev|hvc|vp0|av01)/.test(attr.codecs || "") ? "video" : /^(?:mp4a|opus|vorbis|ac-3|ec-3)/.test(attr.codecs || "") ? "audio" : "");
  if (!["video", "audio"].includes(kind)) return null;
  const identity = rep.attrs.id || `${kind}-${index}`;
  const track = { id: identity, key: `${adaptation.attrs.id || index}:${identity}`, kind, height: number(attr.height), bandwidth: number(attr.bandwidth), language: attr.lang || "", default: children(adaptation, "Role").some(item => ["main", "default"].includes(item.attrs.value)), mime: attr.mimeType || "", codecs: attr.codecs || "", duration, segments: [], map: null };
  if (chain.some(node => children(node, "ContentProtection").length)) track.blocked = "This DASH track is encrypted or DRM-protected.";
  const values = { RepresentationID: identity, Bandwidth: track.bandwidth };
  const template = inherited(chain, "SegmentTemplate");
  const list = inherited(chain, "SegmentList");
  const indexed = inherited(chain, "SegmentBase");
  if (template) {
    const timescale = number(template.attrs.timescale, 1) || fail("The DASH timescale must be positive.");
    const startNumber = number(template.attrs.startNumber, 1), offset = number(template.attrs.presentationTimeOffset);
    if (template.attrs.initialization) track.map = { url: templateUrl(template.attrs.initialization, values, base), range: null };
    const timeline = child(template, "SegmentTimeline");
    let sequence = startNumber, timestamp = 0;
    const append = (time, d) => {
      if (track.segments.length >= MAX_SEGMENTS) fail("This DASH video has too many segments.");
      track.segments.push({ url: templateUrl(template.attrs.media, { ...values, Number: sequence, Time: time }, base), range: null, duration: d / timescale }); sequence++;
    };
    if (timeline) {
      const entries = children(timeline, "S");
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i].attrs, d = number(entry.d);
        if (!d) fail("The DASH timeline is missing a segment duration.");
        if (entry.t !== undefined) timestamp = number(entry.t);
        const repeat = Number(entry.r || 0);
        if (!Number.isSafeInteger(repeat) || repeat < -1) fail("The DASH timeline has an invalid repeat count.");
        const boundary = entries[i + 1]?.attrs.t !== undefined ? number(entries[i + 1].attrs.t) : duration > 0 ? duration * timescale + offset : 0;
        const count = repeat === -1 ? (boundary > timestamp ? Math.ceil((boundary - timestamp) / d) : fail("An open DASH timeline needs a finite video duration.")) : repeat + 1;
        if (count + track.segments.length > MAX_SEGMENTS) fail("This DASH video has too many segments.");
        for (let n = 0; n < count; n++) { append(timestamp, d); timestamp += d; }
      }
    } else {
      const d = number(template.attrs.duration);
      if (!d || !duration) fail("This DASH template needs a segment duration and a finished video length.");
      const count = template.attrs.endNumber !== undefined ? number(template.attrs.endNumber) - startNumber + 1 : Math.ceil(duration * timescale / d);
      if (count <= 0 || count > MAX_SEGMENTS) fail("This DASH video has an invalid number of segments.");
      for (let n = 0; n < count; n++) { append(n * d, d); }
    }
  } else if (list) {
    const initialization = child(list, "Initialization");
    if (initialization) track.map = { url: address(initialization.attrs.sourceURL || base, base), range: range(initialization.attrs.range) };
    const timescale = number(list.attrs.timescale, 1) || fail("Invalid DASH timescale.");
    const urls = children(list, "SegmentURL");
    if (urls.length > MAX_SEGMENTS) fail("This DASH video has too many segments.");
    track.segments = urls.map(item => ({ url: address(item.attrs.media || base, base), range: range(item.attrs.mediaRange), duration: number(list.attrs.duration) / timescale || duration / urls.length }));
  } else if (indexed) {
    const initialization = child(indexed, "Initialization");
    if (initialization) track.map = { url: address(initialization.attrs.sourceURL || base, base), range: range(initialization.attrs.range) };
    if (indexed.attrs.indexRange) track.index = { url: base, range: range(indexed.attrs.indexRange) };
    else { track.map = null; track.segments = [{ url: base, range: null, duration }]; }
  } else if (base !== manifestUrl) track.segments = [{ url: base, range: null, duration }];
  else fail("This DASH representation has no supported segment addresses.");
  if (!track.index && !track.segments.length) fail("This DASH track has no media segments.");
  return track;
}

export function parseDash(xml, manifestUrl) {
  const mpd = xmlTree(xml);
  if (mpd.name !== "MPD") fail("The server did not return a DASH video manifest.");
  if (mpd.attrs.type === "dynamic") return { type: "dash", variants: [], blocked: "This is live DASH. Finished DASH videos and live HLS are supported; live DASH is not yet supported." };
  const periods = children(mpd, "Period");
  if (periods.length !== 1) fail("This DASH video changes periods. Multi-period DASH is not yet supported.");
  const period = periods[0];
  const duration = isoDuration(period.attrs.duration) || Math.max(0, isoDuration(mpd.attrs.mediaPresentationDuration) - isoDuration(period.attrs.start));
  const tracks = [];
  for (const adaptation of children(period, "AdaptationSet")) {
    for (const rep of children(adaptation, "Representation")) tracks.push(makeTrack([mpd, period, adaptation, rep], manifestUrl, duration, tracks.length));
  }
  const video = tracks.filter(track => track?.kind === "video").sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const audio = tracks.filter(track => track?.kind === "audio").sort((a, b) => Number(b.default) - Number(a.default) || b.bandwidth - a.bandwidth);
  const variants = video.map(track => {
    const compatible = audio.filter(item => /webm/.test(item.mime) === /webm/.test(track.mime));
    const preferred = compatible.find(item => !item.blocked) || compatible[0];
    return { id: track.key, height: track.height, bandwidth: track.bandwidth, video: track, audio: preferred || null, blocked: track.blocked || preferred?.blocked || "", ext: /webm/.test(track.mime) ? "webm" : "mp4" };
  });
  return { type: "dash", variants, blocked: variants.length ? "" : "This DASH manifest has no supported video tracks." };
}

// Resolve SegmentBase indexRange without downloading the entire representation.
export function parseSidx(bytes, absoluteStart, url) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = offset => { const result = Number(data.getBigUint64(offset)); if (!Number.isSafeInteger(result)) fail("This DASH index uses timestamps outside the supported range."); return result; };
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let size = data.getUint32(offset), header = 8;
    if (size === 1) { if (offset + 16 > bytes.length) break; size = u64(offset + 8); header = 16; }
    if (size < header || offset + size > bytes.length) fail("This DASH index is incomplete.");
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "sidx") {
      const start = offset + header, version = data.getUint8(start);
      if (version > 1 || size < header + (version ? 32 : 24)) fail("This DASH index version is invalid.");
      const scale = data.getUint32(start + 8);
      if (!scale) fail("This DASH index has an invalid timescale.");
      const firstOffset = version ? u64(start + 20) : data.getUint32(start + 16);
      const countPos = start + (version ? 30 : 22), count = data.getUint16(countPos);
      if (!count || count > MAX_SEGMENTS || countPos + 2 + count * 12 > offset + size) fail("This DASH segment index is incomplete or too large.");
      let position = absoluteStart + offset + size + firstOffset;
      const segments = [];
      for (let i = 0; i < count; i++) {
        const entry = countPos + 2 + i * 12, reference = data.getUint32(entry), length = reference & 0x7fffffff;
        if (reference >>> 31 || !length) fail("Hierarchical DASH segment indexes are not yet supported.");
        const end = position + length - 1;
        if (!Number.isSafeInteger(end)) fail("The DASH byte range is too large.");
        segments.push({ url, range: { start: position, end }, duration: data.getUint32(entry + 4) / scale }); position = end + 1;
      }
      return segments;
    }
    offset += size;
  }
  return fail("This DASH resource did not contain its advertised segment index.");
}
