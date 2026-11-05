import type { DefineCommand } from './command-args';
import type { TextDocument } from './document';
import { formatEngine, formatToolNames, type FormatEngine } from '../../shared/format';
import { planFormatting, type FormatterChoice } from '../../shared/formatter';
import { applyTextEdits } from '../../shared/edits';
import { lineEndingLabel, type LineEnding } from '../../shared/line-endings';
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
  /** Файл целиком (`textDocument/formatting`). Не умеет — пустой список. */
  formatDocument(path: string): Promise<readonly FormatEdit[]>;
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
  /** Кто форматирует (настройка `editor.formatter`). Не задано — `auto`. */
  formatter?(document: TextDocument): FormatterChoice;
  /** Умеет ли сервер форматировать этот файл. Не задано — считаем, что да. */
  lspCanFormat?(path: string): boolean;
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
 * Отформатировать документ. Кто это делает — решает настройка `editor.formatter`
 * (см. `shared/formatter.ts`): раньше порядок был зашит (сервер, при молчании —
 * инструмент), и при двух готовых источниках «форматировал тот, кто первым ответил».
 *
 * `unavailable` теперь значит и «выбранный источник недоступен»: подставлять вместо
 * него другой молча нельзя — человек выбрал явно. Причина уходит в `FormatResult`,
 * чтобы команда сказала не просто «нечем», а кем именно не вышло.
 */
export async function formatDocument(deps: FormatDeps, document: TextDocument): Promise<FormatResult> {
  const problem = { message: null as string | null };
  const outcome = await runFormat(deps, document, problem);
  return { outcome, problem: problem.message };
}

/** Итог вместе с причиной: «нечем» бывает по разным поводам, и они не равны. */
export interface FormatResult {
  readonly outcome: FormatOutcome;
  /** Почему не вышло: выбранный источник недоступен или сервер вернул мусор. */
  readonly problem: string | null;
}

async function runFormat(
  deps: FormatDeps,
  document: TextDocument,
  problem: { message: string | null },
): Promise<FormatOutcome> {
  if (document.readOnly) return 'readonly';
  const engine = formatEngine(document.languageId);
  const choice = deps.formatter?.(document) ?? 'auto';
  const lspAvailable = deps.lspCanFormat?.(document.path) ?? true;
  const plan = planFormatting({ choice, lspAvailable, toolAvailable: engine !== null });
  if (!plan.first) {
    problem.message = plan.complaint;
    return 'unavailable';
  }

  // Сначала тот, кого выбрали; второй — только в `auto` и только если первый
  // кончился молчанием (сервер с capability, но без правок).
  const order = plan.fallback ? [plan.first, plan.fallback] : [plan.first];
  for (const source of order) {
    const outcome =
      source === 'lsp'
        ? await applyServerFormat(deps, document, problem)
        : await applyToolFormat(deps, document, engine);
    if (outcome) return outcome;
  }
  // Источник был выбран по языку, но в проекте оказался не установлен.
  // Без этого человек видел бы голое «нечем», не зная, кого именно искать.
  if (problem.message === null) {
    problem.message =
      plan.first === 'tool'
        ? `Инструмент проекта не найден${engine ? `: ${formatToolNames(engine).join(' или ')}` : ''}`
        : 'Языковой сервер не отдал форматирование';
  }
  return 'unavailable';
}

/** Правки сервера — в документ. `null` — сервер не дал ничего, можно спросить другого. */
async function applyServerFormat(
  deps: FormatDeps,
  document: TextDocument,
  problem: { message: string | null },
): Promise<FormatOutcome | null> {
  const fromServer = await deps.lsp.formatDocument(document.path).catch(() => []);
  if (fromServer.length === 0) return null;
  let text: string;
  try {
    text = applyTextEdits(document.value, fromServer);
  } catch {
    problem.message = 'Форматирование вернуло несогласованные правки';
    return 'unavailable';
  }
  if (text === document.value) return 'unchanged';
  document.setText(text, 'programmatic');
  return 'changed';
}

/** Инструмент проекта — в документ. `null` — не нашёлся или не ответил. */
async function applyToolFormat(
  deps: FormatDeps,
  document: TextDocument,
  engine: FormatEngine | null,
): Promise<FormatOutcome | null> {
  if (!engine) return null;
  const method = engine === 'python' ? 'python.format' : 'node.format';
  // Ответ rpc не типизирован: инструмента могло не оказаться в проекте — это `unavailable`.
  const answer = (await deps.rpc.request(method, { path: document.path, text: document.value }).catch(() => null)) as {
    tool?: string;
    text?: string;
  } | null;
  if (!answer?.tool || typeof answer.text !== 'string') return null;
  if (answer.text === document.value) return 'unchanged';
  document.setText(answer.text, 'programmatic');
  return 'changed';
}

/** Человеческий итог форматирования — одним сообщением. */
export function formatOutcomeMessage(engine: FormatEngine | null, outcome: FormatOutcome): string {
  if (outcome === 'changed') return 'Файл отформатирован';
  if (outcome === 'unchanged') return 'Менять нечего';
  if (outcome === 'readonly') return 'Файл открыт только для чтения — форматировать нечего';
  if (!engine) return 'Нечем форматировать: инструмента проекта нет';
  return `Нечем форматировать: ${formatToolNames(engine).join(' и ')} в проекте нет`;
}

export function registerFormatCommands(define: DefineCommand, deps: FormatDeps): void {
  const { openEditors, workspace, showToast } = deps;

  /**
   * Ни файла, ни источника — одна проверка на обе команды.
   *
   * Инструмент проекта больше не обязателен: при `formatter: 'lsp'` файл форматирует
   * сервер, и ruff/prettier в проекте может не быть вовсе.
   */
  const engineOfActive = (): { document: TextDocument; engine: FormatEngine | null } | null => {
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
    const choice = deps.formatter?.(document) ?? 'auto';
    const lspAvailable = deps.lspCanFormat?.(document.path) ?? true;
    if (!engine && !lspAvailable && choice !== 'lsp') {
      showToast(`Не форматирую ${languageLabel(document.languageId)}: для него нет ни сервера, ни инструмента`);
      return null;
    }
    return { document, engine };
  };

  /**
   * Форматирование и итог: причина «нечем» (выбранный источник недоступен) важнее
   * общего текста — иначе человек видел бы «инструмента нет», выбрав сервер.
   */
  const run = async (document: TextDocument): Promise<FormatOutcome> => {
    const result = await formatDocument(deps, document);
    if (result.problem) {
      showToast(result.problem);
      return 'changed';
    }
    return result.outcome;
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
      showToast(formatOutcomeMessage(ready.engine, await run(ready.document)));
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
        showToast(formatOutcomeMessage(ready.engine, await run(ready.document)));
        return;
      }
      await formatRangeWithServer(deps, document.path, workspace.selectionRange());
    },
  );

  // Концы строк: выбор из двух вариантов, как в меню формата у других редакторов.
  // Текст модели не меняется — меняется только то, что уйдёт на диск при записи. Поэтому
  // о формате помнит сам документ, а вкладка становится «не сохранённой»: иначе выбор
  // формата пропал бы при первом же закрытии без единой правки текста.
  define(
    {
      id: 'format.lineEnding.lf',
      title: 'Концы строк: LF',
      category: 'Файл',
      keywords: ['eol', 'crlf', 'lf', 'концы строк', 'перевод строки'],
    },
    async () => setLineEnding(deps, '\n'),
  );

  define(
    {
      id: 'format.lineEnding.crlf',
      title: 'Концы строк: CRLF',
      category: 'Файл',
      keywords: ['eol', 'crlf', 'lf', 'концы строк', 'перевод строки'],
    },
    async () => setLineEnding(deps, '\r\n'),
  );
}

/**
 * Перевести активный документ на другой конец строк. `false` — менять нечего или нельзя:
 * о причине говорим тостом, потому что молчание тут читалось бы как «команда сломана».
 */
async function setLineEnding(deps: FormatDeps, eol: LineEnding): Promise<void> {
  const { openEditors, showToast } = deps;
  const document = openEditors.active;
  if (!document) {
    showToast('Нет открытого файла');
    return;
  }
  if (document.readOnly) {
    showToast('Файл открыт только для чтения — концы строк не поменять');
    return;
  }
  if (!document.setLineEnding(eol)) {
    showToast(`Концы строк уже ${lineEndingLabel(eol)}`);
    return;
  }
  showToast(`Концы строк: ${lineEndingLabel(eol)} — сохраните файл, чтобы записать их на диск`);
}
