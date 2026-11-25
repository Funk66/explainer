// Query-focused excerpts: split a page into passages and keep the ones most relevant to `focus`
// (BM25-style scoring, no LLM). Saves a lot of context compared to reading pages front to back.

const STOP = new Set('a an the of to and or in on for with by is are was were be been it its this that as at from how what why when which who into than then there their about between does do did can could would should may might not no yes also more most such these those over under per via vs'.split(' '));

const terms = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];

export function splitPassages(text: string, target = 900): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  let heading = '';
  for (const p of paras) {
    if (/^#{1,6} /.test(p) || /^\[page \d+\]/.test(p)) heading = p.split('\n')[0];
    if (cur && cur.length + p.length > target) { out.push(cur); cur = heading && !p.startsWith(heading) ? `${heading}\n…\n` : ''; }
    cur += (cur ? '\n\n' : '') + p;
    while (cur.length > target * 2) { out.push(cur.slice(0, target * 2)); cur = cur.slice(target * 2); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Returns the most relevant passages (in document order) fitting in maxChars. */
export function focusedExcerpts(text: string, focus: string, maxChars: number): { excerpt: string; used: number; total: number } {
  const passages = splitPassages(text);
  const q = [...new Set(terms(focus))];
  if (q.length === 0 || passages.length <= 1) return { excerpt: text.slice(0, maxChars), used: 1, total: passages.length };
  const docs = passages.map(terms);
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const N = docs.length;
  const scores = docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const tf = d.filter((w) => w === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    // Numbers are what we usually verify: small bonus for passages containing digits
    if (/\d/.test(passages[i])) s *= 1.1;
    return { i, s };
  });
  const picked: number[] = [];
  let size = 0;
  for (const { i, s } of [...scores].sort((a, b) => b.s - a.s)) {
    if (s <= 0) break;
    if (size + passages[i].length > maxChars && picked.length) continue;
    picked.push(i);
    size += passages[i].length + 10;
    if (size >= maxChars) break;
  }
  if (picked.length === 0) return { excerpt: '', used: 0, total: passages.length };
  picked.sort((a, b) => a - b);
  return { excerpt: picked.map((i) => passages[i]).join('\n\n[…]\n\n'), used: picked.length, total: passages.length };
}
