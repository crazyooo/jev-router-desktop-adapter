import { createHash } from 'node:crypto';
export const BEGIN = '# BEGIN JEV DESKTOP MANAGED PROVIDER';
export const END = '# END JEV DESKTOP MANAGED PROVIDER';
export const sha = text => createHash('sha256').update(text).digest('hex');
const keys = ['model_provider','model'];

function rootLines(text) {
  const lines=text.split('\n');
  const end=lines.findIndex(x=>/^\s*\[/.test(x));
  return {lines,end:end<0?lines.length:end};
}
function getLine(text,key) {
  const {lines,end}=rootLines(text);
  const matches=lines.slice(0,end).filter(x=>new RegExp(`^\\s*${key}\\s*=`).test(x));
  if(matches.length>1)throw new Error(`Ambiguous root key: ${key}`);
  return matches[0]??null;
}
function setLine(text,key,line) {
  const {lines,end}=rootLines(text);
  const i=lines.slice(0,end).findIndex(x=>new RegExp(`^\\s*${key}\\s*=`).test(x));
  if(i>=0){if(line===null)lines.splice(i,1);else lines[i]=line;}
  else if(line!==null)lines.unshift(line);
  return lines.join('\n');
}
export function enableText(text,port=43127) {
  if(text.includes(BEGIN)||/^\s*\[model_providers\.jev-desktop\]/m.test(text))throw new Error('Jev provider already exists; inspect its owner before editing');
  const before=Object.fromEntries(keys.map(k=>[k,getLine(text,k)]));
  const after={model_provider:'model_provider = "jev-desktop"',model:'model = "jev-router"'};
  let changed=text;
  for(const key of keys)changed=setLine(changed,key,after[key]);
  const block=`\n${BEGIN}\n[model_providers.jev-desktop]\nname = "Jev Router Desktop"\nbase_url = "http://127.0.0.1:${port}"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n${END}\n`;
  changed+=block;
  return {text:changed,manifest:{version:1,before,after,block,beforeHash:sha(text),enabledHash:sha(changed),createdAt:new Date().toISOString()}};
}
export function disableText(text,manifest) {
  if(manifest.version!==1)throw new Error('Unsupported rollback manifest');
  if(text.split(manifest.block).length!==2)throw new Error('Managed provider was changed; refusing destructive restore');
  for(const key of keys)if(getLine(text,key)!==manifest.after[key])throw new Error(`${key} changed since enable; inspect before restoring`);
  let changed=text.replace(manifest.block,'');
  for(const key of keys)changed=setLine(changed,key,manifest.before[key]);
  return changed;
}
