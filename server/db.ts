// Persistent job store (SQLite via node:sqlite — no native dependencies). The database lives in the
// data directory, so jobs survive container restarts.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../scripts/lib/paths.ts';

export type JobType = 'generate' | 'revise' | 'recheck' | 'rebuild';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: number;
  type: JobType;
  status: JobStatus;
  slug: string;
  params: Record<string, any>;
  batchId: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  result: Record<string, any> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextAttemptAt: string;
  /** Short progress line for list views ("section 3/9 · step 12"). */
  progress: string | null;
}

export interface StoredEvent { seq: number; jobId: number; ts: string; event: any }

let db: DatabaseSync;

export function openDb(file = path.join(DATA_DIR, 'explainer.db')) {
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      slug TEXT NOT NULL,
      params TEXT NOT NULL,
      batch_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      result TEXT,
      progress TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      next_attempt_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS jobs_slug ON jobs(slug);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
  `);
  return db;
}

const now = () => new Date().toISOString();

function row(r: any): Job {
  return {
    id: r.id, type: r.type, status: r.status, slug: r.slug, params: JSON.parse(r.params), batchId: r.batch_id,
    attempts: r.attempts, maxAttempts: r.max_attempts, error: r.error, result: r.result ? JSON.parse(r.result) : null,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, nextAttemptAt: r.next_attempt_at, progress: r.progress,
  };
}

export function createJob(j: { type: JobType; slug: string; params: object; batchId?: string | null; maxAttempts?: number }): Job {
  const t = now();
  const r = db.prepare(`INSERT INTO jobs (type, status, slug, params, batch_id, max_attempts, created_at, next_attempt_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?) RETURNING *`).get(j.type, j.slug, JSON.stringify(j.params), j.batchId ?? null, j.maxAttempts ?? 3, t, t);
  return row(r);
}

export const getJob = (id: number): Job | null => {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return r ? row(r) : null;
};

export function listJobs(opts: { status?: JobStatus[]; slug?: string; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.status?.length) { where.push(`status IN (${opts.status.map(() => '?').join(',')})`); args.push(...opts.status); }
  if (opts.slug) { where.push('slug = ?'); args.push(opts.slug); }
  const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, opts.limit ?? 200).map(row);
}

/** The next job that is due, oldest first. */
export function nextDueJob(): Job | null {
  const r = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id ASC LIMIT 1`).get(now());
  return r ? row(r) : null;
}

export function earliestQueued(): string | null {
  const r: any = db.prepare(`SELECT MIN(next_attempt_at) AS t FROM jobs WHERE status = 'queued'`).get();
  return r?.t ?? null;
}

export function markRunning(id: number) {
  db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL WHERE id = ?`).run(now(), id);
}

export function markFinished(id: number, status: 'succeeded' | 'failed' | 'cancelled', fields: { error?: string | null; result?: object | null } = {}) {
  db.prepare(`UPDATE jobs SET status = ?, error = ?, result = ?, finished_at = ?, progress = NULL WHERE id = ?`)
    .run(status, fields.error ?? null, fields.result ? JSON.stringify(fields.result) : null, now(), id);
}

export function requeue(id: number, delaySeconds: number, error: string) {
  db.prepare(`UPDATE jobs SET status = 'queued', error = ?, next_attempt_at = ?, progress = NULL WHERE id = ?`)
    .run(error, new Date(Date.now() + delaySeconds * 1000).toISOString(), id);
}

/** Manual retry/re-run of a finished job (resets the attempt budget). Long-form generations resume. */
export function retryJob(id: number): boolean {
  return Number(db.prepare(`UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, result = NULL, finished_at = NULL, next_attempt_at = ? WHERE id = ? AND status IN ('failed', 'cancelled', 'succeeded')`).run(now(), id).changes) > 0;
}

export function cancelQueued(id: number): boolean {
  return Number(db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`).run(now(), id).changes) > 0;
}

export function setProgress(id: number, progress: string) {
  db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(progress, id);
}

/** After a crash/restart, jobs that were running are queued again (long-form runs resume). */
export function recoverInterrupted(): number {
  return Number(db.prepare(`UPDATE jobs SET status = 'queued', next_attempt_at = ?, progress = NULL WHERE status = 'running'`).run(now()).changes);
}

export function batchJobs(batchId: string): Job[] {
  return db.prepare('SELECT * FROM jobs WHERE batch_id = ? ORDER BY id').all(batchId).map(row);
}

export function addEvent(jobId: number, event: object): number {
  const r: any = db.prepare('INSERT INTO events (job_id, ts, event) VALUES (?, ?, ?) RETURNING seq').get(jobId, now(), JSON.stringify(event));
  return r.seq;
}

export function jobEvents(jobId: number, afterSeq = 0, limit = 5000): StoredEvent[] {
  return db.prepare('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(jobId, afterSeq, limit)
    .map((r: any) => ({ seq: r.seq, jobId: r.job_id, ts: r.ts, event: JSON.parse(r.event) }));
}

export function deleteJobsForSlug(slug: string) {
  const ids = db.prepare(`SELECT id FROM jobs WHERE slug = ? AND status NOT IN ('running', 'queued')`).all(slug).map((r: any) => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM events WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
}
