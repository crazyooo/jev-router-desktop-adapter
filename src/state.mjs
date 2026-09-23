import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class StateStore {
  constructor(file, { ttlMs = 7 * 86400000, maxThreads = 1000 } = {}) {
    Object.assign(this, { file, ttlMs, maxThreads });
    this.data = { version: 1, threads: {}, recent: [] };
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (data.version !== 1 || !data.threads || !Array.isArray(data.recent)) throw new Error('invalid state');
        this.data = data;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Routing state is unreadable; refusing to forget pinned turns.');
      }
    }
    this.prune();
  }
  prune() {
    this.data.threads = Object.fromEntries(Object.entries(this.data.threads)
      .filter(([, v]) => Date.now() - v.at < this.ttlMs)
      .sort((a, b) => b[1].at - a[1].at).slice(0, this.maxThreads));
    this.data.recent = this.data.recent.filter(x => Date.now() - x.at < this.ttlMs).slice(-100);
  }
  thread(key) { return this.data.threads[key]; }
  decision(key, turn) { return this.thread(key)?.turns?.[turn]; }
  save(key, turn, decision) {
    const at = Date.now();
    const turns = { ...this.thread(key)?.turns, [turn]: { ...decision, at } };
    const before = this.data;
    this.data = { ...before,
      threads: { ...before.threads, [key]: { model: decision.model, at, turns: Object.fromEntries(Object.entries(turns).sort((a, b) => b[1].at - a[1].at).slice(0, 20)) } },
      recent: [...before.recent, { thread: key, turn, ...decision, at }],
    };
    try { this.flush(); } catch (error) { this.data = before; throw error; }
  }
  flush() {
    this.prune();
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.file), 0o700);
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}
