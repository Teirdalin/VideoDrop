import test from "node:test";
import assert from "node:assert/strict";
import { inspectStream, resolveStream, downloadStream } from "../extension/lib/streams.js";
import { getResource, fetchWholeFile, serverError } from "../extension/lib/network.js";
const base = "https://cdn.test/main.m3u8?token=original";
const control = () => ({ signal: new AbortController().signal, wait: async () => {}, finish: false });
function fixture(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const content = routes[url] ?? routes[new URL(url).pathname];
    return content instanceof Response ? content.clone() : new Response(content === undefined ? "missing" : content, { status: content === undefined ? 404 : 200 });
  };
  return { fetcher, calls };
}
test("separate HLS fetches every video/audio segment and emits two complete local playlists", async () => {
  const fixtureData = fixture({
    "/main.m3u8": '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nvideo.m3u8',
    "/video.m3u8": '#EXTM3U\n#EXTINF:2,\nv1.ts\n#EXTINF:2,\nv2.ts\n#EXT-X-ENDLIST',
    "/audio.m3u8": '#EXTM3U\n#EXTINF:2,\na1.aac\n#EXTINF:2,\na2.aac\n#EXT-X-ENDLIST',
    "/v1.ts": "video-first", "/v2.ts": "video-last", "/a1.aac": "audio-first", "/a2.aac": "audio-last"
  });
  const plan = await resolveStream({ kind: "hls", url: base }, {}, fixtureData);
  assert.equal(plan.tracks.length, 2);
  const events = [];
  const bundle = await downloadStream(plan, fixtureData, control(), event => events.push(event));
  assert.equal(bundle.inputs.length, 2);
  assert.equal(bundle.duration, 4);
  for (const name of ["/v1.ts", "/v2.ts", "/a1.aac", "/a2.aac"]) assert.equal(fixtureData.calls.filter(call => new URL(call.url).pathname === name).length, 1);
  for (const input of bundle.inputs) assert.match(await bundle.files.find(file => file.name === input.name).blob.text(), /#EXT-X-ENDLIST/);
  assert.equal(events.at(-1).phase, "merging");
  assert.equal(events.at(-1).done, 4);
});
test("DASH separately assembles all init/video/audio fragments without losing the last part", async () => {
  const fixtureData = fixture({
    "/index.mpd": '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v"><SegmentTemplate duration="2" initialization="vi" media="v$Number$"/></Representation></AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a"><SegmentTemplate duration="2" initialization="ai" media="a$Number$"/></Representation></AdaptationSet></Period></MPD>',
    "/vi": "vi", "/v1": "v1", "/v2": "v2", "/ai": "ai", "/a1": "a1", "/a2": "a2"
  });
  const plan = await resolveStream({ kind: "dash", url: "https://cdn.test/index.mpd" }, {}, fixtureData);
  const bundle = await downloadStream(plan, fixtureData, control());
  assert.equal(await bundle.files[0].blob.text(), "viv1v2");
  assert.equal(await bundle.files[1].blob.text(), "aia1a2");
});
test("live HLS polls changing windows, deduplicates sequence IDs and saves the final segment", async () => {
  let reads = 0;
  const calls = [];
  const fetcher = async url => {
    const pathname = new URL(url).pathname; calls.push(pathname);
    if (pathname === "/live.m3u8") {
      reads++;
      return new Response(reads === 1 ? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n0.ts\n#EXTINF:1,\n1.ts' : '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,\n1.ts\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST');
    }
    return new Response(pathname);
  };
  const plan = await resolveStream({ kind: "hls", url: "https://cdn.test/live.m3u8" }, {}, { fetcher });
  const bundle = await downloadStream(plan, { fetcher }, control());
  assert.equal(bundle.duration, 3);
  assert.equal(calls.filter(pathname => pathname === "/1.ts").length, 1);
  assert.equal(calls.filter(pathname => pathname === "/2.ts").length, 1);
});
test("live recording fails visibly if the server drops segments before they can be fetched", async () => {
  let reads = 0;
  const fetcher = async url => new Response(url.endsWith(".m3u8") ? `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${reads++ ? 10 : 0}\n#EXTINF:1,\npart.ts` : "part");
  const plan = await resolveStream({ kind: "hls", url: "https://cdn.test/live.m3u8" }, {}, { fetcher });
  await assert.rejects(downloadStream(plan, { fetcher }, control()), /advanced before all parts/);
});
test("Finish saves captured live parts, while cancel rejects before further requests", async () => {
  const fixtureData = fixture({ "/live.m3u8": '#EXTM3U\n#EXTINF:1,\npart.ts', "/part.ts": "part" });
  const plan = await resolveStream({ kind: "hls", url: "https://cdn.test/live.m3u8" }, {}, fixtureData);
  const active = control(); active.finish = true;
  assert.equal((await downloadStream(plan, fixtureData, active)).duration, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(downloadStream(plan, fixtureData, { ...control(), signal: abort.signal }), { name: "AbortError" });
});
test("signed redirects use the final manifest base and low-latency controls are removed only", async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url); const reply = new Response('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST');
    Object.defineProperty(reply, "url", { value: "https://edge.test/path/new.m3u8" }); return reply;
  };
  const result = await resolveStream({ kind: "hls", url: base + "&_HLS_skip=YES&_HLS_msn=42" }, {}, { fetcher });
  assert.equal(calls[0], base);
  assert.equal(result.tracks[0].playlist.segments[0].url, "https://edge.test/path/a.ts");
});
test("range validation and page-context leases are cleaned up even on failure", async () => {
  const removed = [];
  const options = { beforeFetch: async () => 42, afterFetch: async id => removed.push(id), fetcher: async () => new Response("data", { status: 206, headers: { "content-range": "bytes 0-3/4" } }) };
  assert.equal((await getResource({ url: "https://cdn.test/a.mp4", range: { start: 0, end: 3 } }, options)).bytes.length, 4);
  await assert.rejects(getResource({ url: "https://cdn.test/a.mp4", range: { start: 10, end: 13 } }, options), /wrong part/);
  assert.deepEqual(removed, [42, 42]);
});
test("transient server errors retry, expired links do not retry and missing media fails clearly", async () => {
  let attempts = 0;
  const reply = await getResource({ url: "https://cdn.test/a.mp4" }, { fetcher: async () => ++attempts === 1 ? new Response("busy", { status: 503 }) : new Response("video") });
  assert.equal(reply.bytes.length, 5); assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(getResource({ url: "https://cdn.test/expired.mp4" }, { fetcher: async () => { attempts++; return new Response("gone", { status: 404 }); } }), /HTTP 404/);
  assert.equal(attempts, 1);
  assert.match(serverError("SERVER_FORBIDDEN"), /Replay the video/);
});
test("protected-file fallback fetches the entire ranged response instead of saving only its first part", async () => {
  const calls = [];
  const blob = await fetchWholeFile("https://cdn.test/file.mp4", { fetcher: async (_url, init) => {
    calls.push(init.headers.Range || "initial");
    return init.headers.Range ? new Response("last", { status: 206, headers: { "content-range": "bytes 5-8/9" } }) : new Response("first", { status: 206, headers: { "content-range": "bytes 0-4/9" } });
  } });
  assert.equal(await blob.text(), "firstlast");
  assert.deepEqual(calls, ["initial", "bytes=5-8"]);
});
