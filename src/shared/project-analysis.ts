/**
 * Анализ проекта целиком: то, что можно сказать о коде до открытия файлов.
 *
 * Обычные источники пометок (языковой сервер, проверка импортов) говорят только
 * про открытые файлы. Поэтому при старте «Проблемы» пусты, а счётчики
 * в статус-баре молчат — даже если проект полон ошибок. Здесь форма ответа одной
 * проверки по всему корню: линтер проекта плюс зависимости из манифеста.
 *
 * Правила чистые: ни файловой системы, ни процессов. Запуск живёт в main
 * (`project/analyze.ts`), показ — в renderer (`core/project-check.ts`), поэтому
 * форму ответа и разбор манифеста можно проверить юнит-тестами.
 *
 * Значения важнее формальностей: проверка честно говорит, чем она кончилась —
 * `tool: null` (проверять нечем), `timedOut` (не успели), `note` (что не вышло).
 * Пустой список при `tool: null` — это не «всё чисто», и интерфейс обязан
 * показать разницу.
 */
import type { LintProblem, LintSeverity } from './lint';

/** Сколько проблем отдаём в редактор: больше — уже не список, а свалка. */
export const MAX_PROJECT_PROBLEMS = 2000;

/** Одна пометка проекта. Путь абсолютный: он же ключ пометок в редакторе. */
export interface ProjectProblem {
  path: string;
  line: number;
  column: number;
  severity: LintSeverity;
  message: string;
  /** Кто нашёл: `lint`, `deps`. */
  source: string;
  /** Код правила записи: `F401`, `noUnusedVariables`. Пусто — правило не названо. */
  code?: string;
}

/** Итог проверки проекта: чем проверяли, что нашли и чего не хватило. */
export interface ProjectAnalysis {
  /** Чем проверяли код; `null` — проверять нечем. */
  tool: string | null;
  problems: ProjectProblem[];
  /** Проверка не уложилась в отведённое время — список может быть неполным. */
  timedOut: boolean;
  /** Чего не хватило или что пошло не так — словами для человека. */
  note: string | null;
}

/** Пустой итог: проверять было нечего или нечем. */
export function emptyAnalysis(note: string | null, tool: string | null = null): ProjectAnalysis {
  return { tool, problems: [], timedOut: false, note };
}

/**
 * Проблемы линтера с абсолютными путями. Линтер называет путь от корня проекта
 * (так его и запускают), а пометки в редакторе живут по абсолютному.
 * `root` приходит уже в разделителях платформы: склейка — строкой, как в `join`.
 */
export function lintProblems(root: string, problems: readonly LintProblem[]): ProjectProblem[] {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return problems.map((problem) => ({
    path: problem.path.startsWith('/') ? problem.path : `${base}/${problem.path}`,
    line: problem.line,
    column: problem.column,
    severity: problem.severity,
    message: problem.message,
    source: 'lint',
    code: problem.code,
  }));
}

/**
 * Строка, на которой объявлена зависимость в `package.json`.
 *
 * Читаем как текст, а не как JSON: `JSON.parse` теряет номера строк, а пометка
 * без строки не кликается. Ищем имя в кавычках целиком, чтобы `react` не нашёлся
 * в `react-dom`.
 */
export function lineOfJsonKey(text: string, key: string): number {
  const needle = `"${key}"`;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(needle)) return index + 1;
  }
  return 1;
}

/**
 * Объявленные, но не установленные зависимости — по пометке на строку манифеста.
 *
 * В сообщении намеренно нет версии: «нет совсем» — это про установку, а не про
 * диапазон, и лечение одно на всех — команда установки.
 */
export function missingDependencyProblems(
  manifestPath: string,
  manifestText: string,
  missing: readonly string[],
  installCommand: string,
): ProjectProblem[] {
  return missing.map((name) => ({
    path: manifestPath,
    line: lineOfJsonKey(manifestText, name),
    column: 1,
    severity: 'error' as const,
    message: `Зависимость «${name}» объявлена, но не установлена: ${installCommand}`,
    source: 'deps',
  }));
}

/** Пометки без файла не бывает: общее замечание ставится на первую строку манифеста. */
export function manifestProblem(
  manifestPath: string,
  message: string,
  severity: LintSeverity = 'warning',
  source = 'deps',
): ProjectProblem {
  return { path: manifestPath, line: 1, column: 1, severity, message, source };
}

/** Обрезать список по потолку; `dropped` — сколько осталось за кадром. */
export function limitProblems(problems: readonly ProjectProblem[]): {
  problems: ProjectProblem[];
  dropped: number;
} {
  if (problems.length <= MAX_PROJECT_PROBLEMS) return { problems: [...problems], dropped: 0 };
  return {
    problems: problems.slice(0, MAX_PROJECT_PROBLEMS),
    dropped: problems.length - MAX_PROJECT_PROBLEMS,
  };
}

/**
 * Пометки `tsc --noEmit --pretty false`.
 *
 * Две формы строки: `src/a.ts(3,5): error TS2322: текст` — так печатает обычный
 * запуск, и `src/a.ts:3:5 - error TS2322: текст` — так приходит из `tsc -b` и из
 * отчётов, скопированных руками. Разбираем обе: иначе половина проекта «чиста».
 *
 * Строки-продолжения (`  Тип A несовместим…`) пропускаем: у пометки уже есть
 * первая строка, а вторая повторила бы её в списке дважды.
 */
const TSC_DIAGNOSTIC = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))(?:\s*:\s*|\s*-\s*)(error|warning)\s+TS(\d+):\s*(.+)$/;

export function tscProblems(root: string, text: string): ProjectProblem[] {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  const problems: ProjectProblem[] = [];
  for (const raw of text.split('\n')) {
    const match = TSC_DIAGNOSTIC.exec(raw.trim());
    if (!match) continue;
    const [, file, lineA, columnA, lineB, columnB, severity, code, message] = match;
    if (!file || !message) continue;
    problems.push({
      path: file.startsWith('/') ? file : `${base}/${file}`,
      line: Number(lineA ?? lineB),
      column: Number(columnA ?? columnB),
      severity: severity === 'warning' ? 'warning' : 'error',
      message: message.trim(),
      source: 'types',
      code: `TS${code}`,
    });
  }
  return problems.slice(0, MAX_PROJECT_PROBLEMS);
}

/**
 * Шаги прохода по проекту. Список живёт здесь, а не в рендерере: «сколько всего»
 * обязан знать тот, кто работу делает, иначе число на полосе высосано из пальца.
 */
export const PROJECT_STAGES = ['code', 'deps', 'python-deps'] as const;

/** Один шаг проверки проекта. */
export type ProjectStage = (typeof PROJECT_STAGES)[number];

/** Событие хода `project.analyze`: шаг начался или закончился. */
export interface ProjectStageEvent {
  stage: ProjectStage;
  phase: 'start' | 'done';
}

/** Имя RPC-события хода проверки проекта. */
export const PROJECT_STAGE_EVENT = 'project:stage';
