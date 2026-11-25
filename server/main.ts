// Entry point of the self-hosted service: `npm start`.
import { serve } from '@hono/node-server';
import { loadConfig } from '../agent/config.ts';
import { DATA_DIR } from '../scripts/lib/paths.ts';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { JobRunner } from './runner.ts';

const cfg = loadConfig();
openDb();
const runner = new JobRunner(cfg);
const app = createApp(cfg, runner);
runner.start();

const server = serve({ fetch: app.fetch, port: cfg.server.port, hostname: process.env.HOST ?? '::' }, (info) => {
  console.log(`explainer service on http://localhost:${info.port} · data: ${DATA_DIR} · model: ${cfg.llm.model} @ ${cfg.llm.baseUrl}`);
});

const shutdown = () => {
  console.log('shutting down…');
  runner.stop(); // a running job is cancelled; it will be resumed/retried on next start
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
