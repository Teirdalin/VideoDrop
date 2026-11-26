import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
const root = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));

test("manifest and referenced entry points are complete for a local MV3 install", async () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal('key' in manifest, false, 'The upload manifest must not contain a development key');
  assert.equal(manifest.background.type, "module");
  const paths = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)];
  for (const file of paths) await access(new URL(file, root));
  assert.equal(manifest.permissions.includes("webRequestBlocking"), false);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.web_accessible_resources, undefined);
});
test("toolbar icons are valid PNG files at all declared sizes", async () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const bytes = await readFile(new URL(file, root));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), Number(size));
    assert.equal(bytes.readUInt32BE(20), Number(size));
  }
});
test("popup bundles all code locally and support links have safe external navigation", async () => {
  const html = await readFile(new URL("popup.html", root), "utf8");
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
  assert.ok(html.includes('href="https://www.patreon.com/cw/Teirdalin" target="_blank" rel="noopener noreferrer"'));
  assert.ok(html.includes('href="https://ko-fi.com/teirdalin" target="_blank" rel="noopener noreferrer"'));
});
