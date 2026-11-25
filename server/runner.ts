// The job runner: exactly ONE job at a time, regardless of how many clients submit work. Jobs are
// persisted (SQLite); failures are retried with backoff; a failure never blocks the rest of the queue;
// jobs interrupted by a restart are resumed.
import { EventEmitter } from 'node:events';
import type { Config } from '../agent/config.ts';
import type { AgentEvent } from '../agent/events.ts';
import { AgentAborted } from '../agent/loop.ts';
import { generate, recheck, revise, type PipelineResult } from '../agent/pipeline.ts';
import { writeMeta } from '../scripts/lib/meta.ts';
import { paths } from '../scripts/lib/paths.ts';
import { allExplainers, rebuild } from '../scripts/rebuild.ts';
import * as db from './db.ts';
import { linkTo, notify } from './notify.ts';

export type RunnerMessage =
  | { kind: 'job'; job: db.Job }
  | { kind: 'event'; jobId: number; event: AgentEvent }
  | { kind: 'explainers' };

const RETRY_DELAYS = [60, 300, 900, 1800]; // seconds

export class JobRunner extends EventEmitter {
  private current: { job: db.Job; controller: AbortController } | null = null;
  private wakeUp: (() => void) | null = null;
  private stopped = false;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
    this.setMaxListeners(100);
  }

  get running() { return this.current?.job ?? null; }

  start() {
    const recovered = db.recoverInterrupted();
    if (recovered) console.log(`[runner] re-queued ${recovered} job(s) interrupted by a restart`);
    void this.loop();
  }

  stop() { this.stopped = true; this.current?.controller.abort(); this.wake(); }

  /** Call after enqueueing so an idle runner starts immediately. */
  wake() { this.wakeUp?.(); }

  publish(m: RunnerMessage) { this.emit('message', m); }

  cancel(id: number): boolean {
    if (this.current?.job.id === id) { this.current.controller.abort(); return true; }
    const ok = db.cancelQueued(id);
    if (ok) this.publishJob(id);
    return ok;
  }

  private publishJob(id: number) {
    const job = db.getJob(id);
    if (job) this.publish({ kind: 'job', job });
  }

  private async loop() {
    while (!this.stopped) {
      const job = db.nextDueJob();
      if (!job) {
        const next = db.earliestQueued();
        const wait = next ? Math.max(1000, Math.min(60_000, Date.parse(next) - Date.now())) : 60_000;
        await new Promise<void>((resolve) => { this.wakeUp = resolve; setTimeout(resolve, wait); });
        this.wakeUp = null;
        continue;
      }
      await this.run(job);
    }
  }

  private async run(job: db.Job) {
    db.markRunning(job.id);
    const controller = new AbortController();
    this.current = { job: db.getJob(job.id)!, controller };
    this.publishJob(job.id);
    const emit = this.eventSink(job.id);
    const rc = { cfg: this.cfg, emit, signal: controller.signal };
    console.log(`[runner] job ${job.id} (${job.type} ${job.slug}) started, attempt ${job.attempts + 1}`);

    try {
      let result: PipelineResult | { ok: boolean; summary: string; failed?: number };
      switch (job.type) {
        case 'generate':
          result = await generate({ prompt: job.params.prompt, slug: job.slug, depth: job.params.depth, factCheck: job.params.factCheck }, rc);
          break;
        case 'revise':
          result = await revise(job.slug, job.params.instruction, rc, { factCheck: job.params.factCheck ?? false });
          break;
        case 'recheck':
          result = await recheck(job.slug, rc);
          break;
        case 'rebuild': {
          const targets = job.slug === '*' ? allExplainers() : [paths(job.slug)];
          let failed = 0;
          for (const [i, p] of targets.entries()) {
            if (controller.signal.aborted) throw new AgentAborted();
            emit({ type: 'status', text: `rebuilding ${p.slug} (${i + 1}/${targets.length})` });
            const r = await rebuild(p);
            if (!r.ok) failed++;
            emit({ type: 'note', level: r.ok ? 'info' : 'error', text: `${p.slug}: ${r.ok ? 'ok' : r.error?.split('\n')[0]}` });
            this.publish({ kind: 'explainers' });
          }
          result = { ok: failed === 0, summary: `${targets.length - failed}/${targets.length} rebuilt`, failed };
          break;
        }
      }
      const outcome = 'meta' in result ? { ok: result.ok, status: result.meta.status, statusDetail: result.meta.statusDetail, summary: result.summary } : result;
      db.markFinished(job.id, 'succeeded', { result: outcome });
      console.log(`[runner] job ${job.id} finished: ${outcome.summary}`);
      if (this.cfg.notifications.eachJob && job.type !== 'rebuild') {
        await notify(this.cfg, {
          title: outcome.ok ? `Explainer ready: ${'meta' in result ? result.meta.title : job.slug}` : `Explainer needs attention: ${job.slug}`,
          message: outcome.summary + ('statusDetail' in outcome && outcome.statusDetail ? `\n${outcome.statusDetail}` : ''),
          tags: [outcome.ok ? 'books' : 'warning'],
          click: linkTo(this.cfg, `/e/${job.slug}/`),
        });
      }
    } catch (err: any) {
      if (this.stopped) {
        // Service shutting down: leave the job "running"; recoverInterrupted() re-queues it on the next start.
        console.log(`[runner] job ${job.id} interrupted by shutdown; it will resume on the next start`);
        return;
      }
      if (err instanceof AgentAborted || controller.signal.aborted) {
        db.markFinished(job.id, 'cancelled', { error: 'cancelled' });
        emit({ type: 'note', level: 'warn', text: 'job cancelled' });
        this.markExplainer(job, 'cancelled');
      } else {
        const message = err?.message ?? String(err);
        const permanent = /^No explainer|is not a valid|must be one of/.test(message);
        const fresh = db.getJob(job.id)!;
        if (!permanent && fresh.attempts <= Math.min(this.cfg.server.jobRetries, RETRY_DELAYS.length)) {
          const delay = RETRY_DELAYS[fresh.attempts - 1];
          db.requeue(job.id, delay, message);
          emit({ type: 'note', level: 'warn', text: `job failed (${message}); retrying in ${Math.round(delay / 60)} min` });
          console.warn(`[runner] job ${job.id} failed, retry in ${delay}s: ${message}`);
        } else {
          db.markFinished(job.id, 'failed', { error: message });
          emit({ type: 'note', level: 'error', text: `job failed: ${message}` });
          console.error(`[runner] job ${job.id} failed permanently: ${message}`);
          this.markExplainer(job, `failed: ${message}`);
          await notify(this.cfg, { title: `Explainer job failed: ${job.slug}`, message, tags: ['x'], priority: 4, click: linkTo(this.cfg, `/#/jobs/${job.id}`) });
        }
      }
    } finally {
      this.current = null;
      this.publishJob(job.id);
      this.publish({ kind: 'explainers' });
      if (job.batchId) await this.batchSummary(job.batchId);
    }
  }

  /** When a job didn't produce an explainer, make that visible in the index. */
  private markExplainer(job: db.Job, detail: string) {
    if (job.type !== 'generate') return;
    const p = paths(job.slug);
    try { writeMeta(p, { status: 'failed', statusDetail: detail }); } catch { /* folder may be gone */ }
  }

  private async batchSummary(batchId: string) {
    const jobs = db.batchJobs(batchId);
    if (jobs.length < 2 || jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const ok = jobs.filter((j) => j.status === 'succeeded' && j.result?.ok).length;
    const attention = jobs.filter((j) => j.status === 'succeeded' && !j.result?.ok).length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    await notify(this.cfg, {
      title: `Batch finished: ${ok}/${jobs.length} explainers ready`,
      message: [`${ok} ready`, attention && `${attention} need attention`, failed && `${failed} failed`].filter(Boolean).join(', '),
      tags: [failed ? 'warning' : 'tada'],
      click: linkTo(this.cfg, '/'),
    });
  }

  /** Live events go to subscribers as they happen; the stored log coalesces token deltas. */
  private eventSink(jobId: number) {
    let reasoning = '';
    let content = '';
    let lastProgress = 0;
    let agent = '';
    const flush = () => {
      if (reasoning) { db.addEvent(jobId, { type: 'reasoning', text: reasoning }); reasoning = ''; }
      if (content) { db.addEvent(jobId, { type: 'content', text: content }); content = ''; }
    };
    return (e: AgentEvent) => {
      this.publish({ kind: 'event', jobId, event: e });
      switch (e.type) {
        case 'reasoning': reasoning += e.text; return;
        case 'content': content += e.text; return;
        case 'tool-progress': case 'waiting': case 'status': return; // ephemeral
        case 'stream-end': flush(); return;
        default:
          flush();
          db.addEvent(jobId, e);
      }
      if (e.type === 'phase') agent = e.label;
      if (e.type === 'step' && Date.now() - lastProgress > 1500) {
        lastProgress = Date.now();
        const progress = `${agent ? `${agent} · ` : ''}${e.agent} step ${e.step}/${e.maxSteps}`;
        db.setProgress(jobId, progress);
        this.publishJob(jobId);
      }
    };
  }
}
