// Scope header adjustments to the actual installed ID, including store IDs.
let preparing;
export function ensureYouTubeHeaders() {
  if (!preparing) preparing = (async () => {
    const condition = { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] };
    const rules = [
      { id: 11001, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Origin', operation: 'remove' },
        { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15' }
      ] }, condition: { ...condition, requestDomains: ['youtube.com'] } },
      { id: 11002, priority: 1, action: { type: 'modifyHeaders', requestHeaders: ['Origin', 'Referer', 'User-Agent', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest'].map(header => ({ header, operation: 'remove' })) }, condition: { ...condition, requestDomains: ['googlevideo.com'] } }
    ];
    // One atomic update preserves unrelated dynamic rules and survives suspension.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id), addRules: rules });
  })().catch(error => { preparing = null; throw error; });
  return preparing;
}
