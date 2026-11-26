// Fetch a pinned official npm artifact, verify its registry SRI, and copy only
// the single-thread ESM core. No install hooks or third-party scripts are run.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = new URL("../extension/vendor/ffmpeg/", import.meta.url);
const version = "0.12.10";
const metadataUrl = `https://registry.npmjs.org/@ffmpeg/core/${version}`;
const metadata = await (await fetch(metadataUrl)).json();
const tarball = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
const [algorithm, expected] = metadata.dist.integrity.split("-");
if (createHash(algorithm).update(tarball).digest("base64") !== expected) throw new Error("FFmpeg artifact integrity mismatch");
const tar = gunzipSync(tarball);
await mkdir(output, { recursive: true });
const wanted = new Map([["package/dist/esm/ffmpeg-core.js", "ffmpeg-core.js"], ["package/dist/esm/ffmpeg-core.wasm", "ffmpeg-core.wasm"], ["package/package.json", "package.json"]]);
const files = [];
for (let offset = 0; offset + 512 <= tar.length;) {
  const name = tar.subarray(offset, offset + 100).toString().split("\0")[0];
  if (!name) break;
  const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0/g, "").trim(), 8) || 0;
  const content = tar.subarray(offset + 512, offset + 512 + size);
  if (wanted.has(name)) {
    const filename = wanted.get(name);
    await writeFile(new URL(filename, output), content);
    files.push({ file: filename, bytes: size, sha256: createHash("sha256").update(content).digest("hex") });
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (files.length !== wanted.size) throw new Error("The pinned artifact did not contain the expected core files");
const license = await (await fetch("https://raw.githubusercontent.com/FFmpeg/FFmpeg/n5.1.4/COPYING.GPLv2")).text();
if (!license.includes("GNU GENERAL PUBLIC LICENSE")) throw new Error("Missing FFmpeg license text");
await writeFile(new URL("COPYING.GPLv2", output), license);
await writeFile(new URL("provenance.json", output), JSON.stringify({ package: "@ffmpeg/core", version, license: metadata.license, metadataUrl, tarball: metadata.dist.tarball, integrity: metadata.dist.integrity, gitHead: metadata.gitHead, source: "https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15", files }, null, 2));
console.log(`Verified and bundled FFmpeg ${version}: ${files.map(file => file.file).join(", ")} in ${fileURLToPath(output)}`);
