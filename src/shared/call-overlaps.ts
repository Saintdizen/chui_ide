/**
 * Пересечения вызовов инструментов.
 *
 * Точно дублей имён уже нет (`tool-aliases.ts` свёртывает `read_file` и прочие), а
 * переплата остаётся на уровне смысла: агент может попросить найти одно объявление
 * и через `search(action=code)`, и через `lsp(action=definition)` — оба ответа приедут
 * одинаково близко и оба останутся в контексте.
 *
 * Здесь чистые правила, которые только РАЗМЕЧАЮТ такие пары внутри одного шага и
 * повторы одного вызова. Правку вызовов делает `ai/service.ts` (там есть контекст
 * беседы и покрытие чтения), а здесь — часть для переписей и счётчика шагов:
 * без текста аргументов можно показать «похожих вызовов — N».
 */

/** Какой запасной/дублирующий путь модель позвала следом. */
export type CallOverlapKind =
  /** `search(action=code)` рядом с `lsp(action=definition|references)`. */
  | 'search-lsp'
  /** `run_tests` рядом с командой тест-раннера в `terminal`. */
  | 'terminal-tests'
  /** `checks(action=lint)` рядом с командой линтера в `terminal`. */
  | 'terminal-lints'
  /** `web(action=fetch)` рядом с `browser(action=open|snapshot)`. */
  | 'web-browser'
  /** `file(action=replace)` рядом с правкой по якорю `edit`. */
  | 'file-edit'
  /** `list` рядом с `project_map`: два общих обзора проекта. */
  | 'list-project_map';

export interface CallOverlap {
  /** Индекс первого вызова в массиве шага. */
  a: number;
  /** Индекс второго вызова в массиве шага. */
  b: number;
  kind: CallOverlapKind;
}

export interface OverlapCall {
  name: string;
  /** Сырые аргументы, как их прислала модель (JSON-строка). */
  arguments: string;
}

/** Нормальная форма аргументов: ключи объектов по алфавиту, массивы — как есть. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw.trim() || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function actionOf(call: OverlapCall): string {
  return text(parseArgs(call.arguments).action);
}

function commandOf(call: OverlapCall): string {
  return text(parseArgs(call.arguments).command);
}

function labelOf(call: OverlapCall): string {
  const args = parseArgs(call.arguments);
  if (typeof args.symbol === 'string' && args.symbol.trim()) return `symbol ${text(args.symbol)}`;
  if (typeof args.query === 'string' && args.query.trim()) return `query ${text(args.query)}`;
  if (typeof args.url === 'string' && args.url.trim()) return `url ${text(args.url)}`;
  if (typeof args.prompt === 'string' && args.prompt.trim()) return `prompt ${text(args.prompt)}`;
  return actionOf(call);
}

/** Тест-раннеры, которые дублирует `run_tests`, а не произвольная команда сборки. */
const TEST_RUNNERS =
  /\b(?:npm(?:\s+run)?\s+(?:test|tests?)|pnpm(?:\s+run)?\s+test|yarn(?:\s+run)?\s+test|vitest|jest|pytest|python3?\s+-m\s+pytest|node\s+--test|uv\s+run\s+pytest)\b/;

/** Линтеры и статические проверки, которые умеет `checks(action=lint)`. */
const LINTERS =
  /\b(?:eslint|biome\s+(?:lint|check)|ruff\s+check|prettier\s+--check|stylelint|tsc\s+[^|;&]*--noEmit|tsc\s+--noEmit|mypy|pyright|flake8|clang-tidy)\b/;

function isLookup(action: string): boolean {
  return action === 'definition' || action === 'references';
}

function isBrowserPage(action: string): boolean {
  return action === 'open' || action === 'snapshot';
}

/** Жёсткое пересечение двух соседних вызовов или `null`, когда пути различны. */
export function overlapOf(a: OverlapCall, b: OverlapCall): CallOverlapKind | null {
  const first = [a, b] as const;
  const second = [b, a] as const;
  const has = (
    left: OverlapCall,
    right: OverlapCall,
    leftName: string,
    rightName: string,
    leftAction: (value: string) => boolean,
    rightAction: (value: string) => boolean,
  ): boolean => {
    return (
      left.name === leftName && right.name === rightName && leftAction(actionOf(left)) && rightAction(actionOf(right))
    );
  };

  if (
    has(a, b, 'search', 'lsp', (action) => action === 'code', isLookup) ||
    has(b, a, 'search', 'lsp', (action) => action === 'code', isLookup)
  ) {
    return 'search-lsp';
  }

  const terminalTest = first.some((call) => call.name === 'terminal' && TEST_RUNNERS.test(commandOf(call)));
  if (terminalTest && second.some((call) => call.name === 'run_tests')) return 'terminal-tests';

  const terminalLint = first.some((call) => call.name === 'terminal' && LINTERS.test(commandOf(call)));
  if (terminalLint && second.some((call) => call.name === 'checks' && actionOf(call) === 'lint')) {
    return 'terminal-lints';
  }

  const webPage = first.some((call) => call.name === 'web' && actionOf(call) === 'fetch');
  if (webPage && second.some((call) => call.name === 'browser' && isBrowserPage(actionOf(call)))) {
    return 'web-browser';
  }

  const fileReplace = first.some((call) => call.name === 'file' && actionOf(call) === 'replace');
  if (fileReplace && second.some((call) => call.name === 'edit')) return 'file-edit';

  const listCall = first.some((call) => call.name === 'list');
  if (listCall && second.some((call) => call.name === 'project_map')) return 'list-project_map';

  return null;
}

/** Пересечения только соседних вызовов: модель обычно дублирует следующей репликой. */
export function callOverlaps(calls: readonly OverlapCall[]): CallOverlap[] {
  const found: CallOverlap[] = [];
  for (let index = 1; index < calls.length; index += 1) {
    const kind = overlapOf(calls[index - 1]!, calls[index]!);
    if (kind) found.push({ a: index - 1, b: index, kind });
  }
  return found;
}

/**
 * Индексы вызовов, повторённых в этом же шаге.
 *
 * Сравнение не по строке, а по нормальной форме JSON: пробелы и порядок ключей у
 * модели не постоянны, смысл же один. Неразобранная строка сравнивается как есть.
 */
export function callKeyOf(call: OverlapCall): string {
  const args = parseArgs(call.arguments);
  const keys = args && Object.keys(args).length > 0 ? stableJson(args) : call.arguments.trim();
  return `${call.name}:${typeof keys === 'string' ? keys : JSON.stringify(keys)}`;
}

/** Первый из одинаковых вызовов не считается повтором — только последующие. */
export function repeatedCallIndexes(calls: readonly OverlapCall[]): number[] {
  const seen = new Map<string, number>();
  const repeated: number[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const key = callKeyOf(call);
    if (seen.has(key)) repeated.push(index);
    else seen.set(key, index);
  }
  return repeated;
}

/** Подпись для примера в переписи: команды и действия без текста аргументов. */
export function overlapExample(calls: readonly OverlapCall[], overlap: CallOverlap): string {
  const a = calls[overlap.a];
  const b = calls[overlap.b];
  const left = a ? `${a.name}(${actionOf(a) || labelOf(a)})` : '?';
  const right = b ? `${b.name}(${actionOf(b) || labelOf(b)})` : '?';
  return `${overlap.kind}: ${left} + ${right}`;
}
