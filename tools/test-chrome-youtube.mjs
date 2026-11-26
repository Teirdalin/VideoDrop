// Real public-video downloads through the browser-only extension. No native host.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, '.tmp', `chrome-youtube-${Date.now()}`);
await mkdir(path.join(run, 'downloads'), { recursive: true });
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.ok(!manifest.permissions.includes('nativeMessaging'));
assert.equal('key' in manifest,false);
let id;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn,label,limit=40000) { const end=Date.now()+limit;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){if(error.fatal)throw error;last=error;}await pause(200);}throw new Error(`Timed out: ${label}${last?' · '+last.message:''}`); }
class CDP {
  constructor(socket){this.socket=socket;this.count=0;this.pending=new Map();socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id&&this.pending.has(reply.id)){const task=this.pending.get(reply.id);this.pending.delete(reply.id);reply.error?task.reject(new Error(JSON.stringify(reply.error))):task.resolve(reply.result);}});}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.count;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout ${method}`));},65000);this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async attach(target){return(await this.send('Target.attachToTarget',{targetId:target,flatten:true})).sessionId;}
  async eval(expression,session){const reply=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},session);if(reply.exceptionDetails)throw new Error(JSON.stringify(reply.exceptionDetails));return reply.result.value;}
}
const report={run,checks:[],version:manifest.version};let browser,proc,log;
function pass(name,values={}){report.checks.push({name,...values});console.log(`PASS ${name}`);}
try {
  log=await open(path.join(run,'browser.log'),'w');
  const useChrome = process.argv.includes('--chrome');
  const executable = useChrome ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  proc=spawn(executable,['--headless=new','--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking',`--user-data-dir=${path.join(run,'profile')}`,'--remote-debugging-port=0',...(!useChrome?[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]:[]),'about:blank'],{windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  const port=await until(async()=>(await readFile(path.join(run,'profile','DevToolsActivePort'),'utf8')).trim().split(/\r?\n/),'isolated browser');
  const socket=new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});browser=new CDP(socket);
  report.browser=await browser.send('Browser.getVersion');
  if(useChrome) await browser.send('Extensions.loadUnpacked',{path:extension});
  await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(run,'downloads')});
  const sessions=new Map();
  const worker=await until(async()=>{
    const targets=(await browser.send('Target.getTargets')).targetInfos.filter(target=>target.type==='service_worker'&&target.url.endsWith('/background.js'));
    for(const target of targets){
      if(!sessions.has(target.targetId)){const session=await browser.attach(target.targetId);await browser.send('Runtime.enable',{},session);sessions.set(target.targetId,session);}
      const actual=await browser.eval("typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()",sessions.get(target.targetId)).catch(()=>null);
      if(actual?.name===manifest.name&&actual.version===manifest.version)return target;
    }
  },'key-free service worker');
  id=new URL(worker.url).host;report.extensionId=id;
  const workerSession=sessions.get(worker.targetId);
  const sw=expression=>browser.eval(expression,workerSession);
  await until(()=>sw("typeof chrome !== 'undefined' && !!chrome.storage"),'extension APIs');
  // Open a real public page in the isolated profile; keep it active while the
  // popup is exercised in a separate background tab.
  const video='https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const realTab=await sw(`chrome.tabs.create({url:${JSON.stringify(video)},active:true})`);
  await until(()=>sw(`chrome.tabs.get(${realTab.id}).then(tab=>tab.status==='complete')`),'public video page',70000);
  await sw("chrome.tabs.create({url:chrome.runtime.getURL('popup.html'),active:false})");
  const popup=await until(async()=>(await browser.send('Target.getTargets')).targetInfos.find(target=>target.url===`chrome-extension://${id}/popup.html`),'popup');
  const session=await browser.attach(popup.targetId);await browser.send('Runtime.enable',{},session);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:360,height:600,deviceScaleFactor:1,mobile:false},session);
  const ui=expression=>browser.eval(expression,session);
  async function capture(filename){const height=await ui("Math.ceil(document.querySelector('main').getBoundingClientRect().height)");await writeFile(path.join(run,filename),Buffer.from((await browser.send('Page.captureScreenshot',{clip:{x:0,y:0,width:360,height:Math.min(600,height),scale:1},captureBeyondViewport:true},session)).data,'base64'));}
  await until(async()=>{const text=await ui("document.querySelector('#selection-meta').textContent");if(/unavailable|did not provide|failed|Failed|fetch|error/i.test(text)){const error=new Error(text);error.fatal=true;throw error;}return ui("[...document.querySelector('#video-picker').options].some(option=>option.value.includes('audio:mp3'))");},'YouTube dropdown',70000);
  const options=await ui("[...document.querySelector('#video-picker').options].map(option=>option.textContent)");
  assert.ok(options.some(option=>option.includes('1080p')));assert.ok(options.some(option=>option.includes('MP3')));
  pass('Browser-only YouTube resolution and MP3 dropdown',{options});
  const youtubeRules=(await sw('chrome.declarativeNetRequest.getDynamicRules()')).filter(rule=>[11001,11002].includes(rule.id));
  assert.equal(youtubeRules.length,2);
  assert.ok(youtubeRules.every(rule=>rule.condition.initiatorDomains.length===1&&rule.condition.initiatorDomains[0]===id));
  pass('YouTube rules use the installed extension ID without a manifest key',{extensionId:id});
  assert.equal(await ui("document.querySelector('#build-info').textContent"),`VideoDrop ${manifest.version} · Full · YouTube + MP3`);
  pass('Main extension folder includes YouTube and identifies its version in Settings');
  if(process.argv.includes('--ui-only')){
    await capture('youtube-picker.png');
    await ui("{const picker=document.querySelector('#video-picker');picker.value=[...picker.options].find(option=>option.value.endsWith('audio:mp3')).value;picker.dispatchEvent(new Event('change'));}");
    assert.equal(await ui("document.querySelector('#download span').textContent"),'Download MP3');
    await capture('youtube-audio.png');
    await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},session);
    await capture('youtube-audio-dark.png');
    report.result='ui-passed';
  } else {
  if(process.argv.includes('--probe-media')) {
    const offscreen=await until(async()=>(await browser.send('Target.getTargets')).targetInfos.find(target=>target.url===`chrome-extension://${id}/offscreen.html`),'offscreen');
    const offscreenSession=await browser.attach(offscreen.targetId);await browser.send('Runtime.enable',{},offscreenSession);
    const expr=`(async()=>{const {Innertube}=await import('./vendor/youtube/browser.js');const yt=await Innertube.create({generate_session_locally:true,retrieve_player:false,enable_session_cache:false,fetch:(input,init)=>fetch(input,{...init,credentials:'omit'})});const info=await yt.getBasicInfo('aqz-KE-bpKQ',{client:'IOS'});const f=info.streaming_data.adaptive_formats.find(f=>f.itag===160);return f.url;})()`;
    const browserURL=new URL(await browser.eval(expr,offscreenSession));browserURL.searchParams.set('range','0-1023');
    const nodeFetch=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});return {status:r.status,bytes:(await r.arrayBuffer()).byteLength};};
    const browserFetch=url=>browser.eval(`fetch(${JSON.stringify(url)},{credentials:'omit'}).then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength}))`,offscreenSession);
    console.log('BROWSER URL',JSON.stringify({node:await nodeFetch(browserURL),browser:await browserFetch(browserURL.href)}));
    const {Innertube}=await import('../.tmp/browser-youtube-vendor/browser.js');
    const yt=await Innertube.create({generate_session_locally:true,retrieve_player:false,enable_session_cache:false});const info=await yt.getBasicInfo('aqz-KE-bpKQ',{client:'IOS'});
    const nodeURL=new URL(info.streaming_data.adaptive_formats.find(f=>f.itag===160).url);nodeURL.searchParams.set('range','0-1023');
    console.log('NODE URL',JSON.stringify({node:await nodeFetch(nodeURL),browser:await browserFetch(nodeURL.href)}));
    console.log('URL metadata',JSON.stringify({browserIP:browserURL.searchParams.get('ip'),nodeIP:nodeURL.searchParams.get('ip'),browserClient:browserURL.searchParams.get('c'),nodeClient:nodeURL.searchParams.get('c')}));
    for(const itag of [160]) {
      const formats=info.streaming_data.adaptive_formats.filter(f=>f.itag===itag);
      for(const f of formats) for(const start of [0,262144,524288,1048576]) {
        const u=new URL(f.url);u.searchParams.set('range',`${start}-${start+262143}`);
        console.log('TRACK',JSON.stringify({itag,start,node:await nodeFetch(u),browser:await browser.eval(`fetch(${JSON.stringify(u.href)},{credentials:'omit',cache:'no-store'}).then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength}))`,offscreenSession)}));
      }
      const u=new URL(formats[0].url);
      console.log('RANGE HEADER',await browser.eval(`fetch(${JSON.stringify(u.href)},{headers:{Range:'bytes=0-1048575'},credentials:'omit'}).then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength,range:r.headers.get('content-range')}))`,offscreenSession));
    }
    report.result='probe';
  } else {
  await capture('youtube-picker.png');
  const ffmpeg=execFileSync('python',['-c',"import pathlib,shutil; print(pathlib.Path(shutil.which('ffmpeg')).resolve())"],{encoding:'utf8',windowsHide:true}).trim();
  for(const variant of ['video:144','audio:mp3']) {
    await ui(`{const picker=document.querySelector('#video-picker');picker.value=[...picker.options].find(option=>option.value.endsWith(${JSON.stringify(variant)})).value;picker.dispatchEvent(new Event('change'));}`);
    await until(()=>ui("!document.querySelector('#download').disabled"),'download button');
    await ui("document.querySelector('#download').click()");
    const job=await until(async()=>{const jobs=Object.entries(await sw('chrome.storage.session.get(null)')).filter(([key])=>key.startsWith('job:')).map(([,job])=>job).sort((a,b)=>b.createdAt-a.createdAt);const job=jobs[0];if(job?.state==='failed'){const error=new Error(job.error);error.fatal=true;throw error;}return job?.state==='complete'&&job.filename.endsWith(variant==='audio:mp3'?'.mp3':'.mp4')&&job;},`complete ${variant}`,240000);
    const [download]=await sw(`chrome.downloads.search({id:${job.downloadId}})`);
    assert.ok(path.resolve(download.filename).startsWith(path.join(run,'downloads')+path.sep));
    const probe=JSON.parse(execFileSync(path.join(path.dirname(ffmpeg),'ffprobe.exe'),['-v','error','-count_packets','-show_entries','stream=codec_name,codec_type,width,height,duration,nb_read_packets:format=duration','-of','json',download.filename],{windowsHide:true,encoding:'utf8'}));
    const duration=Number(probe.format.duration);assert.ok(Math.abs(duration-634.6)<1.5,`full duration: ${duration}`);
    if(variant==='audio:mp3'){assert.ok(probe.streams.some(s=>s.codec_name==='mp3'));assert.ok(!probe.streams.some(s=>s.codec_type==='video'));}
    else {assert.ok(probe.streams.some(s=>s.height===144));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));}
    assert.ok(probe.streams.every(s=>Number(s.nb_read_packets)>5000));
    execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-xerror','-i',download.filename,'-f','null','-'],{windowsHide:true,stdio:'pipe'});
    pass(`Full public YouTube ${variant} saved entirely inside Chrome`,{file:download.filename,probe,sha256:createHash('sha256').update(await readFile(download.filename)).digest('hex')});
    await capture(variant==='audio:mp3'?'youtube-mp3-complete.png':'youtube-video-complete.png');
    await until(()=>sw("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(async()=>{return true})"),'release');
    await pause(300);
  }
  pass('Manifest has no nativeMessaging permission and test installed no native host');
  report.result='passed';
  }
  }
}catch(error){report.result='failed';report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{
  if(browser){await browser.send('Browser.close').catch(()=>{});browser.socket.close();}
  if(proc&&proc.exitCode===null)proc.kill();await log?.close();report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'.tmp','latest-chrome-youtube-report.json'),JSON.stringify(report,null,2));console.log(`Report: ${path.join(root,'.tmp','latest-chrome-youtube-report.json')}`);
  await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));
}
