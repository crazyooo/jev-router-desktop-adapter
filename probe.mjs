import { startCodexProxy } from './upstream/src/codex-proxy.mjs';
const server = await startCodexProxy({ route: async () => null });
console.log(JSON.stringify({port: server.port}));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
