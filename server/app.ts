// HTTP API + static files. The browser UI is a separate static app that only talks to this API.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Config } from '../agent/config.ts';
import { DEPTH_NAMES, DEPTHS, type Depth, RIGOR_NAMES, type Rigor } from '../agent/depth.ts';
import { slugify, uniqueSlug } from '../agent/pipeline.ts';
import { Research } from '../agent/research/index.ts';
import { writeMeta } from '../scripts/lib/meta.ts';
import { paths, ROOT } from '../scripts/lib/paths.ts';
import * as db from './db.ts';
import { deleteExplainer, explainerDetail, listExplainers, validSlug } from './explainers.ts';
import type { JobRunner, RunnerMessage } from './runner.ts';

export function createApp(cfg: Config, runner: JobRunner) {
  const app = new Hono();
  const appHtml = path.join(ROOT, 'dist-app/index.html');

  // ----- Explainers -----
  app.get('/api/explainers', (c) => {
    const active = new Map<string, db.Job>();
    for (const j of db.listJobs({ status: ['queued', 'running'] })) if (!active.has(j.slug) || j.status === 'running') active.set(j.slug, j);
    return c.json(listExplainers().map((m) => ({ ...m, job: active.get(m.slug) ? pickJob(active.get(m.slug)!) : null })));
  });

  app.get('/api/explainers/:slug', (c) => {
    const d = explainerDetail(c.req.param('slug'));
    if (!d) return c.json({ error: 'not found' }, 404);
    return c.json({ ...d, jobs: db.listJobs({ slug: c.req.param('slug'), limit: 20 }).map(pickJob) });
  });

  app.delete('/api/explainers/:slug', (c) => {
    const slug = c.req.param('slug');
    if (db.listJobs({ slug, status: ['queued', 'running'] }).length) return c.json({ error: 'A job for this explainer is queued or running — cancel it first.' }, 409);
    if (!deleteExplainer(slug)) return c.json({ error: 'not found' }, 404);
    db.deleteJobsForSlug(slug);
    runner.publish({ kind: 'explainers' });
    return c.json({ ok: true });
  });

  app.post('/api/explainers/:slug/revise', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json().catch(() => ({}));
    if (!explainerDetail(slug)) return c.json({ error: 'not found' }, 404);
    if (!String(body.instruction ?? '').trim()) return c.json({ error: 'instruction is required' }, 400);
    const rigor: Rigor = RIGOR_NAMES.includes(body.rigor) ? body.rigor : cfg.agent.defaultRigor;
    return c.json(enqueue({ type: 'revise', slug, params: { instruction: String(body.instruction).trim(), factCheck: Boolean(body.factCheck), rigor } }));
  });

  /** Body: { rigor? } — thorough (default) = claim-by-claim fact-check, quick = one review pass. */
  app.post('/api/explainers/:slug/fact-check', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json().catch(() => ({}));
    if (!explainerDetail(slug)) return c.json({ error: 'not found' }, 404);
    const rigor: Rigor = RIGOR_NAMES.includes(body.rigor) ? body.rigor : 'thorough';
    return c.json(enqueue({ type: 'recheck', slug, params: { rigor } }));
  });

  app.post('/api/explainers/:slug/rebuild', (c) => {
    const slug = c.req.param('slug');
    if (!explainerDetail(slug)) return c.json({ error: 'not found' }, 404);
    return c.json(enqueue({ type: 'rebuild', slug, params: {}, maxAttempts: 1 }));
  });

  app.post('/api/rebuild-all', (c) => c.json(enqueue({ type: 'rebuild', slug: '*', params: {}, maxAttempts: 1 })));

  // ----- Jobs -----
  /** Body: { prompt } or { prompts: [...] } (batch), plus optional depth, rigor and factCheck. */
  app.post('/api/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prompts: string[] = (Array.isArray(body.prompts) ? body.prompts : [body.prompt]).map((s: unknown) => String(s ?? '').trim()).filter(Boolean);
    if (prompts.length === 0) return c.json({ error: 'prompt is required' }, 400);
    if (prompts.length > 100) return c.json({ error: 'at most 100 prompts per batch' }, 400);
    const depth: Depth = DEPTH_NAMES.includes(body.depth) ? body.depth : cfg.agent.defaultDepth;
    const rigor: Rigor = RIGOR_NAMES.includes(body.rigor) ? body.rigor : cfg.agent.defaultRigor;
    const factCheck = body.factCheck === undefined ? cfg.factCheck.enabled : Boolean(body.factCheck);
    const batchId = prompts.length > 1 ? `b${Date.now().toString(36)}` : null;
    const jobs = prompts.map((prompt) => {
      // Reserve the slug now so the explainer shows up in the index and retries reuse the same folder.
      const slug = uniqueSlug(slugify(prompt));
      mkdirSync(paths(slug).dir, { recursive: true });
      writeMeta(paths(slug), { status: 'draft', statusDetail: 'queued', prompt, depth, rigor, model: cfg.llm.model, title: prompt, description: '' });
      return enqueue({ type: 'generate', slug, params: { prompt, depth, rigor, factCheck }, batchId });
    });
    runner.publish({ kind: 'explainers' });
    return c.json({ batchId, jobs });
  });

  app.get('/api/jobs', (c) => {
    const status = c.req.query('status')?.split(',').filter(Boolean) as db.JobStatus[] | undefined;
    return c.json(db.listJobs({ status, limit: Number(c.req.query('limit') ?? 100) }).map(pickJob));
  });

  app.get('/api/jobs/:id', (c) => {
    const job = db.getJob(Number(c.req.param('id')));
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json({ ...job, events: db.jobEvents(job.id, Number(c.req.query('after') ?? 0)) });
  });

  app.post('/api/jobs/:id/cancel', (c) => c.json({ ok: runner.cancel(Number(c.req.param('id'))) }));

  app.post('/api/jobs/:id/retry', (c) => {
    const id = Number(c.req.param('id'));
    const ok = db.retryJob(id);
    runner.wake();
    const job = db.getJob(id);
    if (job) runner.publish({ kind: 'job', job });
    return c.json({ ok }, ok ? 200 : 409);
  });

  // ----- Live updates (Server-Sent Events) -----
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    const queue: RunnerMessage[] = [];
    let notifyNew: (() => void) | null = null;
    const onMessage = (m: RunnerMessage) => { queue.push(m); notifyNew?.(); };
    runner.on('message', onMessage);
    stream.onAbort(() => { runner.off('message', onMessage); notifyNew?.(); });
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ running: runner.running ? pickJob(runner.running) : null }) });
    while (!stream.aborted) {
      if (queue.length === 0) {
        await Promise.race([new Promise<void>((r) => { notifyNew = r; }), stream.sleep(20_000)]);
        notifyNew = null;
        if (queue.length === 0) { await stream.writeSSE({ event: 'ping', data: '' }); continue; }
      }
      const m = queue.shift()!;
      await stream.writeSSE({ event: m.kind, data: JSON.stringify(m.kind === 'job' ? { job: pickJob(m.job) } : m) });
    }
  }));

  // ----- Misc -----
  app.get('/api/config', (c) => {
    let research = 'unavailable';
    try { const r = new Research(cfg.research); research = r.providers.length ? r.searchLabel : cfg.research.wikipedia ? 'Wikipedia only' : 'none'; } catch (err: any) { research = `misconfigured: ${err.message}`; }
    return c.json({
      model: cfg.llm.model,
      baseUrl: cfg.llm.baseUrl,
      research,
      factCheck: cfg.factCheck.enabled,
      defaultDepth: cfg.agent.defaultDepth,
      defaultRigor: cfg.agent.defaultRigor,
      depths: DEPTH_NAMES.map((d) => ({ id: d, label: DEPTHS[d].label, minutes: DEPTHS[d].minutes, words: DEPTHS[d].words, mode: DEPTHS[d].mode })),
      notifications: Boolean(cfg.notifications.ntfy.url && cfg.notifications.ntfy.topic),
    });
  });

  app.get('/api/health', (c) => c.json({ ok: true, running: runner.running ? pickJob(runner.running) : null }));

  // ----- Explainer pages -----
  // Served sandboxed: generated pages run scripts, but as an opaque origin they can't call this API.
  app.get('/e/:slug/', (c) => {
    const slug = c.req.param('slug');
    const p = paths(slug);
    if (!validSlug(slug) || !existsSync(p.html)) return c.text('Not found', 404);
    c.header('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads');
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(p.html, 'utf8').replace(/<body\b[^>]*>/, (m) => `${m}${BACK_LINK}`));
  });
  app.get('/e/:slug', (c) => c.redirect(`/e/${c.req.param('slug')}/`, 301));
  app.get('/e/:slug/download', (c) => {
    const slug = c.req.param('slug');
    const p = paths(slug);
    if (!validSlug(slug) || !existsSync(p.html)) return c.text('Not found', 404);
    c.header('Content-Disposition', `attachment; filename="${slug}.html"`);
    return c.body(readFileSync(p.html), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });
  app.get('/e/:slug/source.mdx', (c) => {
    const p = paths(c.req.param('slug'));
    if (!validSlug(p.slug) || !existsSync(p.mdx)) return c.text('Not found', 404);
    return c.body(readFileSync(p.mdx, 'utf8'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // ----- The web app -----
  app.get('/', (c) => {
    if (!existsSync(appHtml)) return c.text('The web UI has not been built yet: run `npm run build:app`.', 503);
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(appHtml, 'utf8'));
  });

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    console.error('[http]', err);
    return c.json({ error: err.message }, 500);
  });

  function enqueue(j: { type: db.JobType; slug: string; params: object; batchId?: string | null; maxAttempts?: number }) {
    const job = db.createJob({ ...j, maxAttempts: j.maxAttempts ?? cfg.server.jobRetries + 1 });
    runner.publish({ kind: 'job', job });
    runner.wake();
    return pickJob(job);
  }

  return app;
}

/** "Back to library" button injected into explainer pages served by the service (they are standalone files otherwise). */
const BACK_LINK = `<a href="/" title="All explainers" style="position:fixed;top:.75rem;left:.75rem;z-index:60;display:flex;align-items:center;gap:.35rem;padding:.35rem .7rem;border-radius:9999px;font:500 .8rem/1.2 'Inter Variable',system-ui,sans-serif;text-decoration:none;color:var(--color-base-content);background:color-mix(in oklab,var(--color-base-100) 85%,transparent);border:1px solid var(--color-base-300);backdrop-filter:blur(6px)">&larr; Library</a>`;

/** Job as sent to clients. */
function pickJob(j: db.Job) {
  return { id: j.id, type: j.type, status: j.status, slug: j.slug, params: j.params, batchId: j.batchId, attempts: j.attempts, maxAttempts: j.maxAttempts, error: j.error, result: j.result, progress: j.progress, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, nextAttemptAt: j.nextAttemptAt };
}
