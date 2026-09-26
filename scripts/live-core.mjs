import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = process.env.JEV_TEST_URL ?? 'http://127.0.0.1:43127';
const original = process.argv.includes('--original');
const configured = original || process.argv.includes('--configured');
const args = ['app-server', '--stdio',
  '-c', 'model_provider="jev-desktop"', '-c', 'model="gpt-reserve"',
  '-c', 'model_providers.jev-desktop.name="Jev Router Desktop"',
  '-c', `model_providers.jev-desktop.base_url="${base}"`,
  '-c', 'model_providers.jev-desktop.wire_api="responses"',
  '-c', 'model_providers.jev-desktop.requires_openai_auth=true',
  '-c', 'model_providers.jev-desktop.supports_websockets=false'];
const child = spawn('/Applications/ChatGPT.app/Contents/Resources/codex', configured ? ['app-server','--stdio'] : args, {
  stdio: ['pipe','pipe','pipe'], env: { ...process.env, RUST_LOG: 'error', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' },
});
let id=0, toolCalls=0;
const pending=new Map(), completed=new Map(), texts=new Map(), started=new Set();
let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-3000);});
const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const n=++id;
  const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`RPC timeout: ${method}`));},90000);
  pending.set(n,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  send({id:n,method,params});
});
createInterface({input:child.stdout}).on('line',async line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id!==undefined&&pending.has(message.id)){
    const p=pending.get(message.id);pending.delete(message.id);
    if(message.error)p.reject(new Error(JSON.stringify(message.error)));else p.resolve(message.result);
  }else if(message.method==='item/tool/call'){
    toolCalls++;
    if(message.params.tool!=='test_ping')return send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'Unexpected test tool'}]}});
    if(process.argv.includes('--restart-during-tool') && toolCalls===1){
      try {
        const old=await(await fetch(base+'/healthz')).json();
        execFileSync('/bin/launchctl',['kickstart','-k',`gui/${process.getuid()}/local.jev-router.desktop`]);
        let next;const until=Date.now()+15000;
        while(Date.now()<until){try{next=await(await fetch(base+'/healthz')).json();if(next.pid!==old.pid)break;}catch{}await delay(100);}
        assert.ok(next?.pid && next.pid!==old.pid);
        console.log(JSON.stringify({check:'restart_between_tool_requests',ok:true,oldPid:old.pid,newPid:next.pid}));
      } catch(error){return send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'Restart test failed'}]}});}
    }
    send({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:'PONG'}]}});
  }else if(message.id!==undefined){
    send({id:message.id,error:{code:-32601,message:'Test client does not approve interactive requests'}});
  }else if(message.method==='turn/completed') completed.set(message.params.turn.id,message.params.turn);
  else if(message.method==='item/agentMessage/delta'){
    const key=message.params.turnId;started.add(key);texts.set(key,(texts.get(key)??'')+message.params.delta);
  }
});
child.on('exit',()=>{for(const p of pending.values())p.reject(new Error('Desktop core exited'));pending.clear();});
const waitTurn=async turnId=>{
  const deadline=Date.now()+120000;
  while(!completed.has(turnId)&&Date.now()<deadline)await delay(100);
  assert.ok(completed.has(turnId),'turn must complete');
  const turn=completed.get(turnId);
  assert.equal(turn.status,'completed',JSON.stringify(turn.error??{}));
  return texts.get(turnId)??'';
};
const start=async(tools=false)=>{
  const result=await rpc('thread/start',{ephemeral:true,cwd:'/private/tmp',...(configured?{}:{model:'gpt-reserve',modelProvider:'jev-desktop'}),sandbox:'read-only',approvalPolicy:'never',
    baseInstructions:'You are a test assistant. Follow the user exactly. Never access files, network, or other tasks. Only use test_ping if requested.',
    dynamicTools:tools?[{type:'function',name:'test_ping',description:'A harmless test tool returning PONG.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]:[]});
  if(configured){assert.equal(result.modelProvider,original?'openai-http':'jev-desktop');assert.equal(result.model,original?'gpt-5.6-sol':'gpt-reserve');}
  return result.thread.id;
};
const turn=async(threadId,text,model)=>{
  const result=await rpc('turn/start',{threadId,input:[{type:'text',text,text_elements:[]}],effort:'low',...(model?{model}:{})});
  return {id:result.turn.id,text:await waitTurn(result.turn.id)};
};

try{
  await rpc('initialize',{clientInfo:{name:'jev_desktop_integration_test',version:'0.1.0'},capabilities:{experimentalApi:true}});
  send({method:'initialized',params:{}});
  const models=await rpc('model/list',{includeHidden:false});
  const list=models.data??models.models??[];
  if(!original)assert.ok(list.some(x=>(x.id??x.model)==='gpt-reserve'&&x.displayName==='Jev Router'),'model/list must expose the recognized Jev Router carrier');
  console.log(JSON.stringify({check:'desktop_model_list',models:list.map(x=>x.id??x.model)}));
  const first=await start();
  const a=await turn(first,'Reply exactly LIVE_JEV_OK. Do not call tools.');
  assert.ok(a.text.includes('LIVE_JEV_OK'));console.log(JSON.stringify({check:original?'restored_original_provider_response':'live_auto_response',ok:true,configured}));
  if(process.argv.includes('--full')){
    const b=await start(),c=await start();
    const results=await Promise.all([
      turn(first,'Reply exactly CONCURRENT_A. Do not call tools.'),
      turn(b,'Write a JavaScript function validating that age is an integer between 0 and 120, plus 3 short assertions. Only return code; do not call tools.'),
      turn(c,'Design a multi-tenant authentication migration with zero downtime, token revocation, race-condition handling, staged rollout and rollback. Give your design in at most 120 words. Do not call tools.')
    ]);
    assert.ok(results.every(x=>x.text.length>0));console.log(JSON.stringify({check:'three_parallel_tasks',ok:true}));
    const t=await start(true);
    const tool=await turn(t,'use luna. Call test_ping exactly once, then reply with its result.');
    assert.ok(toolCalls>=1);assert.match(tool.text,/PONG/);console.log(JSON.stringify({check:'tool_loop',ok:true,toolCalls}));
    const continued=await turn(t,'Reply exactly CONTINUED_OK. Do not call tools.');
    assert.match(continued.text,/CONTINUED_OK/);
    const manual=await turn(t,'Reply exactly MANUAL_OK. Do not call tools.','gpt-5.6-sol');
    assert.match(manual.text,/MANUAL_OK/);console.log(JSON.stringify({check:'continuation_and_manual_model',ok:true}));
  }
  if(process.argv.includes('--full')||process.argv.includes('--cancel-only')){
    const cancelThread=await start();
    const cancel=await rpc('turn/start',{threadId:cancelThread,input:[{type:'text',text:'use luna. Write 200 numbered sentences describing different imaginary gardens. Each sentence must be at least 15 words. Do not call tools.',text_elements:[]}],effort:'low'});
    const turnHash=createHash('sha256').update(cancel.turn.id).digest('hex');
    const until=Date.now()+30000;let observed=false;
    while(Date.now()<until){
      const state=await(await fetch(base+'/status')).json();
      if(state.recent.some(x=>x.turn===turnHash)){observed=true;break;}
      if(completed.has(cancel.turn.id))break;
      await delay(25);
    }
    assert.ok(observed,'proxy must receive the request before cancellation');
    assert.ok(!completed.has(cancel.turn.id),'turn must still be running when interrupted');
    await rpc('turn/interrupt',{threadId:cancelThread,turnId:cancel.turn.id});
    const end=Date.now()+15000;while(!completed.has(cancel.turn.id)&&Date.now()<end)await delay(50);
    assert.equal(completed.get(cancel.turn.id)?.status,'interrupted');
    console.log(JSON.stringify({check:'cancel_stream',ok:true}));
  }
  const status=await(await fetch(base+'/status')).json();
  console.log(JSON.stringify({check:'routing_decisions',recent:status.recent.map(({model,reason,ms,identitySource})=>({model,reason,ms,identitySource}))}));
  if(!original)assert.ok(status.recent.some(x=>x.reason==='jev'||x.reason==='jev/no-change'),'live Jev decision required; fallback alone is insufficient');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{child.stdin.end();child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);}
