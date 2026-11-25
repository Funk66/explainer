// Fact-check pass: fresh-context agents verify the claims of a finished explainer against sources
// (one agent per range: the whole document, or each section of a long one), then a fixer agent
// applies corrections. The report is saved as factcheck.json.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib/paths.ts';
import type { Tool } from './llm.ts';
import { type AgentContext, runAgent } from './loop.ts';
import { RESEARCH_TOOL_NAMES } from './research/index.ts';
import { trimUrl } from './research/util.ts';
import type { Workspace } from './workspace.ts';
import { AUTHOR_TOOLS } from './workspace.ts';

export type Verdict = 'incorrect' | 'misattributed' | 'unsupported' | 'outdated' | 'misleading';
const VERDICTS: Verdict[] = ['incorrect', 'misattributed', 'unsupported', 'outdated', 'misleading'];

export interface Finding {
  quote: string;
  line?: number;
  verdict: Verdict;
  explanation: string;
  correction?: string;
  sourceUrl?: string;
  range: string;
}

export interface FactCheckReport {
  checkedAt: string;
  model: string;
  claimsChecked: number;
  summaries: string[];
  findings: Finding[];
  /** Whether the fixer pass completed with a passing build. */
  fixed: boolean;
}

export interface CheckRange { label: string; from: number; to: number }

const prompt = (name: string) => readFileSync(path.join(ROOT, 'agent/prompts', name), 'utf8');

const ALL_VERDICTS = ['supported', ...VERDICTS] as const;

const FACTCHECK_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'submit_verdicts',
      description: 'Submit your verdict for EVERY claim you checked (supported ones too), then you are done.',
      parameters: {
        type: 'object',
        properties: {
          claims: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quote: { type: 'string', description: 'The exact text of the claim as it appears in the document' },
                line: { type: 'number', description: 'Line number where it appears' },
                verdict: { type: 'string', enum: [...ALL_VERDICTS] },
                explanation: { type: 'string', description: 'For problems: what is wrong and what the evidence says (1–3 sentences). For supported claims: the source that confirms it.' },
                correction: { type: 'string', description: 'For problems: the corrected statement, if known' },
                source_url: { type: 'string', description: 'URL of the source you checked against' },
              },
              required: ['quote', 'verdict', 'explanation'],
            },
          },
          summary: { type: 'string', description: 'One sentence on the overall accuracy of this part' },
        },
        required: ['claims', 'summary'],
      },
    },
  },
];

/** Verify the claims in each range; returns all findings. */
export async function factCheck(ctx: AgentContext, ws: Workspace, opts: { ranges: CheckRange[]; claimsPerRange: number; model: string }): Promise<FactCheckReport> {
  const report: FactCheckReport = { checkedAt: new Date().toISOString(), model: opts.model, claimsChecked: 0, summaries: [], findings: [], fixed: false };
  const research = ws.research;
  const readTool = AUTHOR_TOOLS.find((t) => t.function.name === 'read_explainer')!;
  const minClaims = Math.min(4, opts.claimsPerRange);

  for (const [i, range] of opts.ranges.entries()) {
    const lines = ws.read().split('\n');
    const excerpt = lines.slice(range.from - 1, range.to).map((l, k) => `${String(range.from + k).padStart(4)} | ${l}`).join('\n');
    const headings = lines.map((l, k) => (/^##+ /.test(l) ? `${k + 1}: ${l}` : null)).filter(Boolean).join('\n');
    let finished = false;
    const sourcesList = research.sources.filter((s) => s.status === 'fetched').slice(0, 40).map((s) => `- ${s.title}: ${s.url}`).join('\n');
    // Small budget of paid searches: cited sources are cached, so checking them is mostly reading.
    research.beginRun(opts.ranges.length > 1 ? 4 : 8);
    // Footnotes in this range, with the facts we know about each URL (makes publisher/title mismatches visible).
    const footnotes = lines.slice(range.from - 1, range.to).filter((l) => /^\[\^[^\]]+\]:/.test(l)).map((l) => {
      const raw = /https?:\/\/\S+/.exec(l)?.[0];
      const url = raw ? trimUrl(raw) : undefined;
      if (!url) return `- ${l}`;
      const known = research.lookup(url);
      let host = '';
      try { host = new URL(url).hostname; } catch { /* keep empty */ }
      return `- ${l}\n    → URL host: ${host}${known ? `; page title seen in research: "${known.title}"` : '; this URL never came up in research'}`;
    });

    const run = await runAgent(ctx, {
      name: opts.ranges.length > 1 ? `fact-check ${i + 1}/${opts.ranges.length}` : 'fact-check',
      system: prompt('factcheck.md'),
      user: `Fact-check this part of the explainer: **${range.label}** (lines ${range.from}–${range.to}). Check the ${opts.claimsPerRange} most important claims (fewer if the part is short), including every footnote citation in it.\n\n` +
        `Document outline (for context):\n${headings}\n\n` +
        (sourcesList ? `Sources the author consulted (you may re-read them; pages are cached):\n${sourcesList}\n\n` : '') +
        `Text to check:\n\n${excerpt}\n\n` +
        (footnotes.length ? `Footnotes in this part, with what we know about each URL (check that the title/publisher in the footnote matches the actual site and page, and that the page supports the claims citing it):\n${footnotes.join('\n')}\n\n` : '') +
        (research.enabled ? '' : 'No research tools are available: judge from well-established knowledge and mark claims you cannot assess as unsupported only if they look doubtful.'),
      maxSteps: ctx.cfg.factCheck.maxSteps,
      researchBudget: 0.75,
      tools: () => [...research.tools(), readTool, ...FACTCHECK_TOOLS],
      outputTools: () => FACTCHECK_TOOLS,
      outputNudge: 'Stop researching: call submit_verdicts now with a verdict for every claim you checked.',
      hasOutput: () => finished,
      isDone: () => finished,
      nextHint: () => 'Check the next claim with fetch_page/search, or call submit_verdicts with all your verdicts when done.',
      describeCall: (name, a) => (name === 'submit_verdicts' ? `(${Array.isArray(a?.claims) ? a.claims.length : 0} claims, ${Array.isArray(a?.claims) ? a.claims.filter((c: any) => c?.verdict && c.verdict !== 'supported').length : 0} problem(s))` : ''),
      runTool: async (name, raw) => {
        let a: any;
        try { a = JSON.parse(raw || '{}'); } catch (err: any) { return `ERROR: invalid JSON arguments (${err.message})`; }
        if (RESEARCH_TOOL_NAMES.has(name)) return research.run(name, a);
        if (name === 'read_explainer') return ws.readNumbered(a.from_line, a.to_line);
        if (name === 'submit_verdicts') {
          const claims = Array.isArray(a.claims) ? a.claims : [];
          const bad = claims.findIndex((c: any) => !c?.quote || !ALL_VERDICTS.includes(c.verdict) || (c.verdict !== 'supported' && !c.explanation));
          if (bad >= 0) return `ERROR: claim #${bad + 1} needs quote, verdict (${ALL_VERDICTS.join('|')}) and, for problems, an explanation. Nothing was recorded; submit again.`;
          if (claims.length < minClaims && range.to - range.from > 15) return `ERROR: only ${claims.length} claim(s). Check at least ${minClaims} of the most important claims (numbers, names, dates, mechanisms, citations) before submitting.`;
          for (const c of claims) {
            if (c.verdict === 'supported') continue;
            report.findings.push({ quote: String(c.quote), line: c.line ? Number(c.line) : undefined, verdict: c.verdict, explanation: String(c.explanation), correction: c.correction ? String(c.correction) : undefined, sourceUrl: c.source_url ? String(c.source_url) : undefined, range: range.label });
          }
          report.claimsChecked += claims.length;
          if (a.summary) report.summaries.push(`${range.label}: ${a.summary}`);
          finished = true;
          return 'OK — verdicts recorded.';
        }
        return `ERROR: unknown tool ${name}`;
      },
    });
    if (!run.done) ctx.emit({ type: 'note', level: 'warn', text: `fact-check of "${range.label}" ended without submitting verdicts (${run.reason})` });
  }
  ctx.emit({ type: 'note', level: report.findings.length ? 'warn' : 'info', text: `fact-check: ${report.claimsChecked} claims checked, ${report.findings.length} problem(s) found` });
  return report;
}

/** Ask a fixer agent to resolve the findings (and any build/check issues). Returns true if it finished with a passing check. */
export async function fixFindings(ctx: AgentContext, ws: Workspace, findings: Finding[], guide: string, extra = ''): Promise<boolean> {
  if (findings.length === 0 && !extra) return true;
  const fileLines = ws.read().split('\n');
  const context = (f: Finding) => {
    // Locate the quote (or fall back to the reported line) and show the surrounding lines verbatim.
    const probe = f.quote.slice(0, 60);
    let at = fileLines.findIndex((l) => l.includes(probe));
    if (at < 0 && f.line) at = f.line - 1;
    if (at < 0) return '';
    const from = Math.max(0, at - 2);
    return `\n   Current text (lines ${from + 1}–${Math.min(fileLines.length, at + 3)}):\n${fileLines.slice(from, at + 3).map((l, k) => `   ${String(from + k + 1).padStart(4)} | ${l}`).join('\n')}`;
  };
  const list = findings.map((f, i) => `${i + 1}. [${f.verdict}] "${f.quote}"\n   Problem: ${f.explanation}${f.correction ? `\n   Suggested correction: ${f.correction}` : ''}${f.sourceUrl ? `\n   Evidence: ${f.sourceUrl}` : ''}${context(f)}`).join('\n\n');
  ws.finished = false;
  ws.research.beginRun(Math.max(8, findings.length * 3));
  const run = await runAgent(ctx, {
    name: 'fix',
    system: prompt('fixer.md').replace('{{AUTHORING_GUIDE}}', () => guide),
    user: `${findings.length ? `The fact-checker reported these problems in explainers/${ws.slug}/index.mdx:\n\n${list}\n\n` : ''}${extra}\n\nFix them with edit_explainer (read the relevant lines first), make sure the check passes, then call finish.`,
    maxSteps: ctx.cfg.factCheck.maxSteps,
    researchBudget: 1,
    tools: () => ws.tools.filter((t) => t.function.name !== 'write_explainer'),
    outputTools: () => ws.tools,
    outputNudge: '',
    hasOutput: () => true,
    isDone: () => ws.finished,
    nextHint: () => (ws.passed ? 'Call finish if all problems are handled.' : 'Fix the remaining problems with edit_explainer.'),
    compactAfter: ['edit_explainer'],
    describeCall: (name, a) => (name === 'edit_explainer' ? `(${a?.edits?.length ?? 0} edit(s))` : ''),
    runTool: (name, raw) => ws.run(name, raw),
  });
  return run.done && ws.passed;
}

export function saveReport(file: string, report: FactCheckReport) {
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}
