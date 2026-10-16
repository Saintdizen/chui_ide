/**
 * Классы значков и подсказки у мест украшений.
 *
 * Значки в поле слева и полоски в полосе украшений несут не только вид, но и текст
 * подсказки: что это за точка останова, каким был тест, что случилось со строкой.
 * Текст и класс решаются одним местом, а не каждым, кто рисует: так подсказка и вид
 * не разъедутся между разными местами отрисовки. Поэтому же это отдельный
 * модуль без зависимостей на движок — его берут оба.
 *
 * Модуль чистый: только строки по данным. Ни DOM, ни моделей.
 */

import type { GitLineChange } from '../../../shared/git-line-changes';
import type { RunnableTest } from '../../../shared/python-tests';
import type { TestOutcome } from '../../../shared/test-model';
import type { BreakpointInput } from '../../core/debug';

/**
 * Класс значка точки: обычная — кружок, условная — ромб, точка в журнал —
 * ромб с «журнальным» цветом. Видно с одного взгляда, без наведения.
 */
export function breakpointGlyphClass(item: BreakpointInput): string {
  if (item.logMessage) return 'breakpoint-glyph is-log';
  if (item.condition || item.hitCondition) return 'breakpoint-glyph is-conditional';
  return 'breakpoint-glyph';
}

/** Подсказка точки: все её настройки в одном месте. */
export function breakpointTooltip(item: BreakpointInput): string {
  if (item.logMessage) return `Точка в журнал: ${item.logMessage}`;
  const parts: string[] = [];
  if (item.condition) parts.push(`условие: ${item.condition}`);
  if (item.hitCondition) parts.push(`попаданий: ${item.hitCondition}`);
  return parts.length > 0 ? `Точка останова (${parts.join(', ')})` : 'Точка останова';
}

/**
 * Подсказка значка теста: что это за тест и, если был прогон, чем он кончился.
 * Без исхода подсказка говорит только приглашение — так и выглядит ▶ до запуска.
 */
export function testGlyphTooltip(test: RunnableTest, outcome: TestOutcome | undefined): string {
  if (outcome === 'passed') return `Прошёл: ${test.name}`;
  if (outcome === 'failed') return `Упал: ${test.name}`;
  if (outcome === 'running') return `Идёт прогон: ${test.name}`;
  return `Запустить тест ${test.name}`;
}

/** Подсказка полоски изменения в жёлобе: что именно случилось со строкой. */
export function changeGutterTooltip(kind: GitLineChange['kind']): string {
  if (kind === 'added') return 'Добавлено (по сравнению с HEAD)';
  if (kind === 'deleted') return 'Удалено (по сравнению с HEAD)';
  return 'Изменено (по сравнению с HEAD)';
}
