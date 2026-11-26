import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaylist, readLimited } from "../extension/lib/hls.js";
const base = "https://cdn.test/path/main.m3u8?token=abc";
const media = (lines = "a.ts\n#EXTINF:2,\nb.ts", extra = "") => `#EXTM3U\n${extra}\n#EXTINF:2,\n${lines}\n#EXT-X-ENDLIST`;
test("HLS master resolves URLs, quoted codec commas and sorted qualities", () => {
  const result = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42,mp4a.40.2"\nlow.m3u8?sig=1\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n../high.m3u8', base);
  assert.equal(result.variants[0].height, 1080);
  assert.equal(result.variants[1].url, "https://cdn.test/path/low.m3u8?sig=1");
  assert.equal(result.variants[1].codecs, "avc1.42,mp4a.40.2");
});
test("separate audio uses the declared default language, not the first rendition", () => {
  const result = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="fr",URI="fr.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",DEFAULT=YES,LANGUAGE="en",URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"\nvideo.m3u8', base);
  assert.equal(result.variants[0].audioUrl, "https://cdn.test/path/en.m3u8");
  assert.equal(result.variants[0].audioLanguage, "en");
  assert.equal(result.variants[0].blocked, "");
});
test("a default in-band audio rendition does not fetch an unrelated alternative", () => {
  const result = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",DEFAULT=YES,NAME="Main"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="other.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"\nvideo.m3u8', base);
  assert.equal(result.variants[0].audioUrl, "");
});
test("media preserves signed segment URLs and full VOD duration", () => {
  const result = parsePlaylist(media("a.ts?sig=1\n#EXTINF:2,\nhttps://other.test/b.ts?sig=2"), base);
  assert.equal(result.duration, 4); assert.equal(result.live, false);
  assert.equal(result.segments[0].url, "https://cdn.test/path/a.ts?sig=1");
});
test("live sequence and target duration survive parsing for sliding-window recording", () => {
  const result = parsePlaylist(media(undefined, "#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-TARGETDURATION:8").replace("#EXT-X-ENDLIST", ""), base);
  assert.equal(result.live, true); assert.equal(result.targetDuration, 8);
  assert.deepEqual(result.segments.map(part => part.sequence), [42, 43]);
  assert.equal(result.blocked, "");
});
test("encrypted, missing and malformed playlists fail clearly", () => {
  assert.match(parsePlaylist(media("a.ts", '#EXT-X-KEY:METHOD=AES-128,URI="key"'), base).blocked, /Encrypted/);
  assert.match(parsePlaylist(media("a.ts", "#EXT-X-GAP"), base).blocked, /missing/);
  assert.throws(() => parsePlaylist("<html>Login</html>", base), /did not return/);
  assert.throws(() => parsePlaylist(media("javascript:evil()"), base), /unsupported media address/);
  assert.throws(() => parsePlaylist("#EXTM3U\n#EXTINF:2,", base), /incomplete/);
});
test("HLS initialization changes and discontinuities are retained per segment for remuxing", () => {
  const result = parsePlaylist(media('a.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="other.mp4"\n#EXTINF:2,\nb.m4s', '#EXT-X-MAP:URI="init.mp4"'), base);
  assert.notEqual(result.segments[0].map.url, result.segments[1].map.url);
  assert.equal(result.segments[1].discontinuity, true);
});
test("byte ranges handle explicit and implied offsets and reject ambiguous ranges", () => {
  const result = parsePlaylist(media('file.ts\n#EXT-X-BYTERANGE:188\n#EXTINF:2,\nfile.ts', '#EXT-X-BYTERANGE:188@0'), base);
  assert.deepEqual(result.segments.map(part => part.range), [{ start: 0, end: 187 }, { start: 188, end: 375 }]);
  assert.throws(() => parsePlaylist(media("file.ts", "#EXT-X-BYTERANGE:188"), base), /invalid byte range/);
});
test("stream reader caps memory with and without a declared Content-Length", async () => {
  await assert.rejects(readLimited(new Response(new Uint8Array(20)), 10), /memory limit/);
  await assert.rejects(readLimited(new Response("test", { headers: { "content-length": "1000" } }), 10), /memory limit/);
});
