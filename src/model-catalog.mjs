import { withAutoModel, AUTO } from './routing.mjs';

export function buildModelCatalog(cacheText,{allowedModels}={}) {
  let source;
  try { source=JSON.parse(cacheText); } catch { throw new Error('Codex model cache is not valid JSON'); }
  if(!Array.isArray(source.models)||!source.models.length)throw new Error('Codex model cache contains no models');
  const allowed=allowedModels?.length?new Set(allowedModels):null;
  const models=source.models.filter(model=>model.slug!==AUTO&&model.visibility!=='hide'&&model.supported_in_api!==false)
    .filter(model=>!allowed||allowed.has(model.slug));
  if(allowed){
    const found=new Set(models.map(model=>model.slug));
    const missing=[...allowed].filter(slug=>!found.has(slug));
    if(missing.length)throw new Error(`Requested models are missing from Codex cache: ${missing.join(', ')}`);
  }
  return withAutoModel({models});
}

export function modelCatalogText(cacheText,options) {
  return `${JSON.stringify(buildModelCatalog(cacheText,options),null,2)}\n`;
}
