import type { OwnDiffHandle, DiffSide } from '../editor/host/diff-editor';

/**
 * Граница сравнения версий — без самого редактора.
 *
 * `diff-editor.ts` тянет `editor-view`, а тот — реестр грамматик (34 языка). Экраны
 * различий и конфликтов нужны только тогда, когда их открыли, и держать их импорт
 * значило бы увезти все грамматики в первый чанк. Поэтому сюда вынесены только ТИПЫ
 * (их при сборке не остаётся), а `OwnDiffEditor` грузится `import()` из `app.ts`.
 */
export type { OwnDiffHandle, DiffSide };
