import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.ts';

/** Names of the components exported from src/components/index.ts (parsed, so the list never drifts). */
export const COMPONENT_NAMES: string[] = (() => {
  const src = readFileSync(path.join(ROOT, 'src/components/index.ts'), 'utf8');
  const body = /export const components = \{([\s\S]*?)\}/.exec(src)?.[1] ?? '';
  return body.split(/[\s,]+/).filter(Boolean);
})();
