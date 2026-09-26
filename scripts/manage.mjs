import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { enableText, disableText, sha } from '../src/config-edit.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const data=join(homedir(),'Library','Application Support','jev-router-desktop');
const config=join(homedir(),'.codex','config.toml');
const label='local.jev-router.desktop';
const plist=join(homedir(),'Library','LaunchAgents',label+'.plist');
const target=`gui/${process.getuid()}/${label}`;
const manifestPath=join(data,'installation.json');
const envPath=join(homedir(),'.jev-router.env');
const command=process.argv[2]??'status';
const port=43127;
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const atomic=(file,value,mode=0o600)=>{
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,value,{mode});renameSync(tmp,file);chmodSync(file,mode);
};
const launch=(...args)=>execFileSync('/bin/launchctl',args,{stdio:'pipe'}).toString();
const envValue=key=>{
  if(!existsSync(envPath))return null;
  const match=readFileSync(envPath,'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`,'m'));
  return match?match[1].replace(/^(['"])(.*)\1$/,'$2'):null;
};
const envSet=(key,value)=>{
  const lines=existsSync(envPath)?readFileSync(envPath,'utf8').split(/\r?\n/):[];
  const kept=lines.filter(line=>line.trim()&&!new RegExp(`^\\s*${key}\\s*=`).test(line));
  atomic(envPath,`${[...kept,`${key}=${value}`].join('\n')}\n`,0o600);
};
const health=async()=>{
  const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(2000)});
  const value=await response.json();
  if(!response.ok||value.version!=='0.1.0'||!value.ok)throw new Error('Unexpected service on configured port');
  return value;
};
const waitHealth=async()=>{
  for(let i=0;i<25;i++){
    try{return await health();}catch{await new Promise(resolve=>setTimeout(resolve,200));}
  }
  throw new Error('Service did not come back after restart; run status to inspect.');
};

try {
  if(command==='status') {
    const status=await health();
    const decisions=await(await fetch(`http://127.0.0.1:${port}/status`)).json();
    console.log(JSON.stringify({service:status,providerEnabled:/^model_provider\s*=\s*"jev-desktop"/m.test(readFileSync(config,'utf8')),lastDecisions:decisions.recent.slice(-8)},null,2));
  } else if(command==='install-service') {
    if(root.startsWith('/private/tmp/'))throw new Error('Deploy project to its permanent path before installing LaunchAgent');
    mkdirSync(data,{recursive:true,mode:0o700});
    const content=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(join(root,'scripts','start.sh'))}</string></array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict><key>JEV_NODE_BIN</key><string>${xml(process.execPath)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
    if(existsSync(plist)&&readFileSync(plist,'utf8')!==content)throw new Error('Existing LaunchAgent differs; refusing overwrite');
    atomic(plist,content);
    execFileSync('/usr/bin/plutil',['-lint',plist],{stdio:'inherit'});
    launch('enable',target);
    let loaded=false;try{launch('print',target);loaded=true;}catch{}
    if(!loaded)launch('bootstrap',`gui/${process.getuid()}`,plist);
    console.log(JSON.stringify({installed:plist,service:target}));
  } else if(command==='enable') {
    await health();
    const original=readFileSync(config,'utf8');
    if(existsSync(manifestPath)){
      const saved=JSON.parse(readFileSync(manifestPath,'utf8'));
      if(original.includes(saved.block)&&/^model_provider\s*=\s*"jev-desktop"/m.test(original)){console.log('Already enabled');process.exit(0);}
      if(!saved.disabledAt && original.includes(saved.block))throw new Error('Unresolved previous installation manifest');
      atomic(join(data,`installation-${Date.now()}.json`),JSON.stringify(saved,null,2));
    }
    const next=enableText(original,port);
    atomic(manifestPath,JSON.stringify(next.manifest,null,2));
    if(sha(readFileSync(config,'utf8'))!==sha(original))throw new Error('Config changed concurrently; retry after inspection');
    atomic(config,next.text,statSync(config).mode&0o777);
    console.log(JSON.stringify({enabled:true,config,changedKeys:['model_provider','model'],rollback:manifestPath}));
  } else if(command==='disable') {
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const original=readFileSync(config,'utf8');
    if(manifest.disabledAt&&!original.includes(manifest.block)){console.log('Already restored');process.exit(0);}
    const next=disableText(original,manifest);
    if(sha(readFileSync(config,'utf8'))!==sha(original))throw new Error('Config changed concurrently');
    atomic(config,next,statSync(config).mode&0o777);
    atomic(manifestPath,JSON.stringify({...manifest,disabledAt:new Date().toISOString(),restoredHash:sha(next)},null,2));
    console.log('Original provider/model restored; existing unrelated edits preserved. Restart the desktop app before stopping the service.');
  } else if(command==='mode') {
    const requested=process.argv[3];
    const configured=()=>envValue('JEV_DESKTOP_MODE')??'active';
    if(!requested) {
      const status=await health();
      console.log(JSON.stringify({configured:configured(),running:status.mode,shadowBaseline:status.shadowBaseline,env:envPath},null,2));
    } else {
      if(!['active','shadow'].includes(requested))throw new Error('Mode must be active or shadow');
      const baseline=process.argv[4];
      await health();
      envSet('JEV_DESKTOP_MODE',requested);
      if(baseline)envSet('JEV_DESKTOP_BASELINE',baseline);
      launch('kickstart','-k',target);
      const status=await waitHealth();
      console.log(JSON.stringify({requested,configured:configured(),running:status.mode,shadowBaseline:status.shadowBaseline,env:envPath},null,2));
    }
  } else if(command==='restart') {
    launch('kickstart','-k',target);console.log('Restart requested; re-run status to verify.');
  } else if(command==='stop') {
    if(/^model_provider\s*=\s*"jev-desktop"/m.test(readFileSync(config,'utf8')))throw new Error('Restore the provider and restart the desktop app before stopping its proxy');
    launch('disable',target);
    launch('bootout',target);console.log('LaunchAgent unloaded and future login startup disabled. Plist and state retained; install-service re-enables it.');
  } else throw new Error('Commands: status, mode [active|shadow] [baseline-model], install-service, enable, disable, restart, stop');
} catch(error) { console.error(error.message);process.exitCode=1; }
