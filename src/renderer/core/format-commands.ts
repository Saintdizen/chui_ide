import type { DefineCommand } from './command-args';
import type { TextDocument } from './document';
import { formatEngine, formatToolNames, type FormatEngine } from '../../shared/format';
import { applyTextEdits } from '../../shared/edits';
import { languageLabel } from '../../shared/languages';

/**
 * Итог форматирования. `unavailable` — это не «менять нечего»: инструмента в
 * проекте может просто не быть, и сказать об этом надо честно, а не молчанием.
 */
export type FormatOutcome = 'changed' | 'unchanged' | 'unavailable' | 'readonly';

export type FormatRange = { startLine: number; startColumn: number; endLine: number; endColumn: number };

/** Документы по пути: нужен и сам текст, и признак «только для чтения». */
export interface FormatDocuments {
  get(path: string): TextDocument | undefined;
}

/** Языковой сервер: отдаёт правки участка — применяем их обычным путём. */
export interface FormatLsp {
  formatRange(path: string, range: FormatRange): Promise<readonly FormatEdit[]>;
}

/** Правки сервера приходят только для чтения — копируем в то, что принимает сервис. */
const mutable = (edits: readonly FormatEdit[]): FormatEdit[] => [...edits];

/** Правка участка в терминах сервера: диапазон и новый текст. */
export type FormatEdit = Parameters<typeof applyTextEdits>[1][number];

/** Внесение правок на диск через общий сервис: одна отмена на всю правку. */
export interface FormatEdits {
  applyFileEdits(requests: { path: string; edits: FormatEdit[] }[]): Promise<{ failed: { message: string }[] }>;
}

/** Инструмент проекта: python идёт в python, остальное — в node. */
export interface FormatRpc {
  request(method: string, params: unknown): Promise<unknown>;
}

/** Открытые табы: у кого спросить активный документ. */
export interface FormatOpenEditors {
  readonly active: TextDocument | null;
}

/** Рабочее место редактора: выделение живёт здесь, а не в табах. */
export interface FormatWorkspace {
  hasSelection(): boolean;
  selectionRange(): FormatRange;
}

export interface FormatDeps {
  documents: FormatDocuments;
  lsp: FormatLsp;
  edits: FormatEdits;
  rpc: FormatRpc;
  openEditors: FormatOpenEditors;
  workspace: FormatWorkspace;
  showToast(message: string, kind?: 'error'): void;
}

/**
 * Отформатировать УЧАСТОК файла языковым сервером (`rangeFormatting`). Так форматируют
 * выделение и вставленный кусок: инструмент проекта (ruff, prettier) переписывает файл
 * целиком и на участок не годится. Сервер отдаёт правки — применяем их обычным путём,
 * поэтому и отмена у правки одна.
 *
 * Молча ничего не делаем, когда звали из-за вставки: там ошибку показывать не о чем.
 * Из команды (`format.selection`) `false` — это «сервер не умеет»: о нём говорим.
 */
export async function formatRangeWithServer(
  deps: FormatDeps,
  path: string,
  range: FormatRange,
  options: { silent?: boolean } = {},
): Promise<boolean> {
  const { documents, lsp, edits, showToast } = deps;
  const document = documents.get(path);
  if (!document || document.readOnly) return false;
  const serverEdits = await lsp.formatRange(path, range).catch(() => [] as FormatEdit[]);
  if (serverEdits.length === 0) {
    if (!options.silent) showToast('Нечем форматировать участок: языковой сервер этого не умеет');
    return false;
  }
  // Правки могли ничего не изменить (сервер вернул тот же текст) — это не ошибка.
  let after: string;
  try {
    after = applyTextEdits(document.value, serverEdits);
  } catch {
    if (!options.silent) showToast('Форматирование вернуло несогласованные правки', 'error');
    return false;
  }
  if (after === document.value) {
    if (!options.silent) showToast('Менять нечего');
    return true;
  }
  const result = await edits.applyFileEdits([{ path, edits: mutable(serverEdits) }]);
  if (result.failed.length > 0) {
    if (!options.silent) showToast(result.failed[0]!.message, 'error');
    return false;
  }
  return true;
}

/**
 * Отформатировать документ инструментом проекта. Правку проводим через документ:
 * так она попадает в undo и в сохранение.
 */
export async function formatDocument(deps: FormatDeps, document: TextDocument): Promise<FormatOutcome> {
  if (document.readOnly) return 'readonly';
  const engine = formatEngine(document.languageId);
  if (!engine) return 'unavailable';
  const method = engine === 'python' ? 'python.format' : 'node.format';
  // Ответ rpc не типизирован: инструмента могло не оказаться в проекте — это `unavailable`.
  const answer = (await deps.rpc.request(method, { path: document.path, text: document.value }).catch(() => null)) as {
    tool?: string;
    text?: string;
  } | null;
  if (!answer?.tool || typeof answer.text !== 'string') return 'unavailable';
  if (answer.text === document.value) return 'unchanged';
  document.setText(answer.text, 'programmatic');
  return 'changed';
}

/** Человеческий итог форматирования — одним сообщением. */
export function formatOutcomeMessage(engine: FormatEngine, outcome: FormatOutcome): string {
  if (outcome === 'changed') return 'Файл отформатирован';
  if (outcome === 'unchanged') return 'Менять нечего';
  if (outcome === 'readonly') return 'Файл открыт только для чтения — форматировать нечего';
  return `Нечем форматировать: ${formatToolNames(engine).join(' и ')} в проекте нет`;
}

export function registerFormatCommands(define: DefineCommand, deps: FormatDeps): void {
  const { openEditors, workspace, showToast } = deps;

  /** Ни файла, ни инструмента — одна проверка на обе команды. */
  const engineOfActive = (): { document: TextDocument; engine: FormatEngine } | null => {
    const document = openEditors.active;
    if (!document) {
      showToast('Нет открытого файла');
      return null;
    }
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — форматировать нечего');
      return null;
    }
    const engine = formatEngine(document.languageId);
    if (!engine) {
      showToast(`Не форматирую ${languageLabel(document.languageId)}: для него инструмента нет`);
      return null;
    }
    return { document, engine };
  };

  define(
    {
      id: 'format.document',
      title: 'Форматировать файл',
      category: 'Файл',
      keywords: ['ruff', 'black', 'prettier', 'biome', 'формат'],
    },
    async () => {
      const ready = engineOfActive();
      if (!ready) return;
      showToast(formatOutcomeMessage(ready.engine, await formatDocument(deps, ready.document)));
    },
  );

  // Форматирование ВЫДЕЛЕНИЯ: сервер переписывает только участок, файл целиком не трогает.
  // Инструмент проекта так не умеет — он всегда форматирует весь файл.
  // Сочетание Ctrl+K Ctrl+F живёт в клавиатуре редактора (`keymap.ts` → `formatSelection`):
  // вторая подпись на ту же пару врала — гонку выигрывал обработчик редактора.
  // Здесь сочетания нет намеренно: команда нужна палитре и меню.
  define(
    {
      id: 'format.selection',
      title: 'Форматировать выделение',
      category: 'Файл',
      keywords: ['format', 'selection', 'выделение', 'формат'],
    },
    async () => {
      const document = openEditors.active;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      if (document.readOnly) {
        showToast('Файл открыт только для чтения — форматировать нечего');
        return;
      }
      // Выделения нет — берём документ целиком: команда участка без выделения
      // иначе молчала бы о «нечего делать».
      if (!workspace.hasSelection()) {
        const ready = engineOfActive();
        if (!ready) return;
        showToast(formatOutcomeMessage(ready.engine, await formatDocument(deps, ready.document)));
        return;
      }
      await formatRangeWithServer(deps, document.path, workspace.selectionRange());
    },
  );
}
