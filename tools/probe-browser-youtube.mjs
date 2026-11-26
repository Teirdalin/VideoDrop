import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
const dir = new URL("../.tmp/browser-youtube-vendor/", import.meta.url);
await mkdir(dir, { recursive: true });
const metadata = await (await fetch("https://registry.npmjs.org/youtubei.js/latest")).json();
const archive = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
const [method, digest] = metadata.dist.integrity.split("-");
if (createHash(method).update(archive).digest("base64") !== digest) throw new Error("YouTube.js artifact integrity mismatch");
const tar = gunzipSync(archive), names = [];
for (let offset = 0; offset + 512 < tar.length;) {
  const name = tar.subarray(offset, offset + 100).toString().split("\0")[0]; if (!name) break;
  const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0/g, "").trim(), 8) || 0;
  if (/package\/(?:bundle\/.*\.js|LICENSE|package\.json)$/.test(name)) {
    names.push({ name, size });
    if (/package\/(?:bundle\/browser\.js|LICENSE|package\.json)$/.test(name)) await writeFile(new URL(name.split("/").at(-1), dir), tar.subarray(offset + 512, offset + 512 + size));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
await writeFile(new URL("provenance.json", dir), JSON.stringify({ version: metadata.version, integrity: metadata.dist.integrity, url: metadata.dist.tarball, files: names }, null, 2));
console.log(JSON.stringify({ version: metadata.version, files: names }));
