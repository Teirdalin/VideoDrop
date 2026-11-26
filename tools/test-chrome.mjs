import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.execPath,[path.join(root,'tools','build-chrome.mjs')],{cwd:root,stdio:'inherit',windowsHide:true});
// The archived native-bridge suite belongs to the historical helper release.
const tests=(await readdir(path.join(root,'tests'))).filter(name=>name.endsWith('.test.mjs')&&name!=='desktop.test.mjs').map(name=>path.join(root,'tests',name));
execFileSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',windowsHide:true});
