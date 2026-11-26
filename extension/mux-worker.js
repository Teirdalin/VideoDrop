import createFFmpegCore from "./vendor/ffmpeg/ffmpeg-core.js";

self.onmessage = async ({ data }) => {
  const errors = [];
  try {
    const coreUrl = new URL("./vendor/ffmpeg/ffmpeg-core.js", import.meta.url).href;
    const wasmURL = new URL("./vendor/ffmpeg/ffmpeg-core.wasm", import.meta.url).href;
    const core = await createFFmpegCore({ mainScriptUrlOrBlob: `${coreUrl}#${btoa(JSON.stringify({ wasmURL }))}` });
    core.setLogger(({ type, message }) => { if (type === "stderr") { errors.push(message); if (errors.length > 16) errors.shift(); } });
    core.FS.mkdir("/inputs");
    const files = data.files.map(file => new File([file.blob], file.name));
    core.FS.mount(core.FS.filesystems.WORKERFS, { files }, "/inputs");
    const base = ["-hide_banner", "-loglevel", "warning"];
    for (const input of data.inputs) {
      if (input.hls) base.push("-allowed_extensions", "ALL", "-protocol_whitelist", "file,crypto,data");
      base.push("-i", `/inputs/${input.name}`);
    }
    if (data.mode !== "mp3") base.push("-map", "0:v:0");
    const audioIndex = data.inputs.findIndex(input => input.kind === "audio");
    if (data.mode === "mp3") base.push("-map", `${Math.max(0, audioIndex)}:a:0`, "-vn", "-c:a", "libmp3lame", "-b:a", "192k");
    else base.push("-map", audioIndex >= 0 ? `${audioIndex}:a:0` : "0:a:0?", "-c", "copy", "-max_muxing_queue_size", "2048", "-avoid_negative_ts", "make_zero");
    let ext = data.mode === "mp3" ? "mp3" : data.ext === "mkv" ? "mkv" : data.ext === "webm" ? "webm" : "mp4";
    const execute = format => {
      core.setTimeout(120000);
      const result = core.exec(...base, ...(format === "mp4" ? ["-movflags", "+faststart"] : []), `/output.${format}`);
      core.reset(); return result;
    };
    let result = execute(ext);
    if (result !== 0 && ext === "mp4") {
      try { core.FS.unlink("/output.mp4"); } catch { /* no partial output */ }
      ext = "mkv"; result = execute(ext);
    }
    if (result !== 0) throw new Error(`The downloaded tracks could not be merged. ${errors.slice(-3).join(" ").slice(0, 400)}`);
    const bytes = core.FS.readFile(`/output.${ext}`);
    if (bytes.length < 100) throw new Error("The stream produced no complete video data.");
    self.postMessage({ ok: true, bytes, ext }, [bytes.buffer]);
  } catch (error) { self.postMessage({ ok: false, error: error.message || "The local media engine could not merge this video." }); }
};
