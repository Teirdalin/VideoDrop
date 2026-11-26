import test from "node:test";
import assert from "node:assert/strict";
import { httpUrl, classify, mergeCandidates, safeFilename, formatBytes, SUPPORT } from "../extension/lib/media.js";

test("allows only HTTP(S), strips fragments and preserves signed queries", () => {
  assert.equal(httpUrl("../v.mp4?token=a%2Fb&expires=123#t=1", "https://cdn.test/path/watch/"), "https://cdn.test/path/v.mp4?token=a%2Fb&expires=123");
  for (const value of ["javascript:alert(1)", "blob:https://example.test/id", "data:video/mp4;base64,A", "file:///secret", "https://user:pass@x.test/a", "https://x.test/" + "a".repeat(8192)]) assert.equal(httpUrl(value), null);
});
test("recognizes direct files, extensionless video MIME, HLS and DASH", () => {
  assert.deepEqual(classify("https://cdn.test/video.MP4?sig=1"), { kind: "file", ext: "mp4" });
  assert.deepEqual(classify("https://cdn.test/media?id=2", "video/webm; charset=binary"), { kind: "file", ext: "webm" });
  assert.equal(classify("https://cdn.test/playlist", "application/vnd.apple.mpegurl").kind, "hls");
  assert.equal(classify("https://cdn.test/video.mpd").kind, "dash");
  for (const path of ["a.ts", "chunk.m4s", "init.mp4", "segment001.mp4", "seg-3.mp4", "key.key", "image.png"]) assert.equal(classify(`https://cdn.test/${path}`), null);
});
test("deduplicates exact URLs without stripping authorization, preserves page metadata, bounds discovery", () => {
  const first = mergeCandidates([], [{ url: "https://x.test/v.mp4?sig=1", title: "A video", height: 1080, bytes: 100 }]);
  const next = mergeCandidates(first, [{ url: first[0].url }, { url: "https://x.test/v.mp4?sig=2" }]);
  assert.equal(next.length, 2);
  assert.equal(next[0].title, "A video");
  assert.equal(next[0].height, 1080);
  assert.equal(mergeCandidates([], Array.from({ length: 100 }, (_, i) => ({ url: `https://x.test/${i}.mp4` }))).length, 40);
});
test("filenames are safe on Windows and cannot escape Downloads", () => {
  assert.equal(safeFilename('../../A: Video?*<>|.mp4', "webm"), ".. .. A Video.webm");
  assert.equal(safeFilename("CON", "mp4"), "video.mp4");
  assert.equal(safeFilename("NUL.txt", "mp4"), "video.mp4");
  assert.equal(safeFilename("..", "ts"), "video.ts");
  assert.equal(safeFilename("A\u202efile", "ts"), "A file.ts");
  assert.equal(safeFilename("Movie.mp4", "exe"), "Movie.mp4");
});
test("size labels and exact optional support destinations", () => {
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(0), "");
  assert.equal(SUPPORT.patreon, "https://www.patreon.com/cw/Teirdalin");
  assert.equal(SUPPORT.kofi, "https://ko-fi.com/teirdalin");
});
test("generic discovery defers YouTube pages and CDN fragments to the YouTube provider", () => {
  assert.equal(classify("https://rr1.googlevideo.com/videoplayback?id=1", "video/mp4"), null);
  assert.equal(classify("https://youtube.com/video.mp4"), null);
  assert.equal(classify("https://youtube.com.example.test/video.mp4").kind, "file");
});
