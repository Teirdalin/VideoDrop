import { youtubeUrl, augmentModel } from "./youtube-url.js";
export { ensureYouTubeHeaders as prepareMedia } from "./youtube-headers.js";

export const buildLabel = "Full · YouTube + MP3";
export const initializeEdition = async () => {};
export const sourceAllowed = () => true;
export const assertSourceAllowed = () => {};
export const verifyDirectSource = async url => url;
export { augmentModel };
export function pageSource(tab) {
  const url = youtubeUrl(tab?.url);
  return url ? { kind: "youtube", url, ext: "mp4", title: tab.title } : null;
}
export function emptyPageMessage(url) {
  return /^https?:\/\/(?:[^/]+\.)?(?:youtube\.com|youtu\.be)\//.test(url)
    ? "Open a specific YouTube video to choose its quality or download MP3." : "";
}
export function selectionDetails(choice) {
  return choice.item.kind === "youtube" && choice.expanded && !choice.blocked
    ? choice.variantId === "audio:mp3" ? "192 kbps" : `${choice.ext.toUpperCase()} · Includes audio` : null;
}
