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
 * Склейка пути и спецификатора своим разбором, а не `node:path`: общий слой
 * проверяется ещё и сборкой renderer, где типов Node нет — импорт `node:path`
 * валил бы `tsconfig.renderer.json`.
 * Разделители — и `\`, и `/`: на Windows пути приходят с `\`, и деление по `'/'`
 * склеивало весь путь в один сегмент — тогда любой `./x` выглядел как выход из слоя.
 * Регистр диска и корень при этом не трогаем: сравнение идёт по сегментам.
 */
function pathResolve(fromFile: string, specifier: string): string {
  const segments = fromFile.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  segments.pop();
  for (const segment of specifier.split(/[\\/]/)) {
    if (segment === '..') segments.pop();
    else if (segment !== '' && segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Лежит ли разрешённый путь внутри `dir`.
 * Равенство путей нарушением не считается: импорт самой папки нам не нужен.
 */
function isInside(dir: string, target: string): boolean {
  const dirSegments = dir.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  const targetSegments = target.split('/');
  if (targetSegments.length <= dirSegments.length) return false;
  // На Windows регистр в путях не значим. Признак платформы берём из самого пути —
  // `process` в общем слое недоступен (рендерер собирается без типов Node).
  // Заглавная «C» диска под правило не попадает: колонка с `:` в имена папок не входит.
  const caseInsensitive = target.includes('\\');
  const normalize = (segment: string) => (caseInsensitive && !segment.endsWith(':') ? segment.toLowerCase() : segment);
  return dirSegments.every((segment, index) => normalize(segment) === normalize(targetSegments[index] ?? ''));
}
