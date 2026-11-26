import test from "node:test";
import assert from "node:assert/strict";
import { parseDash, xmlTree, isoDuration, templateUrl, parseSidx } from "../extension/lib/dash.js";
const base = "https://cdn.test/dash/index.mpd?token=x";
const manifest = body => `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S"><Period>${body}</Period></MPD>`;
test("ISO DASH duration and padded URL templates preserve signed queries", () => {
  assert.equal(isoDuration("P1DT2H3M4.5S"), 93784.5);
  assert.equal(templateUrl("$RepresentationID$/s-$Number%05d$-$Time$.m4s?sig=a&amp;b", { RepresentationID: "v", Number: 3, Time: 9000 }, base), "https://cdn.test/dash/v/s-00003-9000.m4s?sig=a&amp;b");
  assert.equal(templateUrl("$$file-$Bandwidth$.m4s", { Bandwidth: 42 }, base), "https://cdn.test/dash/$file-42.m4s");
});
test("DASH templates fetch every Number segment and pair the default audio track", () => {
  const parsed = parseDash(manifest('<BaseURL>../assets/</BaseURL><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate duration="2" timescale="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number%03d$.m4s"/><Representation id="v" height="720" bandwidth="1000000"/></AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en"><Role value="main"/><Representation id="a" bandwidth="128000"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet>'), base);
  assert.equal(parsed.variants.length, 1);
  const variant = parsed.variants[0];
  assert.equal(variant.audio.id, "a");
  assert.deepEqual(variant.video.segments.map(item => item.url), [1, 2, 3].map(n => `https://cdn.test/assets/v/00${n}.m4s`));
  assert.equal(variant.video.map.url, "https://cdn.test/assets/v/init.mp4");
});
test("SegmentTimeline resolves Time, repeat=-1, and representation overrides", () => {
  const parsed = parseDash(manifest('<AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="init.mp4" media="$Time$.m4s" timescale="1000"><SegmentTimeline><S t="5000" d="2000" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="v" height="1080"><SegmentTemplate presentationTimeOffset="5000"/></Representation></AdaptationSet>'), base);
  assert.deepEqual(parsed.variants[0].video.segments.map(item => item.url.split("/").at(-1)), ["5000.m4s", "7000.m4s", "9000.m4s"]);
});
test("SegmentList and SegmentBase retain exact byte ranges", () => {
  const parsed = parseDash(manifest('<AdaptationSet contentType="video"><Representation id="v"><BaseURL>file.mp4</BaseURL><SegmentList duration="2"><Initialization range="0-99"/><SegmentURL mediaRange="100-199"/><SegmentURL mediaRange="200-299"/></SegmentList></Representation></AdaptationSet>'), base);
  assert.deepEqual(parsed.variants[0].video.map.range, { start: 0, end: 99 });
  assert.equal(parsed.variants[0].video.segments[1].range.start, 200);
  const indexed = parseDash(manifest('<AdaptationSet mimeType="video/mp4"><Representation id="v"><BaseURL>file.mp4</BaseURL><SegmentBase indexRange="100-155"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet>'), base);
  assert.deepEqual(indexed.variants[0].video.index.range, { start: 100, end: 155 });
});
test("SIDX references resolve absolute offsets and reject hierarchical/incomplete indexes", () => {
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length); bytes.set(Buffer.from("sidx"), 4);
  view.setUint32(16, 1000); view.setUint32(24, 10); view.setUint16(30, 2);
  view.setUint32(32, 100); view.setUint32(36, 2000); view.setUint32(44, 200); view.setUint32(48, 2000);
  const segments = parseSidx(bytes, 100, "https://cdn.test/video.mp4");
  assert.deepEqual(segments.map(part => part.range), [{ start: 166, end: 265 }, { start: 266, end: 465 }]);
  view.setUint32(32, 0x80000001); assert.throws(() => parseSidx(bytes, 100, base), /Hierarchical/);
});
test("DRM, live DASH, dangerous XML, invalid templates and excessive repeats are bounded", () => {
  const drm = parseDash(manifest('<AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:test"/><Representation id="v"><BaseURL>file.mp4</BaseURL></Representation></AdaptationSet>'), base);
  assert.match(drm.variants[0].blocked, /DRM/);
  assert.match(parseDash('<MPD type="dynamic"/>', base).blocked, /live DASH/);
  assert.throws(() => xmlTree('<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///secret">]><MPD/>'), /unsupported XML/);
  assert.throws(() => xmlTree('<MPD><Period></MPD>'), /mismatched/);
  assert.throws(() => parseDash(manifest('<AdaptationSet contentType="video"><Representation id="v"><SegmentTemplate duration="1" media="javascript:evil()"/></Representation></AdaptationSet>'), base), /unsupported media address/);
  assert.throws(() => parseDash(manifest('<AdaptationSet contentType="video"><Representation id="v"><SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="1" r="999999999"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>'), base), /too many/);
});
