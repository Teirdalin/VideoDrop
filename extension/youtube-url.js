export function youtubeUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    let id;
    if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : null;
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}

export function augmentModel(model, tab) {
  const url = youtubeUrl(tab?.url);
  return url ? { ...model, items: [{ kind: 'youtube', url, ext: 'mp4', title: tab.title || 'YouTube video' }] } : model;
}
