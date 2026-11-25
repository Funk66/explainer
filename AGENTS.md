# AGENTS.md — Developing this project

This file is for coding agents (and humans) working **on the application**. If you were asked to *write an explainer* (content), read [`agent/prompts/authoring-guide.md`](agent/prompts/authoring-guide.md) instead and stop here.

## What the project does

A prompt such as "explain X and its applicability to Y" goes to an autonomous writing agent. The agent researches the topic on the web, writes an MDX document using a library of pre-built components, and builds it into a single self-contained HTML page. A headless browser checks that page, and the agent fixes problems until the check passes. A local OpenAI-compatible LLM endpoint does the writing. The roadmap (a self-hosted web service with a job queue, depth control and fact-checking) and the status of each feature are in [`docs/PLAN.md`](docs/PLAN.md). **Update its status markers when you complete or start a feature.**

## Layout

```
explainer.config.json        runtime configuration (LLM endpoint/model, agent limits, research providers)
agent/
  cli.ts                     `npm run explain`: argument parsing, the agent loop, context compaction, logging
  config.ts                  config loading, defaults, env overrides, validation
  llm.ts                     streaming chat completions with tool calls (OpenAI-compatible, no idle timeouts)
  tools.ts                   Workspace: write/edit/read/finish tools; every write → build + check + citation validation
  research/                  web_search (searxng | tavily, fallback chain), search_wikipedia, fetch_page
    fetch-page.ts            HTML → readable text (Readability + linkedom), PDFs (unpdf), Tavily/Jina fallbacks
    focus.ts                 query-focused passage ranking (BM25-style) for fetch_page(focus)
    index.ts                 Research class: tool definitions, provider chain, page cache, source ledger
  prompts/system.md          writer system prompt (process, tool usage); {{AUTHORING_GUIDE}} is replaced by…
  prompts/authoring-guide.md …the content guide: writing rules, MDX pitfalls, component reference, citations
scripts/
  build.ts                   astro build for one slug → inline into explainers/<slug>/<slug>.html
  check.ts                   Playwright render check (errors, network, components, KaTeX, overflow, stats)
  lib/inline.ts              Astro output → single HTML (CSS inline, assets as data URIs, JS re-bundled by esbuild)
src/
  components/*.astro         MDX components; registered in components/index.ts (available without imports)
  layouts/Explainer.astro    page shell (header, TOC, theme toggle, progress bar)
  styles/global.css          Tailwind 4 + daisyUI 5 themes "paper"/"ink", typography, footnotes
  lib/                       client helpers (markReady/markError, theme colours), remark/rehype plugins
explainers/<slug>/           content: index.mdx (source of truth), <slug>.html (built), sources.json, agent-log.jsonl
explainers/showcase/         fixture using every component; `npm test` builds and checks it
docs/PLAN.md                 roadmap + status
```

## Commands

```bash
npm install                 # also installs Playwright Chromium
npm test                    # build + render-check the showcase; run after any renderer/component change
npm run build -- <slug>     # build one explainer (add --open to open it)
npm run check -- <slug>     # render-check one explainer
npm run explain -- "…"      # run the writing agent (needs the LLM endpoint from explainer.config.json)
npm run dev                 # Astro dev server with all explainers
```

Typecheck the Node side (there is no build step; Node ≥ 23.6 runs TypeScript directly):

```bash
npx tsc --ignoreConfig --noEmit --strict --module nodenext --moduleResolution nodenext --target es2024 \
  --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck --types node \
  agent/*.ts agent/research/*.ts scripts/*.ts scripts/lib/*.ts
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
5. Register it in `src/components/index.ts`, document it in `agent/prompts/authoring-guide.md` with an example, use it in `explainers/showcase/index.mdx`, run `npm test`, and look at the screenshots in `explainers/showcase/.check/`.

### Adding a research provider

Implement `SearchProvider` (`agent/research/types.ts`) in its own file, add it to the provider switch in `agent/research/index.ts` and to the validation in `agent/config.ts`, and document it in the README. Providers return raw results; ranking, de-duplication and domain preferences are applied centrally.

## Gotchas

- `katex` must stay pinned to the version `rehype-katex` depends on, otherwise CSS and HTML disagree (broken fractions).
- Astro 7 uses Sätteri by default; this project sets `markdown.processor: unified(...)` from `@astrojs/markdown-remark` so remark/rehype plugins work.
- `scripts/lib/inline.ts` rewrites Rolldown's ``import(`./chunk.js`)`` to string imports and neutralises `__vite__mapDeps`; otherwise lazy chunks (Mermaid diagrams) would be fetched at runtime. `check.ts` fails on any network request, so regressions are caught by `npm test`.
- String replacement with untrusted content must use a replacer function (`s.replace(x, () => y)`), because `$'`/`$&` in CSS/JS would otherwise be expanded.
- Some local inference servers send tool-call arguments only once they are complete, which can mean minutes of silence. `agent/llm.ts` therefore disables undici's idle timeouts; keep it that way.
- Weaker local models can get stuck (e.g. calling the same tool forever). `agent/cli.ts` guards against this: it only offers tools that make sense in the current state, nudges after repeated identical calls, and offers only `write_explainer` once half the step budget has gone on research. Some servers (e.g. LM Studio-compatible ones) reject a named `tool_choice` and don't enforce `"required"`, so restricting the tool list is the reliable lever.
- The author's shell may have `noclobber` set: use `>|` when overwriting files from shell scripts.
