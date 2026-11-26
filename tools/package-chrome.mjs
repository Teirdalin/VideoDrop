import { readdir,readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipEntries } from './archive.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.execPath,[path.join(root,'tools','test-chrome.mjs')],{cwd:root,stdio:'inherit',windowsHide:true});
async function files(dir,prefix=''){
  const entries=[];for(const item of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(item.isDirectory())entries.push(...await files(path.join(dir,item.name),prefix+item.name+'/'));
    else {if(/\.(exe|bat|ps1|py)$/i.test(item.name)||/native-background/i.test(item.name))throw new Error(`Unexpected native file: ${item.name}`);entries.push({name:prefix+item.name,data:await readFile(path.join(dir,item.name))});}
  }return entries;
}
const extension=path.join(root,'extension');
const entries=await files(extension),manifest=JSON.parse(entries.find(e=>e.name==='manifest.json').data);
if(manifest.permissions.includes('nativeMessaging'))throw new Error('Native permission in browser-only package');
if('key' in manifest)throw new Error('Development key in upload manifest');
for(const entry of entries.filter(e=>e.name.endsWith('.js')&&!e.name.startsWith('vendor/')))execFileSync(process.execPath,['--check',path.join(extension,entry.name)],{windowsHide:true,stdio:'inherit'});
for(const name of ['README.md','PRIVACY.md','THIRD-PARTY.md','LICENSE','BRANDING.md']){
  entries.push({name,data:await readFile(path.join(root,name))});
}
const bytes=zipEntries(entries),filename=`VideoDrop-Full-${manifest.version}.zip`,output=path.join(root,'dist',filename),sha256=data=>createHash('sha256').update(data).digest('hex');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);
await writeFile(output+'.receipt.json',JSON.stringify({archive:filename,edition:'full',version:manifest.version,createdAt:new Date().toISOString(),bytes:bytes.length,sha256:sha256(bytes),files:entries.map(e=>({path:e.name,bytes:e.data.length,sha256:sha256(e.data)}))},null,2));
console.log(`${filename}: ${entries.length} files, ${bytes.length} bytes, SHA-256 ${sha256(bytes)}`);
