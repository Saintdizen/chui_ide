import type { FileEdit } from '../../shared/edits';
import type { SearchHit } from '../../shared/api/fs';
import { planRename } from '../../shared/rename-fallback';
import { nameOf } from '../../shared/paths';

/**
 * Переименование без языкового сервера.
 *
 * Сервер знает области видимости и потому точен; когда его нет, остаётся поиск
 * по проекту. Это хуже, и молчать об этом нельзя: человек должен знать, что
 * правим всё совпадение, а не только этот символ.
 */
export interface RenameFallbackDeps {
  /** Имя под курсором — из редактора, а не угаданное по строке. */
  wordAt(path: string, line: number, column: number): Promise<string | null>;
  ask(title: string, value: string): Promise<string | null>;
  search(query: string): Promise<readonly SearchHit[]>;
  apply(files: readonly FileEdit[]): Promise<unknown>;
  notify(text: string, kind?: 'info' | 'error'): void;
}

export async function renameBySearchFallback(
  path: string,
  position: { line: number; column: number },
  deps: RenameFallbackDeps,
): Promise<void> {
  const word = await deps.wordAt(path, position.line, position.column);
  if (!word) {
    deps.notify('Здесь нечего переименовать', 'info');
    return;
  }
  const to = await deps.ask('Переименовать по проекту', word);
  if (!to || to === word) return;

  const hits = await deps.search(word);
  const plan = planRename(word, to, hits);
  if (plan.refused !== null) {
    deps.notify(plan.refused, 'info');
    return;
  }
  if (plan.files.length === 0) {
    deps.notify('Совпадений не найдено', 'info');
    return;
  }
  await deps.apply(
    plan.files.map((file) => ({
      path: file.path,
      edits: file.edits.map((edit) => ({
        startLine: edit.line,
        startColumn: edit.column,
        endLine: edit.line,
        endColumn: edit.column + word.length,
        newText: edit.to,
      })),
    })),
  );
  deps.notify(`Переименовано: ${nameOf(path)} → ${to}, мест: ${plan.total}`, 'info');
}
