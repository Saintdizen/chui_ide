import { isInsidePath } from '../../shared/paths';
import { uriToPath } from './document';

/**
 * Переход по ссылке в коде: Ctrl+Click по символу или по пути в тексте.
 *
 * Monaco сам файлов не открывает: он умеет лишь переставить курсор внутри уже
 * подключённой модели. Если цель в другом файле, он зовёт обработчик открытия —
 * а без обработчика, как сказано в его же документации, «ничего не делает».
 * Поэтому определение из соседнего файла у нас не открывалось, хотя серверы его
 * исправно отдавали: и встроенный сервис TypeScript, и языковой сервер Python.
 *
 * Цель перехода приходит ссылкой (`file:///…`), а IDE работает путями, поэтому
 * переводим и проверяем границу проекта: за его пределами лежат чужие файлы,
 * открывать их в дереве проекта нечем.
 */

/** Куда ведёт переход: путь внутри проекта или `null` — переход не наш. */
export function navigationTarget(uri: string, root: string | null): string | null {
  if (!root || !uri.startsWith('file://')) return null;
  const path = uriToPath(uri);
  return isInsidePath(root, path) ? path : null;
}

/** Место перехода: диапазон определения или одна позиция ссылки. */
export interface NavigationSpan {
  lineNumber?: number;
  column?: number;
  startLineNumber?: number;
  startColumn?: number;
}

/** Строка и столбец цели (1-based). Место не названо — начало файла. */
export function targetPosition(span?: NavigationSpan): { line: number; column: number } {
  return {
    line: span?.startLineNumber ?? span?.lineNumber ?? 1,
    column: span?.startColumn ?? span?.column ?? 1,
  };
}

/** Ресурс перехода в терминах Monaco: схема и строковый вид ссылки. */
export interface NavigationResource {
  readonly scheme: string;
  toString(): string;
}

export interface NavigationDeps {
  /** Открыть путь в IDE: вкладка, редактор, дерево. */
  open(path: string): Promise<void>;
  /** Показать место в открытом файле: строка и столбец 1-based. */
  reveal(path: string, line: number, column: number): void;
  /** Корень проекта: за его пределы не ходим. */
  root(): string | null;
}

/** Что нужно от Monaco: два регистратора — переход к определению и открытие ссылок. */
export interface NavigationHost {
  registerEditorOpener(opener: {
    openCodeEditor(source: unknown, resource: NavigationResource, target?: NavigationSpan): boolean | Promise<boolean>;
  }): { dispose(): void };
  registerLinkOpener(opener: { open(resource: NavigationResource): boolean | Promise<boolean> }): { dispose(): void };
}

export function registerNavigation(host: NavigationHost, deps: NavigationDeps): { dispose(): void } {
  const open = async (resource: NavigationResource, target?: NavigationSpan): Promise<boolean> => {
    const path = navigationTarget(resource.toString(), deps.root());
    if (!path) return false;

    try {
      await deps.open(path);
    } catch {
      // Файла нет или он вне проекта — оставляем поведение по умолчанию.
      return false;
    }

    const position = targetPosition(target);
    deps.reveal(path, position.line, position.column);
    return true;
  };

  const opened = host.registerEditorOpener({
    openCodeEditor: (_source, resource, target) => open(resource, target),
  });
  // Ссылка на путь в тексте ведёт туда же: для неё место не названо, файл — да.
  const linked = host.registerLinkOpener({ open: (resource) => open(resource) });

  return {
    dispose: () => {
      opened.dispose();
      linked.dispose();
    },
  };
}
