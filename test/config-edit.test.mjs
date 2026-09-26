import test from 'node:test';
import assert from 'node:assert/strict';
import {enableText,disableText,migrateLegacyTriggerText} from '../src/config-edit.mjs';
const source='model_provider = "openai-http"\nmodel = "gpt-5.6-sol"\nservice_tier = "priority"\n\n[model_providers.openai-http]\nrequires_openai_auth = true\n';
const options={catalogPath:'/Users/example/Library/Application Support/jev-router-desktop/models.json'};
test('enable and rollback restore exact original config',()=>{
  const enabled=enableText(source,43127,options);assert.match(enabled.text,/model = "gpt-reserve"/);
  assert.match(enabled.text,/^model_catalog_json = "\/Users\/example\/Library\/Application Support\/jev-router-desktop\/models.json"$/m);
  assert.equal(disableText(enabled.text,enabled.manifest),source);
});
test('rollback preserves unrelated edits made after installation',()=>{
  const enabled=enableText(source,43127,options);
  const edited=enabled.text.replace('service_tier = "priority"','service_tier = "default"')+'\n[projects.example]\ntrust_level = "trusted"\n';
  assert.equal(disableText(edited,enabled.manifest),source.replace('service_tier = "priority"','service_tier = "default"')+'\n[projects.example]\ntrust_level = "trusted"\n');
});
test('rollback refuses conflicting changes in owned settings',()=>{
  const enabled=enableText(source,43127,options);
  assert.throws(()=>disableText(enabled.text.replace('model = "gpt-reserve"','model = "gpt-6-astra"'),enabled.manifest),/changed/);
  assert.throws(()=>disableText(enabled.text.replace('43127','12345'),enabled.manifest),/changed/);
  assert.throws(()=>enableText(enabled.text,43127,options),/already exists/);
});
test('missing root keys are inserted and removed without touching table model fields',()=>{
  const before='[profiles.example]\nmodel = "test"\n';
  const enabled=enableText(before,43127,options);assert.equal(disableText(enabled.text,enabled.manifest),before);
});
test('managed provider always requires ChatGPT subscription auth',()=>{
  const subscription=enableText(source,43127,options);
  assert.match(subscription.text,/\[model_providers\.jev-desktop\]\nname = "Jev Router Desktop"\nbase_url = "http:\/\/127\.0\.0\.1:43127"\nwire_api = "responses"\nrequires_openai_auth = true\n/);
  assert.equal(disableText(subscription.text,subscription.manifest),source);
});
test('legacy version 1 manifests still roll back',()=>{
  const enabled=enableText(source,43127,options);
  const legacy={...enabled.manifest,version:1,before:{model_provider:enabled.manifest.before.model_provider,model:enabled.manifest.before.model},after:{model_provider:enabled.manifest.after.model_provider,model:enabled.manifest.after.model}};
  const withoutCatalog=enabled.text.replace(/^model_catalog_json = .*\n/m,'');
  assert.equal(disableText(withoutCatalog,legacy),source);
});
test('legacy custom trigger migrates to the recognized ChatGPT carrier',()=>{
  const legacyText='model_provider = "jev-desktop"\nmodel = "jev-router"\n';
  const legacy={version:2,before:{model:null},after:{model:'model = "jev-router"'},block:'unused'};
  const migrated=migrateLegacyTriggerText(legacyText,legacy);
  assert.match(migrated.text,/^model = "gpt-reserve"$/m);
  assert.equal(migrated.manifest.after.model,'model = "gpt-reserve"');
  assert.equal(migrated.manifest.version,3);
});
