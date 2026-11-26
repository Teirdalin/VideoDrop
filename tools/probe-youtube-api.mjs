import { Innertube, Platform, Log } from '../.tmp/browser-youtube-vendor/browser.js';
Log.setLevel(Log.Level.ERROR);
Platform.shim.eval = async data => new Function(data.output)();
const client = await Innertube.create({ generate_session_locally: false, retrieve_player: false, enable_session_cache: false, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) });
for (const type of ['VISIONOS', 'ANDROID_VR']) {
  try {
    const info = await client.getBasicInfo('aqz-KE-bpKQ', { client: type });
    const formats = [...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])];
    console.log(JSON.stringify({client:type,status:info.playability_status?.status,reason:info.playability_status?.reason,title:info.basic_info.title,count:formats.length,direct:formats.filter(f=>f.url).length,hls:!!info.streaming_data?.hls_manifest_url}));
    const format = formats.find(f=>f.url && f.has_audio && !f.has_video) || formats[0];
    if (format) {
      const url = new URL(await format.decipher(client.session.player)); url.searchParams.set('range','262144-263167');
      const r = await fetch(url,{signal:AbortSignal.timeout(20000)});
      console.log(JSON.stringify({client:type,mediaStatus:r.status,mime:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}));
    }
  } catch(error) { console.log(JSON.stringify({client:type,error:error.message})); }
}
