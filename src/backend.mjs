import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const DEFAULT_SUBSCRIPTION_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
export const FALLBACK_PROVIDER_MODELS = [
  ['gpt-6-astra', 'Astra'], ['gpt-5.6-sol', 'Sol'], ['gpt-5.6-terra', 'Terra'],
  ['gpt-5.6-luna', 'Luna'], ['gpt-5.5', '5.5'],
];

/**
 * The fallback catalog is a conservative guess used when the backend exposes no readable
 * `/models` (many relays implement `/responses` only). Set `JEV_DESKTOP_FALLBACK_MODELS`
 * to a comma-separated slug list to pin it to what the backend actually serves — a routed
 * model the backend does not have fails the turn with `model_not_found`.
 */
export function fallbackCatalog(spec = process.env.JEV_DESKTOP_FALLBACK_MODELS) {
  const requested = typeof spec === 'string' && spec.trim() ? spec.split(',').map(x => x.trim()).filter(Boolean) : null;
  const entries = requested ? requested.map(slug => [slug, slug]) : FALLBACK_PROVIDER_MODELS;
  return { models: entries.map(([slug, display_name]) => ({ slug, display_name,
    description: `Configured provider model ${display_name}`, visibility: 'list', supported_in_api: true,
    use_responses_lite: slug !== 'gpt-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    default_reasoning_level: 'low' })) };
}

function valueOf(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export function parseProviderTable(text, provider) {
  const result = {};
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*$/);
    if (section) { active = section[1] === provider; continue; }
    if (!active || /^\s*\[/.test(line)) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (match) result[match[1]] = valueOf(match[2]);
  }
  return result;
}

export function rootProvider(text) {
  return text.match(/^\s*model_provider\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
}

function providerFromManifest(manifestPath, manifestText) {
  try {
    const raw = manifestText ?? (existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '');
    return raw ? rootProvider(JSON.parse(raw).before?.model_provider ?? '') : null;
  } catch { return null; }
}

export function resolveBackend({ configPath = `${homedir()}/.codex/config.toml`, manifestPath = `${homedir()}/Library/Application Support/jev-router-desktop/installation.json`,
  providerName, configText, manifestText } = {}) {
  const text = configText ?? (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
  const root = rootProvider(text);
  const selected = providerName ?? (root === 'jev-desktop'
    ? (providerFromManifest(manifestPath, manifestText) ?? (parseProviderTable(text, 'custom').base_url ? 'custom' : 'openai-http'))
    : root);
  const provider = selected ? parseProviderTable(text, selected) : {};
  const baseUrl = typeof provider.base_url === 'string' && provider.base_url
    ? provider.base_url.replace(/\/+$/, '') : DEFAULT_SUBSCRIPTION_UPSTREAM;
  const token = typeof provider.experimental_bearer_token === 'string' ? provider.experimental_bearer_token : null;
  const subscription = selected === 'openai-http' || baseUrl.includes('chatgpt.com/backend-api/codex');
  return { name: selected ?? 'openai-http', baseUrl, token, subscription };
}
