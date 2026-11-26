import { inspectYouTube, downloadYouTube } from "./youtube.js";
import { inspectStream, resolveStream, downloadStream } from "./lib/streams.js";

export async function inspectSource(source, options) {
  return (source.kind === "youtube" ? inspectYouTube : inspectStream)(source, options);
}
export async function downloadSource(source, selection, options, active, onProgress) {
  return source.kind === "youtube" ? downloadYouTube(source, selection, options, active, onProgress)
    : downloadStream(await resolveStream(source, selection, options), options, active, onProgress);
}
