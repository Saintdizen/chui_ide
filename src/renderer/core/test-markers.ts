/**
 * Значки запуска отдельных тестов в жёлобе редактора.
 *
 * Правило «где здесь можно запустить тест» держится на двух условиях сразу, и оба
 * раньше жили в `app.ts` между вызовами редактора и терминала:
 *   1. файл тестовый — иначе значки пестрели бы у каждого `def test_…` в чужом модуле;
 *   2. файл принадлежит проекту — иначе относительного пути нет, и запускать нечего.
 *
 * Языков два (Python и JS/TS), и разбор у них разный, поэтому решает `testKindOf`,
 * а `testMarkersFor` отдаёт готовый список значков. Вызов `setTestMarkers` — дело окна.
 */

import { isNodeLanguage } from '../../shared/languages';
import { findRunnableNodeTests } from '../../shared/node-tests';
import { isNodeTestFile, isPythonTestFile } from '../../shared/project-scan';
import { findRunnableTests } from '../../shared/python-tests';
import type { RunnableTest } from '../../shared/test-model';

/** Чем разбирать тесты в этом файле; `null` — файл не тестовый. */
export type TestKind = 'python' | 'node';

export interface TestFileFacts {
  /** Путь относительно корня проекта; равен абсолютному, если файл вне проекта. */
  relative: string;
  /** Абсолютный путь — чтобы понять, лежит ли файл внутри проекта. */
  absolute: string;
  /** Язык документа, как его назвал редактор. */
  languageId: string;
}

/**
 * Тестовый ли это файл и по каким правилам его разбирать.
 *
 * Проверка «внутри проекта» стоит первой намеренно: у файла вне проекта нет
 * относительного пути, а разбор тестов работает именно по нему.
 */
export function testKindOf(facts: TestFileFacts): TestKind | null {
  if (facts.relative === facts.absolute) return null;
  if (facts.languageId === 'python' && isPythonTestFile(facts.relative)) return 'python';
  // JS/TS разбираем своим разбором: `test('…')` и `describe` вместо `def test_…`.
  if (isNodeLanguage(facts.languageId) && isNodeTestFile(facts.relative)) return 'node';
  return null;
}

/** Значки тестов для документа: пусто — файл не тестовый или тестов в нём нет. */
export function testMarkersFor(facts: TestFileFacts, text: string): RunnableTest[] {
  const kind = testKindOf(facts);
  if (kind === null) return [];
  return kind === 'python' ? findRunnableTests(facts.relative, text) : findRunnableNodeTests(facts.relative, text);
}

/**
 * Подпись, по которой видно, что значки надо переставить. Версия документа в ней
 * намеренно: правка может добавить или убрать тест, а путь без версии этого не покажет.
 */
export function testMarkerSignature(path: string, version: number): string {
  return `${path}:${version}`;
}
