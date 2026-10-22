import { installLanguageOf, installMenuItems, installSuggestions } from '../../shared/import-install';
import { codeActionKindLabel, type CodeActionItem } from '../../shared/lsp-code-actions';
import { packageForModule } from '../../shared/python-packages';
import type { ImportChecker } from './import-check';
import { refactorLabel, type RefactorAction } from '../../shared/lsp-refactor';
import type { DocumentStore } from './document-store';
import type { EditService } from './edits';
import type { EditorWorkspace } from '../editor/host/editor-workspace';
import type { LspFeatures } from '../editor/host/lsp-features';
import { showPopupMenu, type PopupMenuItem } from '../ui/popup-menu';
import type { ToastKind } from '../ui/toast';

/**
 * Быстрые правки под курсором: что показать в меню и как применить выбранное.
 *
 * Здесь два источника пунктов. Свои — «поставить не установленный пакет»: о
 * недостающем импорте знает `import-check`, а перевод «модуль → пакет» и способ
 * установки приходят из deps (Python ставится в своё окружение, Node — менеджером
 * проекта). Чужие — действия языкового сервера и рефакторинги: их список берём у
 * сервера, а применяем правки обычным путём (`edits`), поэтому undo и показ отказа
 * остаются общими.
 */
export interface EditorFixesDeps {
  editors: EditorWorkspace;
  documents: DocumentStore;
  lsp: LspFeatures;
  edits: EditService;
  importChecker: ImportChecker;
  /** Установка пакетов — из `createInstallActions`: у Python и Node разные пути. */
  installPythonPackages(packages: string[]): Promise<void> | void;
  installNodePackages(packages: string[]): Promise<void> | void;
  showToast(message: string, kind?: ToastKind): void;
  /**
   * Команда языкового сервера (клик по линзе) живёт рядом с командным реестром,
   * поэтому её тоже дают снаружи: она умеет и правки, и запуск.
   */
  runLensCommand(path: string, command: { command: string; arguments: readonly unknown[] }): void;
}

export function createEditorFixes(deps: EditorFixesDeps) {
  const { editors, documents, lsp, edits, importChecker, showToast } = deps;
  const { installPythonPackages, installNodePackages, runLensCommand } = deps;

  /**
   * Наши быстрые правки: поставить не установленный пакет. Своя проверка импортов
   * (`core/import-check.ts`) знает, чего не хватает, а перевод «модуль → пакет» — таблица
   * Python (`yaml` → `PyYAML`). У языков разные пути установки: Python идёт `pip` в своё
   * окружение, Node — менеджером проекта в терминале.
   */
  const importInstallActions = (path: string, position: { line: number; column: number }): PopupMenuItem[] => {
    const language = documents.get(path)?.languageId ?? '';
    const installable = installLanguageOf(language);
    if (!installable) return [];
    const python = installable.python;
    const refs = importChecker.missingFor(path);
    if (refs.length === 0) return [];
    // Ориентируемся на строку под курсором: имя модуля берём из импорта, а не из позиции.
    const suggestions = installSuggestions(refs, new Set([position.line]), python ? packageForModule : undefined);
    const install = (pkg: string, forPython: boolean): void => {
      void (forPython ? installPythonPackages([pkg]) : installNodePackages([pkg]));
    };
    return installMenuItems(suggestions, python, install).map((item) => ({
      label: item.title,
      hint: 'быстрое исправление',
      onSelect: item.run,
    }));
  };

  /**
   * Свои быстрые правки из диагностики — без языкового сервера. Сейчас это замены для
   * отмеченного орфографией слова: подсказки из словаря, плюс «в словарь» и «пропустить».
   * Нет слова с ошибкой — списка нет.
   */
  const spellingQuickFixes = (): PopupMenuItem[] => {
    const found = editors.spellingSuggestionsAtCursor();
    if (!found) return [];
    const items: PopupMenuItem[] = found.suggestions.map((word) => ({
      label: `Заменить на «${word}»`,
      hint: 'орфография',
      onSelect: () => {
        if (!editors.replaceSpellingWord(word)) showToast('Не удалось заменить слово', 'error');
      },
    }));
    items.push(
      { label: 'Добавить в словарь', hint: 'орфография', onSelect: () => editors.addSpellingWordToDictionary() },
      { label: 'Пропустить слово', hint: 'орфография', onSelect: () => editors.ignoreSpellingWord() },
    );
    return items;
  };

  /**
   * Быстрые исправления под курсором: спросить сервер, показать список у каретки,
   * применить выбранное. Правки идут через документную модель — значит с undo; команда
   * сервера выполняется там, где он живёт.
   */
  const runCodeActions = async (path: string, position: { line: number; column: number }): Promise<void> => {
    // Контекст запроса — пометки ЭТОЙ строки: сервер отвечает исправлениями на них.
    const diagnostics = editors.lspDiagnostics(path).filter((item) => item.line === position.line);
    const actions = await lsp.codeActions(path, position, diagnostics);
    // Свои правки идут вперёд: они отвечают на наши же пометки и понятнее серверных.
    const own: PopupMenuItem[] = [...spellingQuickFixes(), ...importInstallActions(path, position)];
    const fromServer: PopupMenuItem[] = actions.map((action) => ({
      label: action.title,
      hint: codeActionKindLabel(action.kind),
      onSelect: () => void applyCodeAction(path, action),
    }));
    const items: PopupMenuItem[] =
      own.length > 0 && fromServer.length > 0 ? [...own, { separator: true }, ...fromServer] : [...own, ...fromServer];
    if (items.length === 0) {
      showToast('Быстрых исправлений здесь нет');
      return;
    }
    // Список ставим у каретки — как список подсказок: глаз уже там, где он печатает.
    const point = editors.caretPoint();
    showPopupMenu(items, point?.left ?? 0, (point?.bottom ?? 0) + 2);
  };

  /** Применить выбранное действие: его правки и/или команду сервера. */
  const applyCodeAction = async (path: string, action: CodeActionItem): Promise<void> => {
    if (action.edits) {
      const result = await edits.applyFileEdits(action.edits);
      if (result.failed.length > 0) showToast(result.failed[0]!.message, 'error');
    }
    if (!action.command) return;
    await runLensCommand(path, action.command);
  };

  /**
   * Упорядочить импорты файла: сервер один знает, что лишнее и чего не хватает, —
   * просим действие `source.organizeImports` и применяем его правки обычным путём.
   */
  const runOrganizeImports = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    const actions = await lsp.organizeImports(path, { line: document.lineCount, column: 1 });
    const action = actions.find((item) => item.edits);
    if (!action) {
      showToast('Упорядочить импорты сервер не предложил');
      return;
    }
    await applyCodeAction(path, action);
  };

  /**
   * Извлечение и «разворачивание» (inline) — рефакторинги, которые умеет только языковой
   * сервер. Просим у него действие нужного вида и применяем выбранное: извлечение — по
   * выделению, разворачивание — по символу под кареткой.
   */
  const runRefactor = async (path: string, action: RefactorAction): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — рефакторинг не применить');
      return;
    }
    const range = editors.selectionRange();
    // Извлечению нужен участок: по пустому выделению выносить нечего.
    const empty = range.startLine === range.endLine && range.startColumn === range.endColumn;
    if (action === 'extract' && empty) {
      showToast('Выделите выражение, которое надо извлечь');
      return;
    }
    const actions = await lsp.refactor(path, range, action);
    if (actions.length === 0) {
      showToast(`Сервер ${refactorLabel(action)} не предложил`);
      return;
    }
    // Одно действие — применяем сразу; несколько (в переменную и в функцию) — выбираем.
    const [first] = actions;
    if (actions.length === 1 && first) {
      await applyCodeAction(path, first);
      return;
    }
    const point = editors.caretPoint();
    showPopupMenu(
      actions.map((entry) => ({
        label: entry.title,
        hint: codeActionKindLabel(entry.kind),
        onSelect: () => void applyCodeAction(path, entry),
      })),
      point?.left ?? 0,
      (point?.bottom ?? 0) + 2,
    );
  };

  /**
   * Общий список рефакторингов: что сервер предлагает для выделения или символа под
   * кареткой, то и показываем — извлечение, разворачивание и всё прочее из раздела
   * `refactor` (вынести в файл, преобразовать…). Отдельные команды для извлечения и
   * inline при этом остаются: они сразу прыгают в конкретный подвид, минуя выбор.
   */
  const runRefactorMenu = async (path: string): Promise<void> => {
    const document = documents.get(path);
    if (!document) return;
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — рефакторинг не применить');
      return;
    }
    const actions = await lsp.refactorActions(path, editors.selectionRange());
    if (actions.length === 0) {
      showToast('Сервер рефакторингов не предложил');
      return;
    }
    // Один — применяем сразу, без списка из одной строки; несколько — выбираем.
    const [first] = actions;
    if (actions.length === 1 && first) {
      await applyCodeAction(path, first);
      return;
    }
    const point = editors.caretPoint();
    showPopupMenu(
      actions.map((entry) => ({
        label: entry.title,
        hint: codeActionKindLabel(entry.kind),
        onSelect: () => void applyCodeAction(path, entry),
      })),
      point?.left ?? 0,
      (point?.bottom ?? 0) + 2,
    );
  };
  return {
    importInstallActions,
    spellingQuickFixes,
    runCodeActions,
    applyCodeAction,
    runOrganizeImports,
    runRefactor,
    runRefactorMenu,
  };
}
