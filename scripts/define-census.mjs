import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
const file = process.argv[2] ?? 'src/renderer/app.ts';
const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
const G = new Set(
  'document window console JSON Math Object Array Promise Set Map String Number Boolean Error Date RegExp undefined globalThis setTimeout clearTimeout requestAnimationFrame localStorage HTMLElement Event KeyboardEvent MouseEvent navigator fetch parseInt parseFloat isNaN structuredClone queueMicrotask AbortController CustomEvent ResizeObserver FileList DataTransfer'.split(
    ' ',
  ),
);
const nm = (p, s) => {
  if (!p) return;
  if (p.type === 'Identifier') s.add(p.name);
  else if (p.type === 'ObjectPattern')
    p.properties.forEach((q) => {
      nm(q.type === 'RestElement' ? q.argument : q.value, s);
    });
  else if (p.type === 'ArrayPattern')
    p.elements.forEach((q) => {
      nm(q, s);
    });
  else if (p.type === 'RestElement') nm(p.argument, s);
  else if (p.type === 'AssignmentPattern') nm(p.left, s);
  else if (p.type === 'TSAsExpression') nm(p.expression, s);
};
const loc = (fn) => {
  const s = new Set();
  (function w(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n))
      return n.forEach((x) => {
        w(x);
      });
    if (n.type === 'VariableDeclarator') nm(n.id, s);
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) s.add(n.id.name);
    if (n.type === 'CatchClause') nm(n.param, s);
    if (/Function/.test(n.type) && n.params)
      n.params.forEach((p) => {
        nm(p, s);
      });
    for (const k in n) if (k !== 'loc') w(n[k]);
  })(fn);
  return s;
};
const rows = [];
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n))
    return n.forEach((x) => {
      walk(x);
    });
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['define', 'command'].includes(n.callee.name)) {
    const o = n.arguments[0];
    let title = '';
    if (o && o.type === 'ObjectExpression') {
      const p = o.properties.find((p) => (p.key?.name || p.key?.value) === 'id');
      if (p?.value) title = p.value.value ?? p.value.name ?? '';
    }
    const fn = n.arguments.find((a) => /Function/.test(a.type));
    if (fn) {
      const L = loc(fn);
      const free = new Set();
      (function w(m, par, key) {
        if (!m || typeof m !== 'object') return;
        if (Array.isArray(m))
          return m.forEach((x) => {
            w(x, par, key);
          });
        if (m.type === 'Identifier' && !L.has(m.name) && !G.has(m.name)) {
          const prop =
            par &&
            ((par.type === 'MemberExpression' && key === 'property' && !par.computed) ||
              (par.type === 'ObjectProperty' && key === 'key' && !par.computed));
          if (!prop) free.add(m.name);
        }
        for (const k in m) if (k !== 'loc') w(m[k], m, k);
      })(fn, null, null);
      rows.push({ title, line: n.loc.start.line, end: n.loc.end.line, names: [...free].sort() });
    }
  }
  for (const k in n) if (k !== 'loc') walk(n[k]);
})(ast.program.body);
const fam = process.argv[3] ?? '';
for (const r of rows.filter((r) => r.title.startsWith(fam)).sort((a, b) => a.line - b.line))
  console.log(`${r.line}-${r.end} (${r.end - r.line + 1})\t${r.title}\t${r.names.join(',')}`);
const un = new Set();
rows
  .filter((r) => r.title.startsWith(fam))
  .forEach((r) => {
    for (const n of r.names) un.add(n);
  });
console.log(
  `\nсемейство "${fam}": блоков ${rows.filter((r) => r.title.startsWith(fam)).length}, имён всего ${un.size}`,
);
