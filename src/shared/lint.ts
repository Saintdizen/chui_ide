/**
 * Проверка кода линтером: чем проверять и как прочитать ответ.
 *
 * Здесь только правила — выбор движка по языку и разбор вывода. Запуск самих
 * линтеров живёт в main: там процессы и файловая система. Отсюда следует, что
 * файл чистый (ни процессов, ни Electron) и проверяется юнит-тестами.
 *
 * Ответы линтеров машиночитаемы, но у каждого своя форма: ruff отдаёт JSON-массив,
 * eslint — массив по файлам с вложенными сообщениями, biome — объект с `diagnostics`.
 * Сводим всё к одной форме `LintProblem`, чтобы лента и модель видели одно и то же.
 * Разборщик возвращает `null`, если это не ответ данного инструмента: так `null`
 * («инструмент не отработал») отличается от `[]` («проблем нет»).
 */

/** Вывод линтера: чем проверяли (null — ничем) и что нашли. */
export interface LintOutcome {
  tool: string | null;
  problems: LintProblem[];
}

/** Уровень проблемы. Совпадает по смыслу у всех линтеров, уходит в отчёт словом. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** Одна найденная проблема, приведённая к общей форме. Позиции — 1-based. */
export interface LintProblem {
  /** Путь файла, как его назвал линтер (обычно относительный). */
  path: string;
  line: number;
  column: number;
  severity: LintSeverity;
  /** Короткий код правила: `F401`, `noUnusedVariables`. Пусто — правило не названо. */
  code: string;
  message: string;
}

/** Сколько проблем показываем: дальше список вытеснит беседу, а не поможет. */
const MAX_LINT_PROBLEMS = 100;

/* ── выбор движка ───────────────────────────────────────────────────────── */

/** Движок проверки: питоновский (`ruff`) или из `node_modules` проекта. */
export type LintEngine = 'python' | 'node';

/**
 * Языки, которые проверяют линтеры Node-проекта. Узко и намеренно: `biome lint`
 * и `eslint` берут TS/JS, а `json`/`css`/`html` — уже частные случаи с плагинами.
 */
const NODE_LANGUAGES: readonly string[] = ['typescript', 'javascript'];

/** Чем проверять файл этого языка; null — проверять нечем. */
export function lintEngine(languageId: string): LintEngine | null {
  if (languageId === 'python') return 'python';
  return NODE_LANGUAGES.includes(languageId) ? 'node' : null;
}

/** Инструмент проверки Node-проекта. */
export type NodeLintTool = 'eslint' | 'biome';

/** Обычный порядок: eslint — привычный, biome — современная замена. */
const DEFAULT_LINT_ORDER: readonly NodeLintTool[] = ['eslint', 'biome'];

/** Пакет в `node_modules`, в котором лежит инструмент. */
export function nodeLintPackage(tool: NodeLintTool): string {
  return tool === 'eslint' ? 'eslint' : '@biomejs/biome';
}

/**
 * Инструменты Node-проекта в порядке попыток. Объявленный в `package.json` идёт
 * первым: проект уже выбрал, чем проверяется, и спорить с ним нечем. Не объявлен
 * ни один — порядок обычный: подхватится тот, что просто установлен.
 */
export function nodeLintOrder(declaredDependencies: readonly string[]): readonly NodeLintTool[] {
  const declared = new Set(declaredDependencies);
  const preferred = DEFAULT_LINT_ORDER.filter((tool) => declared.has(nodeLintPackage(tool)));
  const rest = DEFAULT_LINT_ORDER.filter((tool) => !declared.has(nodeLintPackage(tool)));
  return [...preferred, ...rest];
}

/* ── разбор ответов ─────────────────────────────────────────────────────── */

/** Разобрать текст как JSON; не получилось — null (это не наш ответ). */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Номер строки или столбца: не число или мусор — считаем 1 (позиций нет). */
function toPositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/**
 * Вывод `ruff check --output-format json`: массив находок. Значение позиции
 * менялось между версиями — новое `location: {row,column}`, старое плоское
 * `{row,col}` — понимаем оба, чтобы разбор не зависел от версии ruff.
 */
export function parseRuffJson(text: string): LintProblem[] | null {
  const value = parseJson(text);
  if (!Array.isArray(value)) return null;

  const problems: LintProblem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const location = (entry.location ?? entry) as { row?: unknown; column?: unknown; col?: unknown };
    problems.push({
      path: typeof entry.filename === 'string' ? entry.filename : '',
      line: toPositive(location.row ?? entry.row),
      column: toPositive(location.column ?? location.col ?? entry.col),
      // ruff не помечает уровень в выводе: находки `check` — замечания, а не сбой.
      severity: 'warning',
      code: typeof entry.code === 'string' ? entry.code : '',
      message: typeof entry.message === 'string' ? entry.message : '',
    });
  }
  return problems;
}

/**
 * Вывод `biome lint --reporter=json`: объект с полем `diagnostics`. Канал `category`
 * вида `lint/correctness/noUnusedVariables` сокращаем до имени правила.
 */
export function parseBiomeJson(text: string): LintProblem[] | null {
  const value = parseJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return null;

  const problems: LintProblem[] = [];
  for (const item of diagnostics) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { severity?: unknown; message?: unknown; category?: unknown; location?: unknown };
    const location = (entry.location ?? {}) as { path?: unknown; start?: { line?: unknown; column?: unknown } };
    problems.push({
      path: typeof location.path === 'string' ? location.path : '',
      line: toPositive(location.start?.line),
      column: toPositive(location.start?.column),
      severity: biomeSeverity(entry.severity),
      code: shortCategory(entry.category),
      message: typeof entry.message === 'string' ? entry.message : '',
    });
  }
  return problems;
}

function biomeSeverity(value: unknown): LintSeverity {
  if (value === 'error') return 'error';
  if (value === 'info' || value === 'information') return 'info';
  return 'warning';
}

/** `lint/correctness/noUnusedVariables` → `noUnusedVariables`. */
function shortCategory(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const parts = value.split('/');
  return parts[parts.length - 1] ?? value;
}

/** Вывод `eslint <target> -f json`: массив по файлам, сообщения вложены в `messages`. */
export function parseEslintJson(text: string): LintProblem[] | null {
  const value = parseJson(text);
  if (!Array.isArray(value)) return null;

  const problems: LintProblem[] = [];
  for (const file of value) {
    if (!file || typeof file !== 'object') continue;
    const entry = file as { filePath?: unknown; messages?: unknown };
    if (!Array.isArray(entry.messages)) continue;
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
    for (const message of entry.messages) {
      if (!message || typeof message !== 'object') continue;
      const item = message as {
        ruleId?: unknown;
        severity?: unknown;
        message?: unknown;
        line?: unknown;
        column?: unknown;
      };
      problems.push({
        path: filePath,
        line: toPositive(item.line),
        column: toPositive(item.column),
        // eslint кодирует уровень числом: 2 — ошибка, 1 — предупреждение.
        severity: item.severity === 2 ? 'error' : 'warning',
        code: typeof item.ruleId === 'string' && item.ruleId ? item.ruleId : '',
        message: typeof item.message === 'string' ? item.message : '',
      });
    }
  }
  return problems;
}

/* ── отчёт ──────────────────────────────────────────────────────────────── */

/** Строка одной проблемы: `путь:строка:столбец [уровень] код сообщение`. */
function formatProblem(problem: LintProblem): string {
  const code = problem.code ? `${problem.code} ` : '';
  return `${problem.path}:${problem.line}:${problem.column} [${problem.severity}] ${code}${problem.message}`;
}

/** Порядок отчёта: по файлу, затем по позиции — так список не «дрожит» от вызова к вызову. */
function sortProblems(problems: readonly LintProblem[]): LintProblem[] {
  return [...problems].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code),
  );
}

/**
 * Отчёт линтера: короткая строка для карточки и подробный список для модели.
 * Проблем нет — говорим и это: «ничего не нашлось» надо услышать, а не додумать.
 */
export function formatLintReport(input: { tool: string; target: string; problems: readonly LintProblem[] }): {
  summary: string;
  detail: string;
} {
  const problems = sortProblems(input.problems);
  if (problems.length === 0) {
    return {
      summary: `${input.tool}: проблем нет`,
      detail: `Линтер ${input.tool} не нашёл проблем (${input.target}).`,
    };
  }

  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const warnings = problems.length - errors;
  const shown = problems.slice(0, MAX_LINT_PROBLEMS);
  const lines = shown.map(formatProblem);
  if (problems.length > shown.length) lines.push(`… ещё проблем: ${problems.length - shown.length}`);

  return {
    summary: `${input.tool}: проблем ${problems.length} (ошибок ${errors}, предупреждений ${warnings})`,
    detail: lines.join('\n'),
  };
}
