# AGENTS.md — Developing this project

This file is for coding agents (and humans) working **on the application**. If you were asked to _write an explainer_ (content), read [`agent/prompts/authoring-guide.md`](agent/prompts/authoring-guide.md) instead and stop here.

## What the project does

A prompt such as "explain X and its applicability to Y" and a **depth** (overview → comprehensive) go to an autonomous agent pipeline:

1. Research the topic on the web.
2. Write an MDX document using a library of pre-built components. Long explainers are outlined first and then written section by section.
3. Build each draft into a single self-contained HTML page and check it in a headless browser, fixing problems until the check passes.
4. Fact-check the claims with a fresh agent and fix what it finds.

A local OpenAI-compatible LLM does the work. The pipeline runs from the CLI or from a self-hosted web service with a persistent job queue.

## Architecture

```
agent/                         the explainer pipeline (no HTTP, no terminal)
  pipeline.ts                  generate / revise / recheck workflows (entry points used by CLI and server)
  loop.ts                      generic tool-calling agent loop: guards, compaction, retries, cancellation
  events.ts                    AgentEvent stream emitted by everything (CLI renders it, server streams it)
  workspace.ts                 explainer file tools: write/edit/read/finish → build + check + citation checks
  longform.ts                  deep/comprehensive: outline agent + one agent per section (resumable)
  factcheck.ts                 fact-check agents (per range) + fixer agent; factcheck.json
  depth.ts                     depth definitions (words, sections, visuals, mode)
  research/                    web_search (searxng | tavily chain), search_wikipedia, fetch_page (+PDF, focus)
  llm.ts                       streaming chat completions (OpenAI-compatible; no idle timeouts)
  config.ts                    config loading (EXPLAINER_CONFIG → <data>/config.json → explainer.config.json) + env overrides
  prompts/                     authoring-guide.md (content rules, shared) + one prompt per agent role
  cli.ts, terminal.ts, ui.ts   `npm run explain` front end
server/                        the self-hosted service (`npm start`)
  main.ts                      entry point
  app.ts                       Hono HTTP API + SSE + static UI + sandboxed explainer pages
  runner.ts                    single-worker job runner: one job at a time, retries, resume after restart, notifications
  db.ts                        SQLite (node:sqlite) jobs + coalesced event log
  explainers.ts, notify.ts     library listing/deletion, ntfy notifications
src/                           Astro project: renderer for explainers AND the web UI
  components/*.astro           MDX components; registered in components/index.ts (available without imports)
  layouts/Explainer.astro      explainer page shell
  pages/[slug].astro           explainer page; pages/app.astro + app/main.ts = web UI (vanilla TS SPA)
  styles/global.css            Tailwind 4 + daisyUI 5 themes "paper"/"ink"
  lib/                         client helpers, ECharts theme, remark/rehype plugins
scripts/
  build.ts                     validate MDX → astro build (one explainer) → inline into index.html
  check.ts                     Playwright render check
  rebuild.ts                   re-render explainers from MDX + refresh meta.json (no LLM)
  build-app.ts                 web UI → dist-app/index.html
  lib/                         paths (data layout), meta.json, inline.ts, validate-mdx.ts (footgun guard)
fixtures/showcase/             uses every component; `npm test` builds and checks it
data/                          runtime data (gitignored; /data volume in the container)
deploy/                        compose example (service + SearXNG)
Containerfile, .github/workflows/container.yml   image build (runs npm test) → GHCR on push to main
```

## Commands

```bash
npm install                 # also installs Playwright Chromium
npm test                    # build + render-check the showcase; run after any renderer/component change
npm run typecheck           # TypeScript check of agent/, scripts/, server/
npm run build:app           # build the web UI (needed before npm start; rerun after src/app or app.astro changes)
npm start                   # the service on :8080 (PORT to change)
npm run explain -- "…" [--depth deep]   # CLI pipeline
npm run build -- <slug>     # build one explainer (slug in data/explainers, fixtures/<name>, or a path)
npm run check -- <slug>     # render-check one explainer
npm run rebuild -- --all    # re-render everything (after design changes)
npm run dev                 # Astro dev server with all explainers in the data dir
```

## Conventions

- **TypeScript runs natively in Node** (type stripping): use `.ts` import extensions and only erasable syntax (no `enum`, no parameter properties, no namespaces).
- **Content authors never write HTML/CSS/JS.** Every capability is a component or a remark/rehype plugin. If authors keep making the same mistake, prefer a clearer error or a validation check over more prose in the guide.
- **Errors must be actionable for an LLM**: say what is wrong, where, and how to fix it (e.g. component prop validation throws `Error('<Quiz> needs options={[…]} with at least 2 entries')`, which surfaces as a build error).
- **Keep the model's context small**: tool results are concise; research results are compacted after use; prefer `focus` excerpts over full pages.
- Outgoing HTTP requests use a generic User-Agent; never send personal data to external services.

### Adding a component

1. Create `src/components/Name.astro`. Validate props in the frontmatter and `throw new Error(...)` with an actionable message.
2. Interactive components: root element gets `data-component="name" data-state="pending"`; call `markReady(el)` / `markError(el, msg)` from `src/lib/client.ts`. The checker waits for them and reports errors.
3. Colours come only from theme variables (`var(--color-primary)`, …). Libraries that need concrete colours use `cssColor()` / `mix()` and re-render on the `explainer:theme` event.
4. Markdown children: don't put `not-prose` on wrappers that contain the slot, because Tailwind Typography then drops list and paragraph styling. Put `not-prose` only on the component's own chrome (titles, buttons).
5. Register it in `src/components/index.ts` (this also allows it in the MDX validator), document it in `agent/prompts/authoring-guide.md` with an example, use it in `fixtures/showcase/index.mdx`, run `npm test`, and look at the screenshots in `fixtures/showcase/.check/`.
6. Props must be plain data: the validator (`scripts/lib/validate-mdx.ts`) rejects any non-literal expression in MDX. Anything evaluated in the browser (like `FunctionPlot` expressions) must be validated in the component.

### Adding a research provider

Implement `SearchProvider` (`agent/research/types.ts`) in its own file, add it to the provider switch in `agent/research/index.ts` and to the validation in `agent/config.ts`, and document it in the README. Providers return raw results; ranking, de-duplication and domain preferences are applied centrally.

### Adding an agent or workflow

Describe the agent as an `AgentSpec` and run it with `runAgent` (`agent/loop.ts`), which gives you streaming, events, the loop guards, context compaction, retries and cancellation. Put orchestration in `agent/pipeline.ts`, so the CLI and the job runner can both use it, and add a job type in `server/runner.ts` / `server/app.ts` if it should be available in the web app.

## Gotchas

- `katex` must stay pinned to the version `rehype-katex` depends on, otherwise CSS and HTML disagree (broken fractions).
- Astro 7 uses Sätteri by default; this project sets `markdown.processor: unified(...)` from `@astrojs/markdown-remark` so remark/rehype plugins work.
- The server listens on `::` (dual-stack). Listening only on `0.0.0.0` breaks `localhost` access through Docker Desktop's IPv6 port forwarding.
- Paid web searches are limited in three places: the explainer-wide cap (`setJobLimit`), per-agent budgets (`beginRun`), and the repeat guard. Keep new agents within these and call `beginRun` with a budget.
- The job runner must stay single-worker: the inference endpoint is usually one GPU, and builds of the same slug would race. Batch submission just creates several queued jobs.
- On shutdown the running job is left as "running" so `recoverInterrupted()` re-queues it on start. Long-form generations resume from `outline.json`.
- Explainer pages are served with `Content-Security-Policy: sandbox allow-scripts …` so their JavaScript can't call the API. Their `localStorage` access throws there, so always wrap it in try/catch.
- `scripts/lib/inline.ts` rewrites Rolldown's ``import(`./chunk.js`)`` to string imports and neutralises `__vite__mapDeps`; otherwise lazy chunks (Mermaid diagrams) would be fetched at runtime. `check.ts` fails on any network request, so regressions are caught by `npm test`.
- String replacement with untrusted content must use a replacer function (`s.replace(x, () => y)`), because `$'`/`$&` in CSS/JS would otherwise be expanded.
- Some local inference servers send tool-call arguments only once they are complete, which can mean minutes of silence. `agent/llm.ts` therefore disables undici's idle timeouts; keep it that way.
- Weaker local models can get stuck (e.g. calling the same tool forever). `agent/loop.ts` guards against this: it only offers tools that make sense in the current state, nudges after repeated identical calls, and offers only `write_explainer` once half the step budget has gone on research. Some servers (e.g. LM Studio-compatible ones) reject a named `tool_choice` and don't enforce `"required"`, so restricting the tool list is the reliable lever.
- The author's shell may have `noclobber` set: use `>|` when overwriting files from shell scripts.
