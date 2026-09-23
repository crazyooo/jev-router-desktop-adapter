import { createHash } from 'node:crypto';
import { TypeSafeClient } from '../upstream/node_modules/@typesafe-ai/sdk/dist/index.mjs';
import { QUESTIONS, questionForModels, shouldUseExactModel, availableTiers } from '../upstream/src/config.mjs';
import { decide, detectOverride } from '../upstream/src/policy.mjs';
import { codexTierOf, applyCodexTier } from '../upstream/src/codex-proxy.mjs';

export const AUTO = 'jev-router';
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(x => ['text', 'input_text'].includes(x.type)).map(x => x.text).join('\n');

export function identify(body, headers = {}) {
  let meta = {};
  try { meta = JSON.parse(body.client_metadata?.['x-codex-turn-metadata'] ?? headers['x-codex-turn-metadata'] ?? '{}'); } catch {}
  const thread = meta.thread_id ?? meta.session_id ?? headers.session_id ?? headers['x-codex-thread-id'] ?? body.prompt_cache_key;
  const account = headers['chatgpt-account-id'] ?? headers.authorization ?? 'local-provider';
  const key = thread ? digest(`${account}|${thread}|${body.prompt_cache_key ?? ''}`) : null;
  const input = Array.isArray(body.input) ? body.input : [];
  const index = input.findLastIndex(x => x.role === 'user');
  const user = index >= 0 ? input[index] : null;
  const continued = input.slice(index + 1).some(x => ['function_call_output', 'custom_tool_call_output'].includes(x.type));
  const text = user ? textOf(user.content).replace(/<(?:system[-_]reminder|current_datetime|environment_context)>[\s\S]*?<\/(?:system[-_]reminder|current_datetime|environment_context)>/gi, '').trim() : '';
  const auxiliary = /^Generate a concise, single-line task title\b/i.test(text) || text.includes('<jev-explain>');
  const hasImages = user && Array.isArray(user.content) && user.content.some(x => ['input_image', 'image'].includes(x.type));
  const rawTurn = meta.turn_id ?? headers['x-codex-turn-id'];
  const turn = rawTurn ? digest(rawTurn) : digest(JSON.stringify(input.slice(0, index + 1)));
  return { key, turn, prompt: continued || auxiliary || hasImages ? null : text || null, continued, hasImages,
    identitySource: meta.thread_id ? 'thread_metadata' : meta.session_id ? 'session_metadata' : headers.session_id ? 'session_header' : body.prompt_cache_key ? 'cache_key' : 'missing' };
}

export function candidatesFrom(catalog, responsesLite) {
  return (catalog?.models ?? []).filter(x => x.slug !== AUTO && x.visibility !== 'hide' && x.supported_in_api !== false)
    .filter(x => responsesLite === undefined || Boolean(x.use_responses_lite) === responsesLite)
    .map(x => ({ id: x.slug, tier: codexTierOf(x.slug), description: `${x.display_name ?? x.slug}: ${x.description ?? ''}` }))
    .filter(x => x.tier && availableTiers().includes(x.tier));
}

export function withAutoModel(catalog) {
  const copy = structuredClone(catalog);
  copy.models = copy.models.filter(x => x.slug !== AUTO);
  if (!candidatesFrom(copy).length) throw new Error('No routable models in authenticated catalog');
  const template = copy.models.find(x => x.slug === 'gpt-5.6-sol') ?? copy.models.find(x => x.visibility === 'list');
  copy.models.unshift({ ...template, slug: AUTO, display_name: 'Jev Router',
    description: '每轮自动选模型 · 手动选择具体模型可暂停路由', visibility: 'list', supported_in_api: true, priority: 0, upgrade: null });
  return copy;
}

/**
 * The SDK gives up on a single Jev request before the outer turn deadline, so a slow
 * network produces a clean fallback instead of racing the deadline. Measured latency on
 * this machine is ~2.5–3.0 s per decision, so the previous 1500 ms SDK limit failed every
 * call and routing silently degraded to the previous model.
 */
export const jevRequestTimeoutMs = deadlineMs => Math.max(1000, deadlineMs - 2000);

export function createJevRoute(apiKey, deadlineMs = 8000, requestTimeoutMs = jevRequestTimeoutMs(deadlineMs)) {
  let client;
  return async ({ prompt, current, contextTokens, models, signal }) => {
    if (!apiKey) return null;
    client ??= new TypeSafeClient({ apiKey, timeout: requestTimeoutMs, retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 400 }, logLevel: 'off' });
    try {
      const response = await client.systemOne({
        state: { request: prompt, session: { current_model: current, context_tokens: contextTokens }, environment: { available_models: models.map(x => x.id) } },
        questions: { ...QUESTIONS, model: questionForModels(models) },
      }, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(deadlineMs)]) });
      const answer = response.answers?.model;
      return answer && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1 ? answer : null;
    } catch { return null; }
  };
}

export class Router {
  constructor({ store, route, defaultModel = 'gpt-5.6-sol', deadlineMs = 8000, mode = 'active', shadowBaseline = null }) {
    Object.assign(this, { store, route, defaultModel, deadlineMs, shadowBaseline,
      mode: mode === 'shadow' ? 'shadow' : 'active' });
    this.locks = new Map();
  }
  /**
   * Shadow mode asks Jev for a decision exactly as active mode does, but executes the
   * fixed baseline instead of the chosen model. The would-be route is recorded next to
   * the executed one, and the executed model stays in `model` so the session and the
   * next turn's `current_model` reflect what actually ran, never what Jev proposed.
   */
  shadowed(decision, choices, current) {
    if (this.mode !== 'shadow' || decision.reason === 'manual') return decision;
    const baseline = choices.find(x => x.id === this.shadowBaseline)?.id
      ?? choices.find(x => x.id === this.defaultModel)?.id ?? current;
    return { ...decision, mode: 'shadow', model: baseline, wouldBe: decision.model,
      wouldBeReason: decision.reason, wouldBeConfidence: decision.confidence ?? null,
      reason: `shadow/${decision.reason}` };
  }
  async apply(body, headers, catalog, signal) {
    const identity = identify(body, headers);
    const key = identity.key;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const liteHeader = headers['x-openai-internal-codex-responses-lite'];
    const responsesLite = (liteHeader && !['false', '0'].includes(liteHeader)) || body.input?.some?.(x => x.type === 'additional_tools') ? true : undefined;
    const task = previous.catch(() => {}).then(() => this.select(body, catalog, identity, signal, responsesLite));
    this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  async select(body, catalog, identity, signal, responsesLite) {
    signal?.throwIfAborted();
    const { key, turn, prompt, identitySource } = identity;
    if (body.model !== AUTO) {
      if (key && body.model) this.store.save(key, turn, { model: body.model, reason: 'manual', identitySource });
      return { model: body.model, reason: 'manual', thread: key, turn };
    }
    const choices = candidatesFrom(catalog, responsesLite);
    if (!choices.length) throw Object.assign(new Error('Authenticated model catalog unavailable'), { status: 503 });
    const previous = key ? this.store.thread(key) : null;
    let current = previous?.model ?? this.defaultModel;
    if (!choices.some(x => x.id === current)) {
      current = choices.find(x => x.id === this.defaultModel)?.id ?? choices.find(x => x.tier === 'opus')?.id ?? choices[0].id;
    }
    let decision = key ? this.store.decision(key, turn) : null;
    if (decision && !catalog.models.some(x => x.slug === decision.model)) throw Object.assign(new Error('Pinned model unavailable; explicitly select a model'), { status: 409 });
    let computed = false;
    if (!decision) {
      const started = Date.now();
      decision = { model: current, reason: key ? 'continuation-fallback' : 'missing-thread-id', identitySource };
      if (key && prompt) {
        const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
        let result = null;
        let timer;
        const deadline = new AbortController();
        try {
          if (!detectOverride(prompt)) result = await Promise.race([
            this.route({ prompt, current, contextTokens, models: choices, signal: AbortSignal.any([signal ?? new AbortController().signal, deadline.signal]) }),
            new Promise(resolve => { timer = setTimeout(() => { deadline.abort(); resolve(null); }, this.deadlineMs); }),
          ]);
        } catch { result = null; } finally { clearTimeout(timer); }
        signal?.throwIfAborted();
        if (!Number.isFinite(result?.confidence) || result.confidence < 0 || result.confidence > 1) result = null;
        const chosen = choices.find(x => x.id === result?.choice);
        const selected = decide({ prompt, jev: result && { ...result, choice: chosen?.tier }, current: codexTierOf(current),
          available: [...new Set(choices.map(x => x.tier))], contextTokens: previous ? contextTokens : 0 });
        const model = shouldUseExactModel(selected.reason, chosen?.tier, selected.tier) ? chosen.id
          : selected.tier === codexTierOf(current) ? current : choices.find(x => x.tier === selected.tier)?.id ?? current;
        decision = { model, reason: selected.reason, confidence: result?.confidence ?? null, ms: Date.now() - started, identitySource };
      }
      computed = true;
    }
    const executed = this.shadowed(decision, choices, current);
    if (computed && key) this.store.save(key, turn, executed);
    applyCodexTier(body, codexTierOf(executed.model), new Map(catalog.models.map(x => [x.slug, x])), executed.model);
    return { ...executed, thread: key, turn };
  }
}
