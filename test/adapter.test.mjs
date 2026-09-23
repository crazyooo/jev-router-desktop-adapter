import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Router, identify, withAutoModel, AUTO, jevRequestTimeoutMs } from '../src/routing.mjs';
import { codexTierOf } from '../upstream/src/codex-proxy.mjs';
import { StateStore } from '../src/state.mjs';
import { startServer } from '../src/server.mjs';

const fast = 'gpt-5.6-luna', balanced = 'gpt-5.6-terra', strong = 'gpt-5.6-sol';
const catalog = { models: [fast, balanced, strong].map(slug => ({ slug, visibility: 'list', supported_in_api: true, use_responses_lite: true,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' })) };
const headers = { authorization: 'Bearer TEST_ONLY_TOKEN', 'chatgpt-account-id': 'TEST_ACCOUNT' };
const body = (thread = 'A', turn = '1', prompt = 'Fix a typo') => ({ model: AUTO, prompt_cache_key: thread,
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: turn }) },
  input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] });
const routeFast = async () => ({ choice: fast, confidence: 0.98 });

test('catalog injects exactly one auto model and preserves manual choices', () => {
  const output = withAutoModel(withAutoModel(catalog));
  assert.equal(output.models.filter(x => x.slug === AUTO).length, 1);
  assert.deepEqual(output.models.slice(1), catalog.models);
  assert.equal(catalog.models.length, 3);
});

test('fresh turn routes once; duplicate requests and tool continuation stay pinned', async () => {
  let calls = 0;
  const router = new Router({ store: new StateStore(), route: async () => { calls++; await delay(10); return routeFast(); } });
  const copies = [body(), body(), body()];
  await Promise.all(copies.map(b => router.apply(b, headers, catalog)));
  const continuation = body();
  continuation.input.push({ type: 'function_call_output', call_id: 'test', output: 'ok' });
  await router.apply(continuation, headers, catalog);
  assert.equal(calls, 1);
  assert.equal(continuation.model, fast);
  assert.ok(copies.every(x => x.model === fast));
});

test('three concurrent tasks and two accounts do not share decisions', async () => {
  const router = new Router({ store: new StateStore(), route: async ({ prompt }) => ({ choice: prompt, confidence: 0.99 }) });
  const requests = [body('A','1',fast),body('B','1',balanced),body('C','1',strong)];
  await Promise.all(requests.map(x => router.apply(x, headers, catalog)));
  assert.deepEqual(requests.map(x=>x.model), [fast, balanced, strong]);
  const other = body('A','1',strong);
  await router.apply(other, { ...headers, 'chatgpt-account-id': 'OTHER_ACCOUNT' }, catalog);
  assert.equal(other.model, strong);
});

test('next user turn is re-evaluated, including identical text with new turn id', async () => {
  let calls = 0;
  const router = new Router({ store: new StateStore(), route: async () => ({ choice: ++calls === 1 ? fast : balanced, confidence: 0.99 }) });
  const a = body(), b = body('A','2');
  await router.apply(a,headers,catalog); await router.apply(b,headers,catalog);
  assert.equal(a.model,fast); assert.equal(b.model,balanced); assert.equal(calls,2);
});

test('manual choice passes unchanged and explicit override avoids Jev', async () => {
  let calls = 0;
  const router = new Router({ store: new StateStore(), route: async()=>{calls++;return routeFast();} });
  const manual = { ...body(), model: 'gpt-6-astra' };
  await router.apply(manual,headers,null);
  assert.equal(manual.model,'gpt-6-astra');
  const override = body('B','1','use terra to fix this typo');
  await router.apply(override,headers,catalog);
  assert.equal(override.model,balanced); assert.equal(calls,0);
});

test('Jev failure and invalid confidence keep last model; first failure uses strong', async () => {
  let result = await routeFast();
  const router = new Router({store:new StateStore(),route:async()=>result});
  await router.apply(body(),headers,catalog);
  result = {choice:strong,confidence:NaN};
  const second=body('A','2'); await router.apply(second,headers,catalog); assert.equal(second.model,fast);
  result=null;
  const fresh=body('B','1'); await router.apply(fresh,headers,catalog); assert.equal(fresh.model,strong);
});

test('deadline bounds a hung route and cancels it', async () => {
  let aborted=false;
  const router=new Router({store:new StateStore(),deadlineMs:20,route:({signal})=>new Promise(()=>signal.addEventListener('abort',()=>{aborted=true;}))});
  const started=Date.now(), b=body(); await router.apply(b,headers,catalog);
  assert.equal(b.model,strong); assert.equal(aborted,true); assert.ok(Date.now()-started<1000);
});

test('persisted decisions survive restart; only metadata is saved', async () => {
  const dir=mkdtempSync(join(tmpdir(),'jev-state-test-')),file=join(dir,'state.json');
  const router=new Router({store:new StateStore(file),route:routeFast});
  await router.apply(body('A','1','PRIVATE_PROMPT_MUST_NOT_BE_STORED'),headers,catalog);
  const restored=new Router({store:new StateStore(file),route:async()=>{throw new Error('must not call');}});
  const b=body(); b.input.push({type:'custom_tool_call_output',output:'PRIVATE_TOOL_RESULT'});
  await restored.apply(b,headers,catalog); assert.equal(b.model,fast);
  const stored=readFileSync(file,'utf8');
  assert.ok(!stored.includes('PRIVATE_')); assert.ok(!stored.includes('TEST_ONLY_TOKEN'));
  assert.equal(statSync(file).mode & 0o777,0o600);
  writeFileSync(file,'invalid'); assert.throws(()=>new StateStore(file),/unreadable/);
});

test('missing task identity and image-only input never get guessed into cheap tiers', async () => {
  let calls=0; const router=new Router({store:new StateStore(),route:async()=>{calls++;return routeFast();}});
  const a=body(); delete a.client_metadata;delete a.prompt_cache_key;
  await router.apply(a,headers,catalog);assert.equal(a.model,strong);
  const b=body('B');b.input[0].content.push({type:'input_image',image_url:'test'});
  await router.apply(b,headers,catalog);assert.equal(b.model,strong);assert.equal(calls,0);
});

test('state cleanup bounds retention and size',()=>{
  const store=new StateStore(undefined,{maxThreads:2});
  for(let i=0;i<5;i++)store.save(String(i),'1',{model:fast,reason:'test'});
  assert.equal(Object.keys(store.data.threads).length,2);
  store.data.threads.old={at:0,turns:{}};store.prune();assert.ok(!store.data.threads.old);
});

test('failed persistence cannot leave an unpersisted decision cached for a retry',()=>{
  const store=new StateStore();
  store.save('A','1',{model:strong,reason:'test'});
  store.flush=()=>{throw new Error('disk full');};
  assert.throws(()=>store.save('A','2',{model:fast,reason:'test'}),/disk full/);
  assert.equal(store.thread('A').model,strong);assert.equal(store.decision('A','2'),undefined);
});

test('reasoning effort is normalized only when chosen model does not support it',async()=>{
  const router=new Router({store:new StateStore(),route:routeFast});
  const b=body();b.reasoning={effort:'ultra'};
  await router.apply(b,headers,catalog);assert.equal(b.reasoning.effort,'low');
});

test('Responses Lite requests never route to an incompatible legacy model',async()=>{
  const mixed={models:[...catalog.models,{slug:'gpt-5.5',visibility:'list',supported_in_api:true,use_responses_lite:false}]};
  let options;
  const router=new Router({store:new StateStore(),route:async({models})=>{options=models;return {choice:'gpt-5.5',confidence:0.99};}});
  const b=body();b.input.unshift({type:'additional_tools',tools:[]});
  await router.apply(b,headers,mixed);
  assert.ok(!options.some(x=>x.id==='gpt-5.5'));assert.equal(b.model,strong);
  const manual={...body('M'),model:'gpt-5.5'};await router.apply(manual,headers,mixed);assert.equal(manual.model,'gpt-5.5');
});

test('proxy forwards streams and auth, blocks API fallback, and propagates cancellation',async t=>{
  const seen=[],events=[];let cancelled=false;
  const upstream=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/models')){res.end(JSON.stringify(catalog));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const b=JSON.parse(Buffer.concat(chunks));seen.push({b,auth:req.headers.authorization});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    if(b.wait){res.on('close',()=>{cancelled=true;});return;}
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const proxy=await startServer({port:0,upstream:`http://127.0.0.1:${upstream.address().port}`,route:routeFast,event:e=>events.push(e)});
  t.after(async()=>{await proxy.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const base=`http://127.0.0.1:${proxy.port}`;
  const health=await fetch(base+'/healthz');assert.equal(health.status,200);
  const denied=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(body())});assert.equal(denied.status,401);
  const browser=await fetch(base+'/status',{headers:{origin:'https://evil.invalid'}});assert.equal(browser.status,403);
  const invalid=await fetch(base+'/responses',{method:'POST',headers,body:'invalid'});assert.equal(invalid.status,400);
  const models=await(await fetch(base+'/models',{headers})).json();assert.equal(models.models[0].slug,AUTO);
  const response=await fetch(base+'/responses',{method:'POST',headers,body:JSON.stringify(body())});
  assert.match(await response.text(),/response.completed/);assert.equal(seen[0].b.model,fast);assert.equal(seen[0].auth,headers.authorization);
  assert.ok(!JSON.stringify(events).includes('Fix a typo'));assert.ok(!JSON.stringify(events).includes('TEST_ONLY_TOKEN'));
  const abort=new AbortController();
  const streaming=await fetch(base+'/responses',{method:'POST',headers,body:JSON.stringify({...body('C'),wait:true}),signal:abort.signal});
  const reader=streaming.body.getReader();await reader.read();abort.abort();
  for(let i=0;i<30&&!cancelled;i++)await delay(10);
  assert.equal(cancelled,true);
});

test('proxy can route through a custom provider token without subscription account headers',async t=>{
  let seen;
  const upstream=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/models')){seen={auth:req.headers.authorization,account:req.headers['chatgpt-account-id']};res.end(JSON.stringify(catalog));return;}
    for await(const _chunk of req){}
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const backend={name:'custom',baseUrl:`http://127.0.0.1:${upstream.address().port}`,token:'CUSTOM_TEST_TOKEN',subscription:false};
  const proxy=await startServer({port:0,backend,route:routeFast});
  t.after(async()=>{await proxy.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const base=`http://127.0.0.1:${proxy.port}`;
  const models=await fetch(base+'/models');
  assert.equal(models.status,200);assert.equal((await models.json()).models[0].slug,AUTO);
  assert.deepEqual(seen,{auth:'Bearer CUSTOM_TEST_TOKEN',account:undefined});
  const response=await fetch(base+'/responses',{method:'POST',body:JSON.stringify(body())});
  assert.equal(response.status,200);assert.match(await response.text(),/response.completed/);
});

test('Jev request timeout stays inside the turn deadline and clears real latency',()=>{
  assert.equal(jevRequestTimeoutMs(8000),6000);assert.equal(jevRequestTimeoutMs(3000),1000);assert.equal(jevRequestTimeoutMs(500),1000);
  // Measured on this machine: a decision takes ~2.5-3.0s, so the old 1500ms SDK limit failed every call.
  assert.ok(jevRequestTimeoutMs(8000)>3000);
});

test('the fast tier can be repointed to a model the backend actually serves',()=>{
  const previous=process.env.JEV_CODEX_FAST_MODEL;
  try{
    assert.equal(codexTierOf('gpt-5.6-luna'),'haiku');
    process.env.JEV_CODEX_FAST_MODEL='gpt-5.5';
    // A relay that serves 5.5 but not luna: repointing keeps a cheap tier in the candidate set
    // instead of routing to a model the backend rejects with model_not_found.
    assert.equal(codexTierOf('gpt-5.5'),'haiku');
  } finally {
    if(previous===undefined)delete process.env.JEV_CODEX_FAST_MODEL;else process.env.JEV_CODEX_FAST_MODEL=previous;
  }
});

test('active mode records no shadow fields',async()=>{
  const store=new StateStore();
  const router=new Router({store,route:routeFast});
  const b=body();await router.apply(b,headers,catalog);
  const record=store.data.recent.at(-1);
  assert.equal(b.model,fast);assert.equal(record.mode,undefined);assert.equal(record.wouldBe,undefined);
});

test('shadow mode executes the fixed baseline and records the would-be route',async()=>{
  const store=new StateStore();
  const router=new Router({store,route:routeFast,mode:'shadow',shadowBaseline:balanced});
  const b=body();await router.apply(b,headers,catalog);
  assert.equal(b.model,balanced);
  const record=store.data.recent.at(-1);
  assert.equal(record.mode,'shadow');assert.equal(record.model,balanced);
  assert.equal(record.wouldBe,fast);assert.equal(record.wouldBeReason,'jev');assert.equal(record.wouldBeConfidence,0.98);
  assert.equal(record.reason,'shadow/jev');
});

test('shadow mode keeps the reported current model honest for the next turn',async()=>{
  const seen=[];const store=new StateStore();
  const router=new Router({store,mode:'shadow',shadowBaseline:balanced,route:async({current})=>{seen.push(current);return routeFast();}});
  const a=body('A','1');await router.apply(a,headers,catalog);assert.equal(a.model,balanced);
  const b=body('A','2');await router.apply(b,headers,catalog);
  assert.deepEqual(seen,[strong,balanced]);assert.equal(b.model,balanced);
});

test('shadow mode falls back to the default model when the baseline is unavailable',async()=>{
  const store=new StateStore();
  const router=new Router({store,mode:'shadow',shadowBaseline:'gpt-9-missing',route:routeFast});
  const b=body();await router.apply(b,headers,catalog);
  assert.equal(b.model,strong);
  const record=store.data.recent.at(-1);
  assert.equal(record.model,strong);assert.equal(record.wouldBe,fast);assert.equal(record.mode,'shadow');
});

test('shadow mode never overrides an explicit manual selection',async()=>{
  let calls=0;const store=new StateStore();
  const router=new Router({store,mode:'shadow',shadowBaseline:balanced,route:async()=>{calls++;return routeFast();}});
  const manual={...body(),model:'gpt-6-astra'};await router.apply(manual,headers,null);
  assert.equal(manual.model,'gpt-6-astra');assert.equal(calls,0);
  const record=store.data.recent.at(-1);
  assert.equal(record.reason,'manual');assert.equal(record.wouldBe,undefined);
});

test('shadow mode is observable end to end: healthz reports it and the baseline is what runs',async t=>{
  const seen=[];
  const upstream=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/models')){res.end(JSON.stringify(catalog));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks)).model);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const proxy=await startServer({port:0,upstream:`http://127.0.0.1:${upstream.address().port}`,route:routeFast,mode:'shadow',shadowBaseline:balanced});
  t.after(async()=>{await proxy.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  const base=`http://127.0.0.1:${proxy.port}`;
  const health=await(await fetch(base+'/healthz')).json();
  assert.equal(health.mode,'shadow');assert.equal(health.shadowBaseline,balanced);
  await fetch(base+'/responses',{method:'POST',headers,body:JSON.stringify(body())});
  assert.deepEqual(seen,[balanced]);
  const status=await(await fetch(base+'/status')).json();
  assert.equal(status.recent.at(-1).wouldBe,fast);assert.equal(status.recent.at(-1).model,balanced);
});
