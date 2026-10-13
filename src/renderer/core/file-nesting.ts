/**
 * Свёртывание связанных файлов под родителя (file nesting).
 *
 * В папке рядом лежат `Button.tsx`, `Button.module.css`, `Button.test.tsx`,
 * `Button.stories.tsx` — четыре строки об одном. Вложение прячет спутников под
 * родителя: в дереве остаётся `Button.tsx`, а под ним (отступом) — остальные.
 *
 * Правила — пары шаблонов вида `*.tsx: *.test.tsx, *.module.css`. Пара срабатывает,
 * когда и родитель, и спутник начинаются с одного и того же «корня»: `Button`
 * у `Button.tsx` и `Button.test.tsx`. Шаблон `*` в начале означает «корень, затем
 * этот хвост» — так задаются и расширения, и суффиксы. Логика чистая, поэтому
 * проверяется тестами, а проводнику остаётся расстановка строк.
 */

export interface NestingRule {
  /** Шаблон родителя, например `*.tsx`. */
  readonly parent: string;
  /** Шаблон спутника, например `*.test.tsx`. */
  readonly child: string;
}

/**
 * Правила по умолчанию — привычные спутники из экосистем JS/TS и Python: стили,
 * тесты, истории, карты исходников и типы. Их можно заменить своими в настройках.
 */
export const DEFAULT_NESTING_RULES: readonly NestingRule[] = [
  { parent: '*.tsx', child: '*.test.tsx' },
  { parent: '*.tsx', child: '*.spec.tsx' },
  { parent: '*.tsx', child: '*.stories.tsx' },
  { parent: '*.tsx', child: '*.module.css' },
  { parent: '*.tsx', child: '*.module.scss' },
  { parent: '*.tsx', child: '*.css' },
  { parent: '*.ts', child: '*.test.ts' },
  { parent: '*.ts', child: '*.spec.ts' },
  { parent: '*.ts', child: '*.stories.ts' },
  { parent: '*.ts', child: '*.d.ts' },
  { parent: '*.js', child: '*.test.js' },
  { parent: '*.js', child: '*.spec.js' },
  { parent: '*.js', child: '*.map' },
  { parent: '*.jsx', child: '*.test.jsx' },
  { parent: '*.jsx', child: '*.module.css' },
  { parent: '*.py', child: 'test_*.py' },
  { parent: '*.go', child: '*_test.go' },
  { parent: '*.rb', child: '*_spec.rb' },
];

/** Разобрать одну строку правил: `*.tsx: *.test.tsx, *.module.css`. */
function parseRuleLine(line: string): NestingRule[] {
  const colon = line.indexOf(':');
  if (colon < 0) return [];
  const parent = line.slice(0, colon).trim();
  if (parent === '') return [];
  return line
    .slice(colon + 1)
    .split(',')
    .map((child) => child.trim())
    .filter((child) => child !== '')
    .map((child) => ({ parent, child }));
}

/**
 * Правила из настроек. Пустой список (или список без годных строк) означает «нет
 * своих правил», и вызывающий берёт правила по умолчанию; так опечатка в настройке
 * не отключает вложение молча.
 */
export function parseNestingRules(lines: readonly string[]): NestingRule[] {
  return lines.flatMap((line) => parseRuleLine(line));
}

/** Действующие правила: свои из настроек, а если их нет — по умолчанию. */
export function effectiveNestingRules(configured: readonly string[]): readonly NestingRule[] {
  const own = parseNestingRules(configured);
  return own.length > 0 ? own : DEFAULT_NESTING_RULES;
}

/**
 * Корень имени под шаблоном: `Button` для `Button.test.tsx` и `*.test.tsx`.
 *
 * Звёздочка — одна, в любом месте: у `*.test.tsx` она в начале (хвост-расширение),
 * у `test_*.py` — в середине (префикс и расширение), у `*_test.go` — в начале, но
 * с длинным хвостом. Пустой корень не годится: имя не может совпасть с шаблоном
 * целиком и стать «родителем без имени».
 */
function rootFor(name: string, pattern: string): string | null {
  const star = pattern.indexOf('*');
  // Шаблон без звёздочки — точное имя: корень пустой, совпадение цельное.
  if (star < 0) return name === pattern ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  if (name.length <= prefix.length + suffix.length) return null;
  const root = name.slice(prefix.length, name.length - suffix.length);
  return root === '' ? null : root;
}

export interface Nesting {
  /** Имя родителя → имена спутников (в порядке исходного списка). */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Спутники, которые отдельной строкой не рисуются. */
  readonly hidden: ReadonlySet<string>;
}

/**
 * Разложить имена файлов папки по правилам. Каждый спутник достаётся ПЕРВОМУ
 * подходящему родителю: если рядом `Button.tsx` и `Button.jsx` со спутником
 * `Button.module.css`, он уйдёт под того, кто раньше в списке (то есть выше в дереве).
 */
export function nestEntries(names: readonly string[], rules: readonly NestingRule[]): Nesting {
  const children = new Map<string, string[]>();
  const hidden = new Set<string>();

  for (const { parent, child } of rules) {
    for (const name of names) {
      if (hidden.has(name)) continue;
      const root = rootFor(name, child);
      if (root === null) continue;
      // Родитель — первый файл с тем же корнем под шаблоном родителя.
      const host = names.find((other) => {
        if (other === name || hidden.has(other)) return false;
        return rootFor(other, parent) === root;
      });
      if (!host || hidden.has(host)) continue;
      // Спутник не может быть и родителем: `Button.d.ts` под `Button.ts` — и точка.
      const list = children.get(host) ?? [];
      if (!list.includes(name)) list.push(name);
      children.set(host, list);
      hidden.add(name);
    }
  }

  // Спутники идут в порядке строк дерева, а не порядка правил: так дерево читается.
  for (const [host, list] of children) {
    const order = new Map(names.map((name, index) => [name, index]));
    children.set(
      host,
      [...list].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    );
  }

  return { children, hidden };
}
