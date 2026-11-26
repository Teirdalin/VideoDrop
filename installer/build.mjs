import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Build the Windows setup on Windows.');

const installer = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(installer);
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
const dist = path.join(root, 'dist');
const archive = path.join(dist, `VideoDrop-Full-${version}.zip`);
const setup = path.join(dist, `VideoDrop-Setup-${version}.exe`);
const buildInfo = path.join(dist, 'SetupVersion.cs');
const options = { cwd: root, stdio: 'inherit', windowsHide: true };

execFileSync(process.execPath, [path.join(root, 'tools', 'package-chrome.mjs')], options);
await writeFile(buildInfo, `[assembly: System.Reflection.AssemblyVersion("${version}")]\n`);
try {
  execFileSync(compiler, [
    '/nologo', '/target:winexe', '/optimize+', `/out:${setup}`, `/resource:${archive},VideoDrop.zip`,
    `/win32manifest:${path.join(installer, 'Setup.manifest')}`,
    '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    path.join(installer, 'Setup.cs'), buildInfo,
  ], options);
} finally {
  await rm(buildInfo, { force: true });
}

const sums = await Promise.all([setup, archive].map(async file => {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  return `${hash}  ${path.basename(file)}`;
}));
await writeFile(path.join(dist, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(`Built ${setup}`);
