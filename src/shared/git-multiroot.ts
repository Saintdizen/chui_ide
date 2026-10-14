/**
 * Сводка git по всей рабочей области, а не по одной активной папке.
 *
 * В области из нескольких корней git ведётся по активному корню: им отвечают
 * операции без явного пути. Но видеть надо всю область — правки могут быть в любой
 * из папок, и «в этом проекте чисто» не значит «в области чисто». Поэтому main
 * обходит все корни и отдаёт по каждому короткую сводку: свой ли это репозиторий,
 * какая ветка, насколько она впереди/отстала и сколько где правок.
 *
 * Здесь — только типы и чистые функции: счёт и подписи считаются по уже готовому
 * статусу корня, без ФС и процессов (их дело — в main, `main/git/git.ts`).
 */

import type { GitRepository, GitStatus } from './api';

/** Сводка по одному корню рабочей области. */
export interface GitRootSummary {
  /** Абсолютный путь корня — по нему панель находит его в дереве области. */
  root: string;
  /** Короткое имя папки: так корень подписан в дереве. */
  name: string;
  /** null — папка не лежит внутри репозитория git. */
  repository: GitRepository | null;
  /** Всего файлов с правками. */
  files: number;
  /** Из них в индексе — попадут в ближайший коммит. */
  staged: number;
  /** Из них вне индекса. */
  unstaged: number;
  /** Из них с неразрешённым конфликтом слияния. */
  conflicted: number;
}

/**
 * Свести статус корня к сводке. Чистая функция: считается по списку файлов, без
 * состояния сервиса, поэтому проверяется в тестах.
 */
export function summarizeRoot(status: GitStatus, root: string, name: string): GitRootSummary {
  let staged = 0;
  let unstaged = 0;
  let conflicted = 0;
  for (const file of status.files) {
    if (file.staged) staged += 1;
    if (file.unstaged) unstaged += 1;
    if (file.change === 'conflicted') conflicted += 1;
  }
  return { root, name, repository: status.repository, files: status.files.length, staged, unstaged, conflicted };
}

/**
 * Строка состояния корня для панели: ветка и расхождение с удалённой, либо
 * «не репозиторий». У оторванного HEAD ветки нет — показываем короткий хеш.
 */
export function rootSummaryLabel(summary: GitRootSummary): string {
  const repository = summary.repository;
  if (!repository) return 'не репозиторий';
  const branch = repository.branch ?? (repository.head ? `HEAD ${repository.head}` : 'без коммитов');
  const parts = [branch];
  if (repository.ahead > 0) parts.push(`↑${repository.ahead}`);
  if (repository.behind > 0) parts.push(`↓${repository.behind}`);
  return parts.join(' ');
}

/** Счёт правок словами: «нет правок», «1 правка», «3 правки», «11 правок». */
export function changesLabel(count: number): string {
  if (count <= 0) return 'нет правок';
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} правка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} правки`;
  return `${count} правок`;
}

/** Сколько правок во всей области: сумма по корням. */
export function totalChanges(summaries: readonly GitRootSummary[]): number {
  return summaries.reduce((sum, item) => sum + item.files, 0);
}

/** Сколько корней области — репозитории git. */
export function repositoryCount(summaries: readonly GitRootSummary[]): number {
  return summaries.reduce((count, item) => count + (item.repository ? 1 : 0), 0);
}

/** Итог сетевой операции по одному корню области (например `fetch`). */
export interface GitRootFetch {
  root: string;
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Сводка по итогам операции в нескольких папках: одной строкой о целом и списком
 * подробностей. Папка без репозитория — тоже результат: 「пропущена」, а не ошибка
 * всей операции, иначе одна чужая папка гасила бы отчёт по остальным.
 */
export function fetchResultsSummary(results: readonly GitRootFetch[]): { ok: boolean; text: string } {
  if (results.length === 0) return { ok: false, text: 'В области нет ни одной папки' };
  const failed = results.filter((item) => !item.ok);
  const done = results.length - failed.length;
  const head = `fetch: обновлено папок — ${done} из ${results.length}`;
  const details = results.map((item) => `${item.name}: ${item.ok ? 'ок' : item.message}`);
  return { ok: failed.length === 0, text: [head, ...details].join('\n') };
}
