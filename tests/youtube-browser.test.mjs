import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { youtubeUrl, augmentModel } from '../youtube/url.js';
import { selectTracks, fetchYouTubeTrack } from '../chrome-extension/youtube.js';
import { safeFilename } from '../chrome-extension/lib/media.js';

test('Browser YouTube source is the current video and rejects lookalike domains', () => {
  const url='https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  assert.equal(youtubeUrl('https://youtu.be/aqz-KE-bpKQ?t=20'),url);
  assert.equal(youtubeUrl('https://m.youtube.com/shorts/aqz-KE-bpKQ'),url);
  for(const bad of ['https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ','https://user@youtube.com/watch?v=aqz-KE-bpKQ','https://youtube.com/playlist?list=123','file:///watch?v=aqz-KE-bpKQ']) assert.equal(youtubeUrl(bad),null);
  assert.deepEqual(augmentModel({items:[],jobs:[]},{url,title:'Film'}).items,[{kind:'youtube',url,ext:'mp4',title:'Film'}]);
});
const audio=(extra={})=>({itag:140,has_audio:true,has_video:false,mime_type:'audio/mp4; codecs="mp4a.40.2"',bitrate:128000,content_length:1000,url:'https://r1.googlevideo.com/videoplayback?sig=x',...extra});
const video=(extra={})=>({itag:137,has_video:true,has_audio:false,height:1080,mime_type:'video/mp4; codecs="avc1.640028"',content_length:5000,url:'https://r1.googlevideo.com/videoplayback?sig=x',...extra});
test('Browser selects compatible complete AV tracks and offers true MP3 separately', () => {
  const a=audio(), h264=video();
  const tracks=selectTracks([video({mime_type:'video/mp4; codecs="av01"',bitrate:2000000}),h264,a]);
  assert.equal(tracks[0].video,h264);assert.equal(tracks[0].audio,a);assert.equal(tracks[0].id,'video:1080');
  assert.equal(tracks[0].totalBytes,6000);assert.equal(tracks[1].id,'audio:mp3');assert.equal(tracks[1].video,undefined);
  assert.equal(safeFilename('A film.mp3','mp3'),'A film.mp3');
});
test('Browser rejects unsigned, unbounded, encrypted and remote-code-dependent tracks', () => {
  for(const invalid of [{url:'https://evil.test/a.mp4'},{url:'https://r1.googlevideo.com/videoplayback?n=challenge'},{url:''},{content_length:NaN},{drm_families:['widevine']},{is_type_otf:true}]) {
    assert.deepEqual(selectTracks([audio(),video(invalid)]).map(t=>t.id),['audio:mp3']);
  }
  assert.throws(()=>selectTracks([video()]),/complete audio/);
});
test('Browser fetches every byte including a short final chunk, preserving signed URL fields', async () => {
  const expected=new Uint8Array(1024*1024+57).map((_,i)=>i%251),ranges=[];
  const blob=await fetchYouTubeTrack(audio({content_length:expected.length,url:'https://r1.googlevideo.com/videoplayback?sig=a%2Fb&expire=1'}),{fetcher:async value=>{
    const url=new URL(value);assert.equal(url.searchParams.get('sig'),'a/b');ranges.push(url.searchParams.get('range'));
    const [start,end]=ranges.at(-1).split('-').map(Number);return new Response(expected.slice(start,end+1));
  }});
  assert.deepEqual(ranges,['0-1048575','1048576-1048632']);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),expected);
});
test('Browser refuses incomplete or incorrect ranges and honors cancellation',async()=>{
  await assert.rejects(fetchYouTubeTrack(audio({content_length:10}),{fetcher:async()=>new Response(new Uint8Array(4))}),/incomplete track/);
  await assert.rejects(fetchYouTubeTrack(audio({content_length:10}),{fetcher:async()=>new Response(new Uint8Array(10),{status:206,headers:{'content-range':'bytes 1-10/10'}})}),/wrong portion/);
  const controller=new AbortController();controller.abort(new Error('Canceled by user'));
  await assert.rejects(fetchYouTubeTrack(audio(),{signal:controller.signal,fetcher:()=>assert.fail('No fetch after cancel')}),/Canceled by user/);
});
test('Browser-only package uses packaged engines and has no native or remote script permission',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../chrome-extension/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.permissions.includes('nativeMessaging'),false);
  assert.ok(!manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"));
  const source=await readFile(new URL('../chrome-extension/youtube.js',import.meta.url),'utf8');
  assert.ok(source.includes('retrieve_player: false'));assert.ok(source.includes("credentials: 'omit'"));
  const background=await readFile(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
  assert.ok(!/nativeHandle|connectNative/.test(background));
});
