import * as monaco from 'monaco-editor';
import { installSuggestions } from '../../shared/import-install';
import { packageForModule } from '../../shared/python-packages';
import { uriToPath } from './document';
import type { ImportChecker } from './import-check';

/**
 * Быстрая правка к подчёркнутому импорту: «Установить пакет».
 *
 * Подчёркивание импортов уже говорит, чего не хватает (см. `import-check.ts`).
 * Логично тут же и починить: человек нажимает лампочку и получает установку, не
 * переключаясь в терминал и не вспоминая имя пакета.
 *
 * Правка не меняет текст — она запускает установку. Поэтому здесь `command`, а не
 * `edit`: Monaco лишь показывает её среди прочих действий, а работу делает renderer.
 *
 * Пути у языков разные, и это не мелочь: Python ставится `pip` в окружение проекта
 * (потоком, как и создание venv), а Node — менеджером пакетов в терминале, как и
 * любые задачи проекта. Поэтому языкам соответствуют разные команды.
 */

export interface ImportActionsDeps {
  checker: ImportChecker;
  /** Поставить пакеты Python в окружение проекта. */
  installPython: (packages: string[]) => Promise<void>;
  /** Поставить пакеты Node менеджером пакетов проекта. */
  installNode: (packages: string[]) => Promise<void>;
}

/** Команды Monaco: идентификаторы должны совпадать с теми, что в действиях. */
const INSTALL_PYTHON = 'chui.installPythonImport';
const INSTALL_NODE = 'chui.installNodeImport';

export function registerImportActions(deps: ImportActionsDeps): monaco.IDisposable[] {
  monaco.editor.registerCommand(INSTALL_PYTHON, (_accessor: unknown, pkg: string) => {
    void deps.installPython([pkg]);
  });
  monaco.editor.registerCommand(INSTALL_NODE, (_accessor: unknown, pkg: string) => {
    void deps.installNode([pkg]);
  });

  return [
    // Python: имя пакета не совпадает с модулем, поэтому переводим через таблицу.
    provideActions(deps, 'python', INSTALL_PYTHON, packageForModule),
    // Node: имя пакета и есть имя импорта (`zod`, `@scope/pkg`).
    provideActions(deps, 'javascript', INSTALL_NODE),
    provideActions(deps, 'typescript', INSTALL_NODE),
  ];
}

/** Провайдер правок для одного языка: отбор общий, различаются только имя и перевод. */
function provideActions(
  deps: ImportActionsDeps,
  language: string,
  command: string,
  toPackage?: (module: string) => string,
): monaco.IDisposable {
  return monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions(model, range) {
      const path = pathOf(model);
      if (!path) return emptyActions();

      const refs = deps.checker.missingFor(path);
      if (refs.length === 0) return emptyActions();

      // Ориентируемся на строки запроса, а не на попадание в маркер: курсор может
      // стоять в любом месте строки импорта — и правка всё равно должна быть видна.
      const lines = new Set<number>();
      for (let line = range.startLineNumber; line <= range.endLineNumber; line += 1) lines.add(line);

      const actions: monaco.languages.CodeAction[] = installSuggestions(refs, lines, toPackage).map((item) => ({
        title: `Установить пакет «${item.package}»`,
        kind: 'quickfix',
        command: { id: command, title: `Установить «${item.package}»`, arguments: [item.package] },
      }));

      return { actions, dispose: () => undefined };
    },
  });
}

/** Ничего не предлагаем — но провайдер обязан вернуть форму, а не пустоту. */
function emptyActions(): monaco.languages.CodeActionList {
  return { actions: [], dispose: () => undefined };
}

/** Путь файла из модели — в форме `document.path`: иначе правки не находят файл. */
function pathOf(model: monaco.editor.ITextModel): string | null {
  const uri = model.uri;
  if (uri.scheme !== 'file') return null;
  return uriToPath(uri.path);
}
