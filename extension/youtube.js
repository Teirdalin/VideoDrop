import { Innertube, Log } from './vendor/youtube/browser.js';
import { youtubeUrl } from './youtube-url.js';
import { readLimited } from './lib/hls.js';

export const MAX_YOUTUBE_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
Log.setLevel(Log.Level.ERROR);

export function selectTracks(formats) {
  // Only complete, directly signed, unencrypted resources; never execute remote JS.
  const usable = formats.filter(f => {
    if (f.drm_families?.length || f.is_type_otf || !Number.isSafeInteger(f.content_length) || f.content_length <= 0) return false;
    try { const url = new URL(f.url); return url.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(url.hostname) && !url.searchParams.has('n'); }
    catch { return false; }
  });
  const audio = usable.filter(f => f.has_audio && !f.has_video).sort((a,b) => Number(!!b.audio_track?.audio_is_default) - Number(!!a.audio_track?.audio_is_default) || Number(b.mime_type.startsWith('audio/mp4')) - Number(a.mime_type.startsWith('audio/mp4')) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!audio) throw new Error('YouTube did not provide a complete audio track for this video. Try another public video or scan again.');
  const heights = new Map();
  const rank = f => /avc1/.test(f.mime_type) ? 3 : /av01/.test(f.mime_type) ? 2 : 1;
  for (const video of usable.filter(f => f.has_video && !f.has_audio && f.height > 0)) {
    const previous = heights.get(video.height);
    if (!previous || rank(video) > rank(previous) || (rank(video) === rank(previous) && (video.bitrate || 0) > (previous.bitrate || 0))) heights.set(video.height, video);
  }
  const tracks = [...heights.values()].sort((a,b) => b.height - a.height).map(video => ({ id: `video:${video.height}`, height: video.height, video, audio, ext: video.mime_type.startsWith('video/webm') ? 'mkv' : 'mp4' }));
  tracks.push({ id: 'audio:mp3', audio, ext: 'mp3' });
  return tracks.map(track => ({ ...track, totalBytes: track.audio.content_length + (track.video?.content_length || 0) }));
}

async function metadata(source, signal) {
  const url = youtubeUrl(source.url);
  if (!url) throw new Error('Open a specific YouTube video and scan again.');
  const client = await Innertube.create({ generate_session_locally: false, retrieve_player: false, enable_session_cache: false,
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, credentials: 'omit', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) throw new Error(`YouTube did not serve this video (${response.status}). Refresh the page and scan again.`);
      return response;
    } });
  const info = await client.getBasicInfo(new URL(url).searchParams.get('v'), { client: 'VISIONOS' });
  if (info.playability_status?.status !== 'OK') throw new Error(info.playability_status?.reason || 'This YouTube video is unavailable.');
  if (info.basic_info.is_live || info.basic_info.is_live_content && !info.basic_info.duration) throw new Error('YouTube live broadcasts are not supported yet. Try a completed video.');
  const tracks = selectTracks([...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])]);
  return { title: info.basic_info.title, tracks };
}

export async function inspectYouTube(source, { signal } = {}) {
  const { tracks } = await metadata(source, signal);
  return { type: 'youtube', variants: tracks.map(track => ({ id: track.id, height: track.height, ext: track.ext,
    label: track.id === 'audio:mp3' ? 'Audio only (MP3)' : `${track.height}p${track.totalBytes > MAX_YOUTUBE_BYTES ? ' · Over 512 MB' : ''}`,
    blocked: track.totalBytes > MAX_YOUTUBE_BYTES ? 'This quality exceeds the 512 MB browser memory limit. Choose a lower resolution.' : '', separateAudio: !!track.video })) };
}

export async function fetchYouTubeTrack(track, { signal, fetcher = fetch } = {}, progress = () => {}) {
  const pieces = [];
  for (let start = 0; start < track.content_length; start += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(track.content_length - 1, start + CHUNK_BYTES - 1), wanted = end - start + 1;
    const url = new URL(track.url); url.searchParams.set('range', `${start}-${end}`);
    let bytes;
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeout = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]);
      try {
        const response = await fetcher(url.href, { credentials: 'omit', cache: 'no-store', signal: timeout });
        bytes = await readLimited(response, wanted, timeout);
        if (bytes.length !== wanted) throw new Error('YouTube returned an incomplete track. Scan again to refresh its download link.');
        const range = response.headers.get('content-range');
        if (range && range !== `bytes ${start}-${end}/${track.content_length}`) throw new Error('YouTube returned the wrong portion of this track. Scan again.');
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === 2) throw new Error(`${error.message} (track ${track.itag}, byte ${start})`);
      }
    }
    pieces.push(bytes); await progress(bytes.length);
  }
  return new Blob(pieces, { type: track.mime_type.split(';')[0] });
}

export async function downloadYouTube(source, selection, options, active, onProgress) {
  const { tracks } = await metadata(source, options.signal);
  const track = tracks.find(item => item.id === selection.variantId);
  if (!track) throw new Error('This YouTube quality is no longer available. Scan again.');
  if (track.totalBytes > MAX_YOUTUBE_BYTES) throw new Error('This quality exceeds the 512 MB browser memory limit. Choose a lower resolution.');
  let received = 0;
  const progress = async count => { received += count; await onProgress({ phase: 'preparing', received, totalBytes: track.totalBytes }); };
  const files = [], inputs = [];
  for (const [kind, resource] of [['video', track.video], ['audio', track.audio]]) {
    if (!resource) continue;
    const name = `${kind}.${resource.mime_type.includes('webm') ? 'webm' : 'mp4'}`;
    const blob = await fetchYouTubeTrack(resource, options, progress);
    files.push({ name, blob }); inputs.push({ name, kind });
  }
  active.signal.throwIfAborted();
  await onProgress({ phase: 'merging', received, totalBytes: track.totalBytes, detail: track.id === 'audio:mp3' ? 'MP3 · 192 kbps' : `${track.height}p · Full video + audio` });
  return { files, inputs, ext: track.ext, mode: track.ext === 'mp3' ? 'mp3' : 'video', detail: track.id === 'audio:mp3' ? 'MP3 · 192 kbps' : `${track.height}p · Full video + audio` };
}
