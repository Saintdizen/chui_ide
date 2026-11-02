/**
 * Граница общего слоя: `src/shared` собирается и в Node (main), и в браузер
 * (renderer), и импортируется тестами. Из него нельзя тянуть `electron`, `node:fs`
 * или код соседних слоёв — иначе ломается сборка того слоя, который заметит это
 * первым, и заметит её не тот, кто сломал.
 *
 * Здесь только правила, без файловой системы: поэтому функцию можно проверить
 * тестом на строках, а не на настоящем дереве.
 */

/** Пакеты Node, которых в браузерном слое нет. `node:`-префикс проверяется отдельно. */
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'console',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'process',
  'querystring',
  'readline',
  'stream',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

export interface LayerContext {
  /** Имена пакетов проекта: их тянуть из общего слоя можно только осознанно. */
  deps: ReadonlySet<string>;
  /** Абсолютный путь к `src/shared` — по нему считается выход из слоя. */
  sharedDir: string;
}

/**
 * Нарушение границы в одном импорте или `null`, если импорт допустим.
 * Сообщение сразу говорит, что делать, а не только что сломалось.
 */
export function checkSharedImport(file: string, specifier: string, context: LayerContext): string | null {
  if (specifier.startsWith('.')) {
    // `path.resolve` сам схлопывает `..`: импорт внутри `shared` остаётся внутри,
    // а `../../main/x` из `shared/lsp/y.ts` даёт путь вне `sharedDir`.
    const target = pathResolve(file, specifier);
    if (isInside(context.sharedDir, target)) return null;
    return `${specifier}: общий слой не может зависеть от main или renderer — вынеси общее в src/shared`;
  }

  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  const [name = ''] = bare.split('/');
  if (specifier.startsWith('node:') || NODE_BUILTINS.includes(name)) {
    return `${specifier}: модуль Node не работает в renderer — принимай его через интерфейс, а реализацию оставь в src/main`;
  }
  if (context.deps.has(name)) {
    return `${specifier}: пакет проекта в общем слое — проверь, что он без Node и DOM, иначе он не поднимется в renderer`;
  }
  return null;
}

/**
 * Склейка пути и спецификатора без `node:path`: общий код не имеет права тянуть
 * модуль Node, даже ради проверки, которая как раз это и запрещает.
 * Достаточно разрешить `.` и `..` — символических ссылок в `src` нет.
 */
function pathResolve(fromFile: string, specifier: string): string[] {
  const segments = fromFile.split('/');
  segments.pop();
  // Корень `/` в начале — тоже сегмент: без него относительный путь сравнивался бы
  // с `sharedDir` со сдвигом на один уровень, и `./x` считался бы выходом из слоя.
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments;
}

/**
 * Лежит ли разрешённый путь внутри `dir`. `target` — сегменты абсолютного пути,
 * `dir` — абсолютный путь как строка; сравниваем по сегментам.
 */
function isInside(dir: string, target: readonly string[]): boolean {
  const base = dir.split('/');
  if (target.length <= base.length) return false;
  return base.every((segment, index) => target[index] === segment);
}
