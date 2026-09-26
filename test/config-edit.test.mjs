import test from 'node:test';
import assert from 'node:assert/strict';
import {enableText,disableText} from '../src/config-edit.mjs';
const source='model_provider = "openai-http"\nmodel = "gpt-5.6-sol"\nservice_tier = "priority"\n\n[model_providers.openai-http]\nrequires_openai_auth = true\n';
test('enable and rollback restore exact original config',()=>{
  const enabled=enableText(source);assert.match(enabled.text,/model = "jev-router"/);
  assert.equal(disableText(enabled.text,enabled.manifest),source);
});
test('rollback preserves unrelated edits made after installation',()=>{
  const enabled=enableText(source);
  const edited=enabled.text.replace('service_tier = "priority"','service_tier = "default"')+'\n[projects.example]\ntrust_level = "trusted"\n';
  assert.equal(disableText(edited,enabled.manifest),source.replace('service_tier = "priority"','service_tier = "default"')+'\n[projects.example]\ntrust_level = "trusted"\n');
});
test('rollback refuses conflicting changes in owned settings',()=>{
  const enabled=enableText(source);
  assert.throws(()=>disableText(enabled.text.replace('model = "jev-router"','model = "gpt-6-astra"'),enabled.manifest),/changed/);
  assert.throws(()=>disableText(enabled.text.replace('43127','12345'),enabled.manifest),/changed/);
  assert.throws(()=>enableText(enabled.text),/already exists/);
});
test('missing root keys are inserted and removed without touching table model fields',()=>{
  const before='[profiles.example]\nmodel = "test"\n';
  const enabled=enableText(before);assert.equal(disableText(enabled.text,enabled.manifest),before);
});
test('managed provider always requires ChatGPT subscription auth',()=>{
  const subscription=enableText(source);
  assert.match(subscription.text,/\[model_providers\.jev-desktop\]\nname = "Jev Router Desktop"\nbase_url = "http:\/\/127\.0\.0\.1:43127"\nwire_api = "responses"\nrequires_openai_auth = true\n/);
  assert.equal(disableText(subscription.text,subscription.manifest),source);
});
