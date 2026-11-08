import { isImagePath } from '../../shared/images';
import { isOfficePath } from '../../shared/office';
import type { DefineCommand } from './command-args';
import type { TextDocument } from './document';
import type { OpenEditors } from './open-editors';

/** Буферы файлов: командам вкладок нужен только поиск по пути. */
export interface TabBuffers {
  get(path: string): TextDocument | undefined;
}

/** Показ документа в редакторе — ровно одна операция. */
export interface TabEditorHost {
  open(document: TextDocument): void;
}

/** Полоса браузера: страница стоит рядом с файлами и закрывается так же. */
export interface TabBrowserStrip {
  readonly activePageId: string | null;
  deactivate(): void;
}

export interface TabPageCloser {
  close(pageId: string): void;
}

/**
 * Вкладки: открыть, активировать, закрыть, закрепить.
 *
 * Открытие пути (`openPath`) остаётся в `app.ts`: оно различает pdf, картинку,
 * документ Office и текст, знает про `explorer.reveal`. Здесь — только решение
 * «какая вкладка показана» и что делать с соседями; вместе с `openEditors` это
 * и есть будущий фасет «вкладки» для `AppContext`.
 */
export interface FileTabDeps {
  openEditors: OpenEditors;
  documents: TabBuffers;
  editors: TabEditorHost;
  browserStrip: TabBrowserStrip;
  browserPages: TabPageCloser;
  openPath(path: string, options?: { preview?: boolean }): Promise<void>;
}

export function registerFileTabCommands(define: DefineCommand, deps: FileTabDeps): void {
  const { openEditors, documents, editors, browserStrip, browserPages, openPath } = deps;

  /** В полосе показана вкладка без файла: страница браузера. */
  const straysShown = (): boolean => browserStrip.activePageId !== null;

  define({ id: 'file.open', title: 'Открыть файл', category: 'Файл' }, async (path, options) => {
    if (typeof path !== 'string') return;
    const preview = (options as { preview?: boolean } | undefined)?.preview === true;
    await openPath(path, { preview });
  });

  define({ id: 'file.activate', title: 'Активировать вкладку', category: 'Файл' }, (path) => {
    if (typeof path !== 'string') return;
    openEditors.activate(path);
    const document = documents.get(path);
    // Картинку и документ Office текстовому редактору не отдаём: их показывает свой экран.
    if (document && !isImagePath(path) && !isOfficePath(path)) editors.open(document);
    // Файл мог быть активным и до этого: клик по его вкладке всё равно должен
    // показать файл, а не оставить на экране страницу браузера. Ей нужен отдельный
    // сигнал: её активность живёт в другой модели, и `openEditors.activate`
    // при том же файле события не шлёт.
    browserStrip.deactivate();
  });

  /**
   * Переставить вкладку: перетаскивание в полосе.
   *
   * `null` вместо цели — в конец. Модель бережёт границу закреплённых сама
   * (см. `OpenEditors.move`), здесь только вызов.
   */
  define({ id: 'file.moveTab', title: 'Переставить вкладку', category: 'Файл' }, (path, before) => {
    if (typeof path !== 'string') return;
    openEditors.move(path, typeof before === 'string' && before.length > 0 ? before : null);
  });

  // Перебор вкладок по порядку использования — как в VS Code: полоса хранит свой порядок,
  // а `Ctrl+Tab` идёт по истории показов. Снимок порядка держит `openEditors`.
  const cycleTab = (step: 1 | -1): void => {
    const path = openEditors.cycleRecent(step);
    if (!path) return;
    openEditors.activate(path);
    const document = documents.get(path);
    if (document && !isImagePath(path) && !isOfficePath(path)) editors.open(document);
    browserStrip.deactivate();
  };

  define(
    {
      id: 'file.previousRecent',
      title: 'Вкладка: предыдущая по использованию',
      category: 'Файл',
      keybinding: 'Ctrl+Tab',
    },
    () => cycleTab(1),
  );

  define(
    {
      id: 'file.nextRecent',
      title: 'Вкладка: следующая по использованию',
      category: 'Файл',
      keybinding: 'Ctrl+Shift+Tab',
    },
    () => cycleTab(-1),
  );

  define(
    {
      id: 'file.close',
      title: 'Закрыть вкладку',
      category: 'Файл',
      keybinding: 'Ctrl+W',
      // Закрывать есть что и тогда, когда на экране страница или чат: Ctrl+W относится
      // к показанной вкладке, а не только к последнему файлу в фоне.
      enabled: () => openEditors.active !== null || straysShown(),
    },
    (path) => {
      // Без явного пути (Ctrl+W) закрывается ТА вкладка, что показана. Иначе при
      // открытом чате или странице команда молча закрывала бы файл за ними.
      if (typeof path !== 'string') {
        const pageId = browserStrip.activePageId;
        if (pageId !== null) {
          browserPages.close(pageId);
          return;
        }
      }
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      if (!target) return;
      openEditors.close(target);
      const next = openEditors.active;
      if (next) editors.open(next);
    },
  );

  // Закрепление вкладки: закреплённую не вытесняет предпросмотр, и её не трогает
  // «закрыть другие». Тумблер — одна команда и в меню вкладки, и в палитре.
  define({ id: 'file.togglePin', title: 'Закрепить/открепить вкладку', category: 'Файл' }, (path) => {
    const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
    if (!target) return;
    if (openEditors.isPinned(target)) openEditors.unpin(target);
    else openEditors.pin(target);
  });

  define(
    {
      id: 'file.closeOthers',
      title: 'Закрыть другие вкладки',
      category: 'Файл',
      enabled: () => openEditors.paths.length > 1,
    },
    (path) => {
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      if (target) openEditors.closeOthers(target);
    },
  );
}
