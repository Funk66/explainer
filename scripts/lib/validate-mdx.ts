// Footgun guard: MDX `{…}` expressions are JavaScript that runs at build time (in Node, with file
// system access). Explainers only ever need literal values, so anything else is rejected before
// Astro sees the file. This also catches common authoring mistakes with clear, line-numbered messages.
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { COMPONENT_NAMES } from './components.ts';

const ALLOWED_IDENTIFIERS = new Set(['undefined', 'Infinity', 'NaN']);

export function validateMdx(source: string): string[] {
  // Blank out the frontmatter but keep line numbers stable.
  const fm = /^---\n[\s\S]*?\n---\n/.exec(source);
  const text = fm ? fm[0].replace(/[^\n]/g, '') + source.slice(fm[0].length) : source;

  let tree: any;
  try {
    tree = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(remarkMath).parse(text);
  } catch (err: any) {
    const where = err?.place?.start?.line ?? err?.line;
    return [`${where ? `line ${where}: ` : ''}${err?.reason ?? err?.message ?? String(err)}`];
  }

  const problems: string[] = [];
  const at = (node: any) => `line ${node?.position?.start?.line ?? '?'}`;

  visit(tree, (node: any) => {
    switch (node.type) {
      case 'mdxjsEsm':
        problems.push(`${at(node)}: import/export statements are not allowed — all components are available without imports.`);
        break;
      case 'mdxFlowExpression':
      case 'mdxTextExpression': {
        const v = String(node.value ?? '').trim();
        if (v === '' || /^\/\*[\s\S]*\*\/$/.test(v)) break; // {/* comment */}
        problems.push(`${at(node)}: "{${v.slice(0, 40)}}" is a JavaScript expression in the text. If you meant literal braces, escape them as \\{ and \\} (or put them in \`inline code\` or $math$).`);
        break;
      }
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const name: string | null = node.name;
        if (!name) { problems.push(`${at(node)}: fragments (<>…</>) are not allowed.`); break; }
        if (!COMPONENT_NAMES.includes(name)) {
          problems.push(/^[a-z]/.test(name)
            ? `${at(node)}: <${name}> is raw HTML, which is not allowed. Use Markdown or a component instead.`
            : `${at(node)}: <${name}> is not an available component. Available: ${COMPONENT_NAMES.join(', ')}.`);
        }
        for (const attr of node.attributes ?? []) {
          if (attr.type === 'mdxJsxExpressionAttribute') {
            problems.push(`${at(node)}: <${name} {…}> spread attributes are not allowed; write each prop explicitly.`);
            continue;
          }
          const v = attr.value;
          if (v && typeof v === 'object' && v.type === 'mdxJsxAttributeValueExpression') {
            const program = v.data?.estree;
            const expr = program?.body?.[0]?.expression;
            if (!expr || program.body.length !== 1) {
              problems.push(`${at(node)}: <${name} ${attr.name}={…}> must contain a single literal value.`);
              continue;
            }
            const bad = nonLiteral(expr);
            if (bad) problems.push(`${at(node)}: <${name} ${attr.name}={…}> contains ${bad}. Only literal values are allowed (strings, numbers, booleans, null, arrays and objects of those).`);
          }
        }
        break;
      }
    }
  });
  return problems;
}

/** Returns a description of the first non-literal construct, or null if the expression is pure data. */
function nonLiteral(n: any): string | null {
  switch (n?.type) {
    case 'Literal':
      return n.regex ? 'a regular expression' : null;
    case 'TemplateLiteral':
      return n.expressions.length ? 'a template string with ${…} interpolation' : null;
    case 'ArrayExpression':
      for (const el of n.elements) {
        if (!el) continue;
        if (el.type === 'SpreadElement') return 'a spread (...)';
        const bad = nonLiteral(el);
        if (bad) return bad;
      }
      return null;
    case 'ObjectExpression':
      for (const p of n.properties) {
        if (p.type !== 'Property') return 'a spread (...)';
        if (p.kind !== 'init' || p.method) return 'a method or getter';
        if (p.computed) return 'a computed key ([…])';
        const bad = nonLiteral(p.value);
        if (bad) return bad;
      }
      return null;
    case 'UnaryExpression':
      return (n.operator === '-' || n.operator === '+') && n.argument?.type === 'Literal' && typeof n.argument.value === 'number' ? null : `the operator "${n.operator}"`;
    case 'Identifier':
      return ALLOWED_IDENTIFIERS.has(n.name) ? null : `the variable "${n.name}" (quote it if it is meant as text)`;
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return 'a function';
    case 'CallExpression':
    case 'NewExpression':
      return 'a function call';
    case 'MemberExpression':
      return 'a property access (a.b)';
    case 'BinaryExpression':
      return `arithmetic/comparison (${n.operator}) — compute the value and write the number`;
    default:
      return `a ${n?.type ?? 'non-literal'} expression`;
  }
}
