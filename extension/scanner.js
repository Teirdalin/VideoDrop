(() => {
  const MEDIA = /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(?:$|[?#])/i;
  let timer, lastSignature = "";

  function scan(force = false) {
    const items = [];
    let hasBlob = false, hasProtected = false;
    for (const video of document.querySelectorAll("video")) {
      hasProtected ||= !!video.mediaKeys;
      for (const url of new Set([video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map(source => source.src)])) {
        if (!url) continue;
        if (url.startsWith("blob:")) { hasBlob = true; continue; }
        items.push({ url, mime: video.querySelector("source")?.type || "video/mp4", title: document.title, width: video.videoWidth, height: video.videoHeight, duration: video.duration, source: "page" });
      }
    }
    for (const entry of performance.getEntriesByType("resource")) {
      if (MEDIA.test(entry.name)) items.push({ url: entry.name, bytes: entry.decodedBodySize, source: "page" });
    }
    const report = { type: "SCAN_RESULT", items: items.slice(-80), hasBlob, hasProtected };
    const signature = JSON.stringify(report);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage(report).catch(() => {});
  }

  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 350); };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  for (const name of ["loadedmetadata", "play", "encrypted", "emptied"]) document.addEventListener(name, schedule, true);
  try { new PerformanceObserver(schedule).observe({ type: "resource", buffered: true }); } catch { /* DOM scanning still works */ }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "SCAN_NOW") scan(true);
  });
  scan(true);
})();
