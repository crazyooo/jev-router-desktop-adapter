import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelCatalog, modelCatalogText } from '../src/model-catalog.mjs';

const cache=JSON.stringify({identity:'private',models:[
  {slug:'gpt-5.6-sol',display_name:'GPT-5.6-Sol',description:'Strong',visibility:'list',supported_in_api:true,priority:4},
  {slug:'gpt-5.6-terra',display_name:'GPT-5.6-Terra',visibility:'list',supported_in_api:true,priority:7},
  {slug:'future-hidden',visibility:'hide',supported_in_api:true},
  {slug:'legacy',visibility:'list',supported_in_api:false},
]});

test('catalog places Jev first and keeps usable cached models',()=>{
  const catalog=buildModelCatalog(cache);
  assert.deepEqual(catalog.models.map(model=>model.slug),['jev-router','gpt-5.6-sol','gpt-5.6-terra']);
  assert.equal(catalog.models[0].display_name,'Jev Router');
  assert.equal(catalog.identity,undefined);
});

test('catalog can match the models available to the signed-in account',()=>{
  const catalog=buildModelCatalog(cache,{allowedModels:['gpt-5.6-terra']});
  assert.deepEqual(catalog.models.map(model=>model.slug),['jev-router','gpt-5.6-terra']);
  assert.throws(()=>buildModelCatalog(cache,{allowedModels:['missing']}),/missing/);
});

test('catalog text is stable JSON with a trailing newline',()=>{
  const text=modelCatalogText(cache);
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).models[0].slug,'jev-router');
});
