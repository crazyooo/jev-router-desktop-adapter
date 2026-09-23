import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderTable, resolveBackend, rootProvider, fallbackCatalog } from '../src/backend.mjs';

const config = `model_provider = "custom"
model = "gpt-5.6-luna"

[model_providers.custom]
name = "mirror"
base_url = "https://mirror.example/api/codex"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "SECRET_TEST_TOKEN"
`;

test('custom backend inherits URL and token without exposing them in managed config', () => {
  assert.equal(rootProvider(config), 'custom');
  assert.equal(parseProviderTable(config, 'custom').wire_api, 'responses');
  const backend = resolveBackend({ configText: config });
  assert.deepEqual(backend, {
    name: 'custom', baseUrl: 'https://mirror.example/api/codex', token: 'SECRET_TEST_TOKEN', subscription: false,
  });
});

test('managed provider keeps using the available custom backend table after enable', () => {
  const managed = config.replace('model_provider = "custom"', 'model_provider = "jev-desktop"');
  const manifestText=JSON.stringify({before:{model_provider:'model_provider = "custom"'}});
  assert.equal(resolveBackend({ configText: managed, manifestText }).name, 'custom');
});

test('managed provider follows the recorded original provider even when other tables exist', () => {
  const managed = config.replace('model_provider = "custom"', 'model_provider = "jev-desktop"')+
    '\n[model_providers.openai-http]\nrequires_openai_auth = true\n';
  const manifestText=JSON.stringify({before:{model_provider:'model_provider = "openai-http"'}});
  assert.equal(resolveBackend({ configText: managed, manifestText }).name, 'openai-http');
});

test('official provider remains subscription-authenticated', () => {
  const official = 'model_provider = "openai-http"\n[model_providers.openai-http]\nrequires_openai_auth = true\n';
  assert.equal(resolveBackend({ configText: official }).subscription, true);
});

test('custom providers have a conservative local model catalog fallback', () => {
  const models=fallbackCatalog().models;
  assert.deepEqual(models.map(x=>x.slug),['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5']);
  assert.equal(models.find(x=>x.slug==='gpt-5.5').use_responses_lite,false);
});

test('the fallback catalog can be pinned to the models a backend really serves', () => {
  const pinned=fallbackCatalog('gpt-5.6-sol, gpt-5.6-terra ,gpt-5.5').models;
  assert.deepEqual(pinned.map(x=>x.slug),['gpt-5.6-sol','gpt-5.6-terra','gpt-5.5']);
  assert.equal(pinned.find(x=>x.slug==='gpt-5.5').use_responses_lite,false);
  assert.equal(pinned.find(x=>x.slug==='gpt-5.6-sol').use_responses_lite,true);
  assert.equal(fallbackCatalog('   ').models.length,5);
});
