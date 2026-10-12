/**
 * Список проблем: сборка того, что показывает панель «Проблемы».
 *
 * Пометки приходят из редактора плоским списком (`DiagnosticItem[]`, отсортированным
 * по пути и месту), а панели нужно другое: счётчики, отбор по подстроке и группировка
 * по файлам. Всё это — чистое преобразование списка, поэтому живёт в `shared` и
 * закреплено тестом (`tests/problem-list.test.ts`): панель остаётся тонкой (рисует и
 * слушает клики), а правила видно без окна.
 */

import type { DiagnosticItem } from './api';

/** Сколько проблем каждого вида. Ошибки и предупреждения — то, что видно в статус-баре. */
export interface ProblemCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countProblems(items: readonly DiagnosticItem[]): ProblemCounts {
  const counts: ProblemCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const item of items) {
    if (item.severity === 'error') counts.errors += 1;
    else if (item.severity === 'warning') counts.warnings += 1;
    else counts.infos += 1;
  }
  return counts;
}

/**
 * Отбор по подстроке: ищем в тексте сообщения, имени источника и пути файла. Пустой
 * запрос ничего не отсеивает — панель без фильтра показывает всё. Регистр не важен:
 * так и набирают в поле фильтра.
 */
export function filterProblems(items: readonly DiagnosticItem[], query: string): DiagnosticItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter(
    (item) =>
      item.message.toLowerCase().includes(needle) ||
      item.source.toLowerCase().includes(needle) ||
      item.path.toLowerCase().includes(needle),
  );
}

/** Проблемы одного файла: подпись для заголовка и счётчики — чтобы видеть вес файла. */
export interface ProblemGroup {
  path: string;
  /** Короткая подпись файла (в приложении — путь от корня проекта). */
  label: string;
  items: DiagnosticItem[];
  counts: ProblemCounts;
}

/**
 * Сгруппировать по файлам, сохранив порядок списка (пути уже отсортированы). Файлы
 * без проблем после отбора не попадают в результат вовсе: пустые заголовки — шум.
 */
export function groupProblems(
  items: readonly DiagnosticItem[],
  query: string,
  label: (path: string) => string,
): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const item of filterProblems(items, query)) {
    let group = groups.get(item.path);
    if (!group) {
      group = { path: item.path, label: label(item.path), items: [], counts: { errors: 0, warnings: 0, infos: 0 } };
      groups.set(item.path, group);
    }
    group.items.push(item);
  }
  for (const group of groups.values()) group.counts = countProblems(group.items);
  return [...groups.values()];
}

/**
 * Заголовок панели: «2 ошибки, 1 предупреждение» или «Проблем нет». Слово «проблема»
 * не склоняем — числа уже названы по видам, и это читается точнее.
 */
export function problemsSummary(counts: ProblemCounts): string {
  const parts: string[] = [];
  if (counts.errors > 0) parts.push(`${counts.errors} ${plural(counts.errors, 'ошибка', 'ошибки', 'ошибок')}`);
  if (counts.warnings > 0)
    parts.push(`${counts.warnings} ${plural(counts.warnings, 'предупреждение', 'предупреждения', 'предупреждений')}`);
  if (counts.infos > 0) parts.push(`${counts.infos} ${plural(counts.infos, 'замечание', 'замечания', 'замечаний')}`);
  return parts.length > 0 ? parts.join(', ') : 'Проблем нет';
}

/**
 * Текст значка на вкладке «Проблемы». Ошибок нет — показываем предупреждения; нет и их —
 * значка нет вовсе. Оба числа — через дробь: `3/2` — ошибки и предупреждения.
 */
export function problemBadgeText(counts: ProblemCounts): string | null {
  if (counts.errors > 0 && counts.warnings > 0) return `${counts.errors}/${counts.warnings}`;
  if (counts.errors > 0) return String(counts.errors);
  if (counts.warnings > 0) return String(counts.warnings);
  return null;
}

/** Русская форма по числу: 1 ошибка, 2 ошибки, 5 ошибок. */
function plural(value: number, one: string, few: string, many: string): string {
  const ten = value % 10;
  const hundred = value % 100;
  if (ten === 1 && hundred !== 11) return one;
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return few;
  return many;
}
