import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { removeBundledGoogleApiKeys } from './youtube-vendor-keys.mjs';
const dir=new URL('../youtube/vendor/',import.meta.url);
const version='18.3.0';
const url=`https://registry.npmjs.org/youtubei.js/-/youtubei.js-${version}.tgz`;
const integrity='sha512-6Cwn/U8a+OjpZp5XgqOjwy7Lk0RrGavm3I5zO7qZWO+fes20vhWMZnlUs0h/97SwjS0AsxAZrZ5bJ85XBJVWTw==';
const response=await fetch(url);if(!response.ok)throw new Error(`YouTube.js vendor fetch failed: ${response.status}`);
const archive=Buffer.from(await response.arrayBuffer());
if(`sha512-${createHash('sha512').update(archive).digest('base64')}`!==integrity)throw new Error('Pinned YouTube.js integrity mismatch');
await mkdir(dir,{recursive:true});const tar=gunzipSync(archive),files=[];
for(let offset=0;offset+512<tar.length;){
  const name=tar.subarray(offset,offset+100).toString().split('\0')[0];if(!name)break;
  const size=parseInt(tar.subarray(offset+124,offset+136).toString().replace(/\0/g,'').trim(),8)||0;
  if(['package/bundle/browser.js','package/LICENSE','package/package.json'].includes(name)){
    const basename=name.split('/').at(-1);
    const original=tar.subarray(offset+512,offset+512+size);
    const data=basename==='browser.js' ? Buffer.from(removeBundledGoogleApiKeys(original.toString('utf8'))) : original;
    await writeFile(new URL(basename,dir),data);files.push({name:basename,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  }
  offset+=512+Math.ceil(size/512)*512;
}
if(files.length!==3)throw new Error('The pinned YouTube.js archive lacks required files');
const patches=['Removed hard-coded Google API key defaults from browser.js'];
await writeFile(new URL('provenance.json',dir),JSON.stringify({version,url,integrity,files,patches},null,2));
console.log(`Verified and bundled YouTube.js ${version}`);
