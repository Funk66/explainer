// How much detail an explainer gets. Short depths are written in one pass; long ones are planned as an
// outline and written section by section, so no single model call has to hold the whole document.
import type { Depth } from '../scripts/lib/meta.ts';

export type { Depth } from '../scripts/lib/meta.ts';

export interface DepthSpec {
  label: string;
  minutes: number;
  words: [number, number];
  sections: [number, number];
  visuals: string;
  quizzes: string;
  mode: 'single' | 'sections';
  /** Claims the fact-checker verifies per checked range (the whole doc, or each section). */
  factCheckClaims: number;
  brief: string;
}

export const DEPTHS: Record<Depth, DepthSpec> = {
  overview: {
    label: 'Overview', minutes: 5, words: [700, 1300], sections: [3, 5], visuals: '1–2', quizzes: '1', mode: 'single', factCheckClaims: 12,
    brief: "A bird's-eye view: the core idea, why it matters, how it works at a high level, one concrete example. Skip edge cases and internals.",
  },
  standard: {
    label: 'Standard', minutes: 15, words: [2200, 3500], sections: [6, 9], visuals: '3–5', quizzes: '2–4', mode: 'single', factCheckClaims: 20,
    brief: 'A solid explanation: intuition, the precise mechanism, worked examples, common misconceptions and practical applicability.',
  },
  deep: {
    label: 'Deep dive', minutes: 30, words: [5000, 7500], sections: [8, 12], visuals: '6–10', quizzes: '4–6', mode: 'sections', factCheckClaims: 12,
    brief: 'An in-depth treatment: internals, the relevant protocols/algorithms/standards in detail, trade-offs, failure modes, history where it explains design decisions, and several worked examples.',
  },
  comprehensive: {
    label: 'Comprehensive', minutes: 60, words: [10000, 14000], sections: [12, 18], visuals: '10–16', quizzes: '6–10', mode: 'sections', factCheckClaims: 12,
    brief: 'A comprehensive reference-quality guide: everything in a deep dive, plus advanced topics, variants and alternatives, performance considerations, real-world case studies and a path for further study.',
  },
};

export const DEPTH_NAMES = Object.keys(DEPTHS) as Depth[];

export function depthBrief(d: Depth): string {
  const s = DEPTHS[d];
  return `Depth: **${s.label}** (about ${s.minutes} minutes of reading). ${s.brief}\nTarget length: ${s.words[0].toLocaleString('en')}–${s.words[1].toLocaleString('en')} words in ${s.sections[0]}–${s.sections[1]} sections, with ${s.visuals} visuals (diagrams/charts/interactive plots) and ${s.quizzes} quiz question(s).`;
}
