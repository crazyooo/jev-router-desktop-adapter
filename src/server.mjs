import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { StateStore } from './state.mjs';
import { Router, createJevRoute, withAutoModel, digest, AUTO } from './routing.mjs';

export const UPSTREAM = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_PORT = 43127;
const MAX_BODY = 32 * 1024 * 1024;
const forbidden = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'upgrade']);
const safeHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => !forbidden.has(key.toLowerCase())));
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

export function upstreamRequest(url, options, body, signal) {
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'http:' ? http : https;
    const request = client.request(url, { ...options, signal }, resolve);
    request.on('error', reject);
    request.setTimeout(180000, () => request.destroy(new Error('upstream_idle_timeout')));
    request.end(body);
  });
}
async function readBody(stream, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export async function startServer({ port = DEFAULT_PORT, upstream = UPSTREAM, store = new StateStore(), route,
  defaultModel = 'gpt-5.6-sol', event = () => {}, deadlineMs = 8000, mode = 'active', shadowBaseline = null } = {}) {
  route ??= createJevRoute(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY, deadlineMs);
  const router = new Router({ store, route, defaultModel, deadlineMs, mode, shadowBaseline });
  const catalogs = new Map();
  const startedAt = Date.now();
  let requests = 0;
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    active.add(abort);
    req.on('aborted', () => abort.abort());
    res.on('close', () => { active.delete(abort); if (!res.writableFinished) abort.abort(); });
    let outcome;
    try {
      const host = req.headers.host?.split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(host) || req.headers.origin) return reply(res, 403, { error: 'local_native_clients_only' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return reply(res, 200, { ok: true, version: '0.3.0', pid: process.pid, startedAt, requests, backend: 'chatgpt-subscription', mode: router.mode, shadowBaseline: router.shadowBaseline, deadlineMs: router.deadlineMs });
      if (req.method === 'GET' && url.pathname === '/status') return reply(res, 200, { recent: store.data.recent, threads: Object.keys(store.data.threads).length });
      if (!((req.method === 'GET' && url.pathname === '/models') || (req.method === 'POST' && ['/responses', '/responses/compact'].includes(url.pathname)))) return reply(res, 404, { error: 'unsupported_endpoint' });
      if (!req.headers.authorization?.startsWith('Bearer ') || !req.headers['chatgpt-account-id']) return reply(res, 401, { error: 'chatgpt_subscription_auth_required' });
      requests++;
      const account = digest(req.headers['chatgpt-account-id']);
      const headers = { ...safeHeaders(req.headers), 'accept-encoding': 'identity' };
      const cache = catalogs.get(account);
      let catalog = cache && Date.now() - cache.at < 600000 ? cache.catalog : null;
      const fetchCatalog = async () => {
        const query = url.pathname === '/models' ? url.search : '?client_version=0.155.0';
        const response = await upstreamRequest(`${upstream}/models${query}`, { method: 'GET', headers }, null, abort.signal);
        const data = await readBody(response, 4 * 1024 * 1024);
        if (response.statusCode !== 200) throw Object.assign(new Error('Model catalog request failed'), { status: response.statusCode });
        let parsed;
        try { parsed = JSON.parse(data); } catch (error) {
          throw Object.assign(new Error('Invalid model catalog'), { status: 502, cause: error });
        }
        if (!Array.isArray(parsed.models) || !parsed.models.length) throw Object.assign(new Error('Invalid model catalog'), { status: 502 });
        catalogs.set(account, { at: Date.now(), catalog: parsed });
        if (catalogs.size > 4) catalogs.delete(catalogs.keys().next().value);
        return parsed;
      };
      if (url.pathname === '/models') return reply(res, 200, withAutoModel(await fetchCatalog()));
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: 'invalid_json' }); }
      if (!body || typeof body !== 'object' || !body.model) return reply(res, 400, { error: 'model_required' });
      if (!catalog && body.model === AUTO) catalog = await fetchCatalog();
      outcome = await router.apply(body, req.headers, catalog, abort.signal);
      event({ type: 'request', ...outcome });
      const response = await upstreamRequest(`${upstream}${url.pathname}${url.search}`, { method: 'POST', headers }, Buffer.from(JSON.stringify(body)), abort.signal);
      res.writeHead(response.statusCode, safeHeaders(response.headers));
      await pipeline(response, res, { signal: abort.signal });
      event({ type: 'complete', model: outcome.model, thread: outcome.thread, turn: outcome.turn, status: response.statusCode });
    } catch (error) {
      event({ type: abort.signal.aborted ? 'cancelled' : 'error', code: error.code ?? error.status ?? 'upstream_failure', model: outcome?.model });
      if (!res.headersSent && !res.destroyed) reply(res, error.status >= 400 && error.status <= 599 ? error.status : 502, { error: { type: 'jev_desktop_proxy', message: 'Request failed; inspect local status. No request was replayed.' } });
      else if (!res.destroyed) res.destroy();
    } finally { active.delete(abort); }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, server, store, router, close: async () => {
    for (const abort of active) abort.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function logTo(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.previous`); } catch {}
    appendFileSync(file, JSON.stringify({ ...data, at: Date.now() }) + '\n', { mode: 0o600 });
  } catch { /* Logging must not block a request; state persistence remains strict. */ }
}

export async function main() {
  const envFile = join(homedir(), '.jev-router.env');
  if (existsSync(envFile)) {
    // JEV_*/TYPESAFE_* keys only. This file is the adapter's own 0600 config surface, and the
    // Routing tier overrides (JEV_CODEX_*_MODEL) have to reach the process that serves requests.
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*((?:JEV|TYPESAFE)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const directory = process.env.JEV_DESKTOP_DATA ?? join(homedir(), 'Library', 'Application Support', 'jev-router-desktop');
  const logfile = process.env.JEV_DESKTOP_LOG ?? join(homedir(), 'Library', 'Logs', 'jev-router-desktop', 'events.jsonl');
  const instance = await startServer({ port: Number(process.env.JEV_DESKTOP_PORT ?? DEFAULT_PORT), store: new StateStore(join(directory, 'state.json')),
    deadlineMs: positive(process.env.JEV_DESKTOP_DEADLINE_MS, 8000), mode: process.env.JEV_DESKTOP_MODE ?? 'active',
    shadowBaseline: process.env.JEV_DESKTOP_BASELINE || null, event: data => logTo(logfile, data) });
  logTo(logfile, { type: 'started', pid: process.pid, port: instance.port, mode: instance.router.mode,
    shadowBaseline: instance.router.shadowBaseline, deadlineMs: instance.router.deadlineMs,
    routingKeyPresent: Boolean(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY) });
  console.log(JSON.stringify({ ready: true, port: instance.port }));
  const shutdown = async () => { await instance.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Jev Desktop failed to start; verify port, state file, and runtime.'); process.exitCode = 1; });
