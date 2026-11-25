// Web UI: a small hash-routed single-page app over the JSON API (no framework).
//   #/            library (filter by text, tag, level, depth, status)
//   #/new         new explainer(s)
//   #/jobs        queue
//   #/jobs/:id    job detail with live log
//   #/x/:slug     explainer detail (fact-check report, sources, actions)

type Status = 'draft' | 'ready' | 'needs-attention' | 'failed';
interface Job {
  id: number; type: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; slug: string;
  params: any; batchId: string | null; attempts: number; maxAttempts: number; error: string | null; result: any;
  progress: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; nextAttemptAt: string;
}
interface Meta {
  slug: string; title: string; description: string; tags: string[]; level?: string; depth?: string; prompt?: string;
  model?: string; status: Status; statusDetail?: string; words?: number; readingMinutes?: number; citations?: number;
  factCheck?: { claimsChecked: number; problems: number; fixed: boolean }; createdAt: string; updatedAt: string; job: Job | null;
}
interface AppConfig { model: string; research: string; factCheck: boolean; defaultDepth: string; depths: { id: string; label: string; minutes: number; words: [number, number]; mode: string }[]; notifications: boolean }

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const view = $('#view');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------------------------------------------------------- API
async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...(init?.json !== undefined && { 'Content-Type': 'application/json' }) }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- state
const state = {
  config: null as AppConfig | null,
  explainers: [] as Meta[],
  jobs: [] as Job[],
  filters: { q: '', tag: '', level: '', depth: '', status: '' },
  liveJobId: null as number | null,
};
try { Object.assign(state.filters, JSON.parse(localStorage.getItem('explainer-filters') ?? '{}')); } catch { /* ignore */ }

async function loadExplainers() { state.explainers = await api<Meta[]>('/api/explainers'); }
async function loadJobs() { state.jobs = await api<Job[]>('/api/jobs?limit=100'); updateHeader(); }

// ---------------------------------------------------------------- helpers
const timeAgo = (iso?: string | null) => {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};
const depthLabel = (d?: string) => state.config?.depths.find((x) => x.id === d)?.label ?? d ?? '';
const statusBadge: Record<string, string> = {
  ready: '', draft: 'badge-info', 'needs-attention': 'badge-warning', failed: 'badge-error',
  queued: 'badge-ghost', running: 'badge-info', succeeded: 'badge-success', cancelled: 'badge-ghost',
};
function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info') {
  const el = document.createElement('div');
  el.className = `alert ${kind === 'error' ? 'alert-error' : kind === 'success' ? 'alert-success' : 'alert-info'} text-sm shadow-lg`;
  el.textContent = msg;
  $('#toast').append(el);
  setTimeout(() => el.remove(), 4500);
}
function updateHeader() {
  const active = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  for (const id of ['#queue-count', '#queue-count-m']) {
    const b = $(id);
    b.textContent = String(active.length);
    b.classList.toggle('hidden', active.length === 0);
  }
  const running = state.jobs.find((j) => j.status === 'running');
  const pill = $('#running-pill');
  pill.classList.toggle('hidden', !running);
  pill.classList.toggle('sm:flex', Boolean(running));
  if (running) $('#running-text').textContent = `${running.slug}${running.progress ? ` · ${running.progress.replace(/^.*· /, '')}` : ''}`;
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((a) => {
    const on = (a.dataset.nav === 'jobs') === location.hash.startsWith('#/jobs');
    a.classList.toggle('btn-active', on && a.classList.contains('btn'));
    a.classList.toggle('font-semibold', on);
  });
}

// ---------------------------------------------------------------- router
let currentRender: (() => void | Promise<void>) | null = null;
async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  state.liveJobId = null;
  updateHeader();
  let m: RegExpMatchArray | null;
  if (h === '/' ) currentRender = renderLibrary;
  else if (h === '/new') currentRender = renderNew;
  else if (h === '/jobs') currentRender = renderJobs;
  else if ((m = h.match(/^\/jobs\/(\d+)$/))) { const id = Number(m[1]); currentRender = () => renderJob(id); }
  else if ((m = h.match(/^\/x\/([a-z0-9-]+)$/))) { const slug = m[1]; currentRender = () => renderDetail(slug); }
  else currentRender = renderLibrary;
  try { await currentRender(); } catch (err: any) { view.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

// ---------------------------------------------------------------- library
async function renderLibrary() {
  await Promise.all([loadExplainers(), state.config ? null : api<AppConfig>('/api/config').then((c) => (state.config = c))]);
  // Most used tags first; the long tail is behind a "more" toggle so the filters stay compact on phones.
  const counts = new Map<string, number>();
  for (const t of state.explainers.flatMap((e) => e.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  const TOP = 10;
  const f = state.filters;
  view.innerHTML = `
    <div class="mb-6 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <label class="input input-sm flex-1 min-w-[12rem]">
          <svg class="size-4 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="f-q" type="search" placeholder="Search title, description, prompt…" value="${esc(f.q)}" />
        </label>
        ${select('f-level', 'Any level', ['beginner', 'intermediate', 'advanced'], f.level)}
        ${select('f-depth', 'Any depth', state.config!.depths.map((d) => d.id), f.depth, depthLabel)}
        ${select('f-status', 'Any status', ['ready', 'needs-attention', 'draft', 'failed'], f.status)}
      </div>
      ${tags.length ? `<div class="flex flex-wrap gap-1.5" id="f-tags">${tags.map((t, i) => `<button data-tag="${esc(t)}" class="badge ${f.tag === t ? 'badge-primary' : 'badge-outline border-base-content/20'} cursor-pointer ${i >= TOP && f.tag !== t ? 'hidden extra-tag' : ''}">${esc(t)} <span class="opacity-50">${counts.get(t)}</span></button>`).join('')}${tags.length > TOP ? `<button id="more-tags" class="badge badge-ghost cursor-pointer">+${tags.length - TOP} more</button>` : ''}</div>` : ''}
    </div>
    <div id="cards" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"></div>`;
  const rerender = () => {
    try { localStorage.setItem('explainer-filters', JSON.stringify(f)); } catch { /* ignore */ }
    renderCards();
  };
  $('#f-q').addEventListener('input', (e) => { f.q = (e.target as HTMLInputElement).value; rerender(); });
  for (const k of ['level', 'depth', 'status'] as const) $(`#f-${k}`).addEventListener('change', (e) => { f[k] = (e.target as HTMLSelectElement).value; rerender(); });
  view.querySelectorAll<HTMLElement>('[data-tag]').forEach((b) => b.addEventListener('click', () => { f.tag = f.tag === b.dataset.tag ? '' : b.dataset.tag!; renderLibrary(); }));
  document.getElementById('more-tags')?.addEventListener('click', (e) => {
    view.querySelectorAll('.extra-tag').forEach((t) => t.classList.remove('hidden'));
    (e.currentTarget as HTMLElement).remove();
  });
  renderCards();
}

function select(id: string, any: string, options: string[], value: string, label: (s: string) => string = (s) => s.replace('-', ' ')) {
  return `<select id="${id}" class="select select-sm w-auto">${[`<option value="">${any}</option>`, ...options.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(label(o))}</option>`)].join('')}</select>`;
}

function renderCards() {
  const box = document.getElementById('cards');
  if (!box) return;
  const f = state.filters;
  const q = f.q.toLowerCase();
  const list = state.explainers.filter((e) =>
    (!q || `${e.title} ${e.description} ${e.prompt ?? ''} ${e.tags.join(' ')}`.toLowerCase().includes(q)) &&
    (!f.tag || e.tags.includes(f.tag)) && (!f.level || e.level === f.level) && (!f.depth || e.depth === f.depth) && (!f.status || e.status === f.status));
  if (!state.explainers.length) {
    box.outerHTML = `<div id="cards" class="rounded-box border border-dashed border-base-300 p-10 text-center"><p class="font-serif text-2xl">No explainers yet</p><p class="mt-2 text-base-content/60">Ask for your first one.</p><a href="#/new" class="btn btn-primary mt-5">New explainer</a></div>`;
    return;
  }
  box.innerHTML = list.length ? list.map(card).join('') : `<p class="col-span-full py-10 text-center text-base-content/60">No explainers match the filters.</p>`;
}

function card(e: Meta) {
  const job = e.job;
  const busy = job && (job.status === 'running' || job.status === 'queued');
  const open = e.status !== 'draft' && e.status !== 'failed';
  return `
  <article class="group relative flex flex-col rounded-box border border-base-300 bg-base-100 p-5 transition hover:border-primary/40 hover:shadow-md">
    <div class="mb-2 flex flex-wrap items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-base-content/55">
      ${e.depth ? `<span class="font-semibold text-secondary">${esc(depthLabel(e.depth))}</span>` : ''}
      ${e.level ? `<span>· ${esc(e.level)}</span>` : ''}
      ${e.readingMinutes ? `<span>· ${e.readingMinutes} min</span>` : ''}
      <span class="ml-auto normal-case tracking-normal">${timeAgo(e.createdAt)}</span>
    </div>
    <h2 class="font-serif text-xl font-semibold leading-snug text-balance">
      <a href="${open ? `/e/${e.slug}/` : `#/x/${e.slug}`}" class="after:absolute after:inset-0">${esc(e.title)}</a>
    </h2>
    ${e.description ? `<p class="mt-2 line-clamp-3 text-sm leading-relaxed text-base-content/70">${esc(e.description)}</p>` : ''}
    <div class="mt-auto pt-4">
      ${busy ? `<div class="mb-3 rounded-lg bg-info/10 px-3 py-2 text-xs text-info"><span class="loading loading-dots loading-xs align-middle"></span> ${job!.status === 'queued' ? 'queued' : esc(job!.progress ?? 'running')}</div>` : ''}
      <div class="flex flex-wrap items-center gap-1.5">
        ${e.status !== 'ready' && !busy ? `<span class="badge badge-sm ${statusBadge[e.status]}" title="${esc(e.statusDetail ?? '')}">${esc(e.status.replace('-', ' '))}</span>` : ''}
        ${e.factCheck?.claimsChecked ? `<span class="badge badge-sm badge-ghost" title="fact-check">✓ ${e.factCheck.claimsChecked} claims${e.factCheck.problems ? ` · ${e.factCheck.problems} fixed` : ''}</span>` : ''}
        ${e.tags.slice(0, 3).map((t) => `<span class="badge badge-sm badge-outline border-base-content/15 text-base-content/60">${esc(t)}</span>`).join('')}
        <a href="#/x/${e.slug}" class="btn btn-ghost btn-xs relative z-10 ml-auto" title="Details and actions">
          <svg class="size-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </a>
      </div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------- new
async function renderNew() {
  state.config ??= await api<AppConfig>('/api/config');
  const c = state.config;
  view.innerHTML = `
  <form id="new-form" class="mx-auto max-w-2xl">
    <h1 class="font-serif text-3xl font-semibold">New explainer</h1>
    <p class="mt-1 text-sm text-base-content/60">Written by <code>${esc(c.model)}</code> · research: ${esc(c.research)}${c.factCheck ? ' · fact-checked' : ''}</p>
    <label class="mt-6 block">
      <span class="text-sm font-medium">What should be explained?</span>
      <textarea id="prompt" required rows="4" class="textarea mt-1 w-full text-base" placeholder="Explain how the internet works and why packets can take different routes"></textarea>
    </label>
    <label class="mt-2 flex items-center gap-2 text-sm">
      <input id="batch" type="checkbox" class="checkbox checkbox-sm" /> Batch: one prompt per line (each becomes its own explainer, processed one after another)
    </label>
    <fieldset class="mt-6">
      <legend class="text-sm font-medium">Depth</legend>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        ${c.depths.map((d) => `
        <label class="flex cursor-pointer gap-3 rounded-box border border-base-300 p-3 has-checked:border-primary has-checked:bg-primary/5">
          <input type="radio" name="depth" value="${d.id}" class="radio radio-sm radio-primary mt-0.5" ${d.id === c.defaultDepth ? 'checked' : ''} />
          <span><span class="font-semibold">${esc(d.label)}</span> <span class="text-sm text-base-content/60">· ~${d.minutes} min read</span>
          <span class="block text-xs text-base-content/55">${d.words[0].toLocaleString()}–${d.words[1].toLocaleString()} words${d.mode === 'sections' ? ' · planned and written section by section' : ''}</span></span>
        </label>`).join('')}
      </div>
    </fieldset>
    <label class="mt-5 flex items-center gap-2 text-sm">
      <input id="factcheck" type="checkbox" class="toggle toggle-sm toggle-primary" ${c.factCheck ? 'checked' : ''} /> Fact-check after writing (verifies claims against sources and fixes problems)
    </label>
    <div class="mt-8 flex items-center gap-3">
      <button class="btn btn-primary" type="submit">Queue</button>
      <span class="text-sm text-base-content/55">Jobs run one at a time; you can close this page.</span>
    </div>
  </form>`;
  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $<HTMLTextAreaElement>('#prompt').value.trim();
    const batch = $<HTMLInputElement>('#batch').checked;
    const prompts = batch ? text.split('\n').map((s) => s.trim()).filter(Boolean) : [text];
    if (!prompts.length) return;
    const depth = $<HTMLInputElement>('input[name=depth]:checked').value;
    try {
      const r = await api('/api/jobs', { method: 'POST', json: { prompts, depth, factCheck: $<HTMLInputElement>('#factcheck').checked } });
      toast(`${r.jobs.length} explainer${r.jobs.length > 1 ? 's' : ''} queued`, 'success');
      location.hash = r.jobs.length === 1 ? `#/jobs/${r.jobs[0].id}` : '#/jobs';
    } catch (err: any) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- queue
async function renderJobs() {
  await loadJobs();
  const groups: [string, Job[]][] = [
    ['Running', state.jobs.filter((j) => j.status === 'running')],
    ['Queued', state.jobs.filter((j) => j.status === 'queued').reverse()],
    ['Finished', state.jobs.filter((j) => !['running', 'queued'].includes(j.status))],
  ];
  view.innerHTML = `<h1 class="mb-6 font-serif text-3xl font-semibold">Queue</h1>` + groups.map(([title, jobs]) => `
    <section class="mb-8">
      <h2 class="mb-2 text-xs font-semibold uppercase tracking-widest text-base-content/50">${title} <span class="font-normal">(${jobs.length})</span></h2>
      ${jobs.length ? `<ul class="divide-y divide-base-300 rounded-box border border-base-300">${jobs.map(jobRow).join('')}</ul>` : `<p class="text-sm text-base-content/50">None.</p>`}
    </section>`).join('');
  bindJobButtons(view, renderJobs);
}

function jobLabel(j: Job) {
  return j.type === 'generate' ? (j.params.prompt as string) : j.type === 'revise' ? `Revise ${j.slug}: ${j.params.instruction}` : j.type === 'recheck' ? `Fact-check ${j.slug}` : j.slug === '*' ? 'Rebuild all explainers' : `Rebuild ${j.slug}`;
}

function jobRow(j: Job) {
  const retryAt = j.status === 'queued' && j.attempts > 0 ? ` · retry ${timeAgo(j.nextAttemptAt).replace('ago', '') === 'just now' ? 'soon' : `at ${new Date(j.nextAttemptAt).toLocaleTimeString()}`}` : '';
  return `<li class="flex flex-wrap items-center gap-3 px-4 py-3">
    <span class="badge badge-sm ${statusBadge[j.status]}">${j.status}</span>
    <a href="#/jobs/${j.id}" class="min-w-0 flex-1">
      <span class="block truncate font-medium">${esc(jobLabel(j))}</span>
      <span class="block truncate text-xs text-base-content/55">#${j.id} · ${esc(j.type)}${j.params.depth ? ` · ${esc(depthLabel(j.params.depth))}` : ''} · ${timeAgo(j.createdAt)}${j.progress ? ` · ${esc(j.progress)}` : ''}${retryAt}${j.error ? ` · <span class="text-error">${esc(j.error.slice(0, 120))}</span>` : ''}${j.result?.summary ? ` · ${esc(j.result.summary)}` : ''}</span>
    </a>
    ${jobButtons(j)}
  </li>`;
}

function jobButtons(j: Job) {
  return `${j.status === 'queued' || j.status === 'running' ? `<button data-cancel="${j.id}" class="btn btn-ghost btn-xs">Cancel</button>` : ''}
    ${j.status === 'failed' || j.status === 'cancelled' || (j.status === 'succeeded' && j.result && !j.result.ok && j.type !== 'rebuild') ? `<button data-retry="${j.id}" class="btn btn-ghost btn-xs" title="Run again (long explainers resume where they stopped)">Retry</button>` : ''}
    ${j.status === 'succeeded' && j.slug !== '*' ? `<a href="/e/${j.slug}/" class="btn btn-ghost btn-xs">Open</a>` : ''}`;
}

function bindJobButtons(root: HTMLElement, after: () => void) {
  root.querySelectorAll<HTMLElement>('[data-cancel]').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Cancel this job?')) return;
    await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
    after();
  }));
  root.querySelectorAll<HTMLElement>('[data-retry]').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault();
    await api(`/api/jobs/${b.dataset.retry}/retry`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
    after();
  }));
}

// ---------------------------------------------------------------- job detail (live log)
async function renderJob(id: number) {
  const job = await api<Job & { events: { seq: number; ts: string; event: any }[] }>(`/api/jobs/${id}`);
  view.innerHTML = `
    <a href="#/jobs" class="text-sm text-base-content/60 hover:underline">← Queue</a>
    <div class="mt-2 flex flex-wrap items-start gap-3">
      <h1 class="min-w-0 flex-1 font-serif text-2xl font-semibold leading-snug">${esc(jobLabel(job))}</h1>
      <div id="job-actions" class="flex gap-2">${jobButtons(job)}</div>
    </div>
    <p id="job-status" class="mt-1 text-sm text-base-content/60"></p>
    <div class="mt-4 flex items-center justify-between">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-base-content/50">Activity</h2>
      <label class="flex items-center gap-2 text-xs text-base-content/60"><input id="show-thinking" type="checkbox" class="toggle toggle-xs" /> show reasoning</label>
    </div>
    <div id="log" class="mt-2 space-y-1 rounded-box border border-base-300 bg-base-200/40 p-3 font-mono text-xs leading-relaxed"></div>
    <div id="live" class="mt-2 hidden whitespace-pre-wrap rounded-box border border-dashed border-base-300 p-3 font-mono text-xs text-base-content/55"></div>`;
  const setStatus = (j: Job) => {
    $('#job-status').innerHTML = `<span class="badge badge-sm ${statusBadge[j.status]}">${j.status}</span> attempt ${j.attempts}/${j.maxAttempts}${j.progress ? ` · ${esc(j.progress)}` : ''}${j.error ? ` · <span class="text-error">${esc(j.error)}</span>` : ''}${j.result?.summary ? ` · ${esc(j.result.summary)}` : ''}${j.slug !== '*' ? ` · <a class="link" href="#/x/${j.slug}">explainer details</a>` : ''}`;
    $('#job-actions').innerHTML = jobButtons(j);
    bindJobButtons($('#job-actions'), () => renderJob(id));
  };
  setStatus(job);
  const log = $('#log');
  const thinking = $<HTMLInputElement>('#show-thinking');
  try { thinking.checked = localStorage.getItem('explainer-show-thinking') === '1'; } catch { /* ignore */ }
  const applyThinking = () => log.querySelectorAll('[data-thinking]').forEach((el) => el.classList.toggle('hidden', !thinking.checked));
  thinking.addEventListener('change', () => { try { localStorage.setItem('explainer-show-thinking', thinking.checked ? '1' : '0'); } catch { /* ignore */ } applyThinking(); });
  for (const e of job.events) appendEvent(log, e.event);
  applyThinking();
  state.liveJobId = id;
  liveSink = (event) => {
    const live = $('#live');
    if (event.type === 'reasoning' || event.type === 'content') {
      live.classList.remove('hidden');
      live.textContent = (live.textContent + event.text).slice(-1500);
      return;
    }
    if (event.type === 'waiting') { live.classList.remove('hidden'); live.textContent = `waiting for the model… ${event.elapsedSeconds}s`; return; }
    if (event.type === 'tool-progress') { live.classList.remove('hidden'); live.textContent = `→ ${event.name} (${(event.bytes / 1024).toFixed(1)} KB streamed)`; return; }
    if (event.type === 'status') { live.classList.remove('hidden'); live.textContent = event.text; return; }
    if (event.type === 'stream-end') return;
    live.textContent = '';
    live.classList.add('hidden');
    const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 80;
    appendEvent(log, event);
    applyThinking();
    if (atBottom) scrollTo(0, document.body.scrollHeight);
  };
  liveJobUpdate = setStatus;
}

let liveSink: ((e: any) => void) | null = null;
let liveJobUpdate: ((j: Job) => void) | null = null;

function appendEvent(log: HTMLElement, e: any) {
  const div = document.createElement('div');
  switch (e.type) {
    case 'phase': div.className = 'pt-3 font-sans text-sm font-semibold text-base-content'; div.textContent = `▶ ${e.label}`; break;
    case 'step': div.className = 'pt-2 text-secondary'; div.textContent = `── ${e.agent} · step ${e.step}/${e.maxSteps}`; break;
    case 'reasoning': div.className = 'whitespace-pre-wrap text-base-content/45'; div.dataset.thinking = '1'; div.textContent = `💭 ${e.text.trim()}`; break;
    case 'content': div.className = 'whitespace-pre-wrap'; div.textContent = e.text.trim(); break;
    case 'tool-call': div.className = 'text-primary'; div.textContent = `→ ${e.name} ${e.summary ?? ''}`; break;
    case 'tool-result': if (!e.summary) return; div.className = `whitespace-pre-wrap pl-4 ${e.ok ? 'text-base-content/60' : 'text-error'}`; div.textContent = e.summary.length > 1500 ? `${e.summary.slice(0, 1500)}…` : e.summary; break;
    case 'build': div.className = e.ok ? 'text-success' : 'text-error'; div.textContent = e.ok ? `✓ build + render check passed (${e.warnings} warning(s))` : `✗ ${e.detail ?? 'check failed'}`; break;
    case 'usage': div.className = 'text-base-content/40'; div.textContent = `tokens: ${e.promptTokens} in / ${e.completionTokens} out`; break;
    case 'note': div.className = e.level === 'error' ? 'text-error' : e.level === 'warn' ? 'text-warning' : 'text-base-content/55'; div.textContent = e.text; break;
    case 'done': div.className = `pt-3 font-sans text-sm font-semibold ${e.ok ? 'text-success' : 'text-warning'}`; div.textContent = `${e.ok ? '✓' : '⚠'} ${e.summary}`; break;
    default: return;
  }
  log.append(div);
}

// ---------------------------------------------------------------- explainer detail
async function renderDetail(slug: string) {
  const d = await api<any>(`/api/explainers/${slug}`);
  const m: Meta = d.meta;
  const fc = d.factCheck;
  view.innerHTML = `
    <a href="#/" class="text-sm text-base-content/60 hover:underline">← Library</a>
    <div class="mt-3 grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div class="min-w-0">
        <div class="flex flex-wrap gap-1.5">${m.tags.map((t) => `<span class="badge badge-sm badge-outline">${esc(t)}</span>`).join('')}</div>
        <h1 class="mt-3 font-serif text-3xl font-semibold leading-tight sm:text-4xl">${esc(m.title)}</h1>
        <p class="mt-3 font-serif text-lg text-base-content/70">${esc(m.description)}</p>
        <div class="mt-5 flex flex-wrap gap-2">
          ${d.hasHtml ? `<a href="/e/${slug}/" class="btn btn-primary btn-sm">Open</a><a href="/e/${slug}/download" class="btn btn-sm">Download HTML</a>` : ''}
          <a href="/e/${slug}/source.mdx" class="btn btn-ghost btn-sm" target="_blank">MDX source</a>
        </div>
        ${m.statusDetail && m.status !== 'ready' ? `<div class="alert alert-warning mt-6 text-sm">${esc(m.statusDetail)}</div>` : ''}
        ${m.prompt ? `<h2 class="mt-8 text-xs font-semibold uppercase tracking-widest text-base-content/50">Prompt</h2><p class="mt-1 text-sm">${esc(m.prompt)}</p>` : ''}
        ${fc ? `
          <h2 class="mt-8 text-xs font-semibold uppercase tracking-widest text-base-content/50">Fact-check · ${fc.claimsChecked} claims · ${fc.findings.length} problem(s)${fc.findings.length ? (fc.fixed ? ' · fixed' : ' · <span class="text-warning">not fully resolved</span>') : ''}</h2>
          ${fc.summaries?.length ? `<ul class="mt-2 list-disc pl-5 text-sm text-base-content/70">${fc.summaries.map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
          ${fc.findings.length ? `<ul class="mt-3 space-y-2">${fc.findings.map((f: any) => `
            <li class="rounded-box border border-base-300 p-3 text-sm">
              <span class="badge badge-sm badge-warning">${esc(f.verdict)}</span> <q class="italic">${esc(f.quote)}</q>
              <p class="mt-1 text-base-content/70">${esc(f.explanation)}</p>
              ${f.correction ? `<p class="mt-1"><span class="font-semibold">Correction:</span> ${esc(f.correction)}</p>` : ''}
              ${f.sourceUrl ? `<a class="link mt-1 block truncate text-xs" href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">${esc(f.sourceUrl)}</a>` : ''}
            </li>`).join('')}</ul>` : ''}` : ''}
        ${d.sources.length ? `
          <h2 class="mt-8 text-xs font-semibold uppercase tracking-widest text-base-content/50">Sources read (${d.sources.length}; ${d.sourcesSeen} seen)</h2>
          <ul class="mt-2 space-y-1 text-sm">${d.sources.map((s: any) => `<li class="truncate"><a class="link link-hover" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="text-xs text-base-content/45">${esc(new URL(s.url).hostname)}</span></li>`).join('')}</ul>` : ''}
      </div>
      <aside class="space-y-6">
        <dl class="grid grid-cols-2 gap-x-3 gap-y-2 rounded-box border border-base-300 p-4 text-sm">
          ${[['Status', m.status.replace('-', ' ')], ['Depth', depthLabel(m.depth)], ['Level', m.level], ['Reading', m.readingMinutes ? `${m.readingMinutes} min` : ''], ['Words', m.words?.toLocaleString()], ['Citations', m.citations], ['Model', m.model], ['Created', m.createdAt ? new Date(m.createdAt).toLocaleString() : ''], ['Updated', timeAgo(m.updatedAt)]]
            .filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => `<dt class="text-base-content/55">${k}</dt><dd class="truncate" title="${esc(v)}">${esc(v)}</dd>`).join('')}
        </dl>
        <form id="revise-form" class="space-y-2">
          <label class="text-sm font-medium" for="instruction">Revise</label>
          <textarea id="instruction" rows="3" class="textarea w-full text-sm" placeholder="e.g. Add a section about QUIC and a quiz on congestion control"></textarea>
          <button class="btn btn-sm w-full">Queue revision</button>
        </form>
        <div class="grid gap-2">
          <button id="act-factcheck" class="btn btn-sm">Fact-check again</button>
          <button id="act-rebuild" class="btn btn-sm" title="Re-render the page from its MDX (after design updates)">Regenerate HTML</button>
          <button id="act-delete" class="btn btn-sm btn-outline btn-error">Delete</button>
        </div>
        ${d.jobs.length ? `<div><h2 class="mb-2 text-xs font-semibold uppercase tracking-widest text-base-content/50">Jobs</h2><ul class="space-y-1 text-sm">${d.jobs.map((j: Job) => `<li><a class="link link-hover" href="#/jobs/${j.id}">#${j.id} ${esc(j.type)}</a> <span class="badge badge-xs ${statusBadge[j.status]}">${j.status}</span> <span class="text-xs text-base-content/50">${timeAgo(j.createdAt)}</span></li>`).join('')}</ul></div>` : ''}
      </aside>
    </div>`;
  const post = async (url: string, json: object | undefined, msg: string) => {
    try { const j = await api(url, { method: 'POST', json }); toast(msg, 'success'); location.hash = `#/jobs/${j.id}`; } catch (err: any) { toast(err.message, 'error'); }
  };
  $('#revise-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const instruction = $<HTMLTextAreaElement>('#instruction').value.trim();
    if (instruction) post(`/api/explainers/${slug}/revise`, { instruction }, 'Revision queued');
  });
  $('#act-factcheck').addEventListener('click', () => post(`/api/explainers/${slug}/fact-check`, {}, 'Fact-check queued'));
  $('#act-rebuild').addEventListener('click', () => post(`/api/explainers/${slug}/rebuild`, {}, 'Rebuild queued'));
  $('#act-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${m.title}"? This removes its MDX, HTML, sources and reports.`)) return;
    try { await api(`/api/explainers/${slug}`, { method: 'DELETE' }); toast('Deleted', 'success'); location.hash = '#/'; } catch (err: any) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- live updates
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const h = location.hash || '#/';
    if (h === '#/' || h === '') { await loadExplainers().catch(() => {}); renderCards(); }
    else if (h === '#/jobs') renderJobs().catch(() => {});
  }, 400);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', (m) => {
    const { job } = JSON.parse((m as MessageEvent).data) as { job: Job };
    const i = state.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) state.jobs[i] = job; else state.jobs.unshift(job);
    updateHeader();
    if (state.liveJobId === job.id) liveJobUpdate?.(job);
    const e = state.explainers.find((x) => x.slug === job.slug);
    if (e) e.job = job;
    scheduleRefresh();
  });
  es.addEventListener('explainers', () => scheduleRefresh());
  es.addEventListener('event', (m) => {
    const { jobId, event } = JSON.parse((m as MessageEvent).data);
    if (jobId === state.liveJobId) liveSink?.(event);
  });
  es.onerror = () => { /* EventSource reconnects automatically */ };
}

// ---------------------------------------------------------------- theme + boot
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'ink' ? 'paper' : 'ink';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('explainer-theme', next); } catch { /* ignore */ }
});

loadJobs().catch(() => {});
connect();
route();
