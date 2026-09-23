import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Run only while the original provider is selected and no proxy requests are in flight.
const config=readFileSync(join(homedir(),'.codex','config.toml'),'utf8');
assert.ok(!/^model_provider\s*=\s*"jev-desktop"/m.test(config),'restore provider before crash testing');
const endpoint='http://127.0.0.1:43127/healthz';
const before=await(await fetch(endpoint)).json();
const stateFile=join(homedir(),'Library','Application Support','jev-router-desktop','state.json');
const hash=()=>createHash('sha256').update(readFileSync(stateFile)).digest('hex');
const stateBefore=hash();
execFileSync('/bin/launchctl',['kill','SIGKILL',`gui/${process.getuid()}/local.jev-router.desktop`]);
let after;const end=Date.now()+30000;
while(Date.now()<end){try{after=await(await fetch(endpoint,{signal:AbortSignal.timeout(1000)})).json();if(after.pid!==before.pid)break;}catch{}await delay(100);}
assert.ok(after?.ok&&after.pid!==before.pid,'launchd must automatically recover the crashed service');
assert.equal(hash(),stateBefore,'persisted routing decisions must survive unchanged');
console.log(JSON.stringify({check:'automatic_crash_recovery',ok:true,oldPid:before.pid,newPid:after.pid,statePreserved:true}));
