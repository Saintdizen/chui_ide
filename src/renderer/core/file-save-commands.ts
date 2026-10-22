import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';
import type { TextDocument } from './document';
import type { OpenEditors } from './open-editors';

/** Хранилище буферов — ровно две операции из всего интерфейса. */
export interface DocumentBuffers {
  get(path: string): TextDocument | undefined;
  dirty(): TextDocument[];
}

/**
 * Сохранение и перечитывание с диска.
 *
 * Сама запись буфера (`saveDocument`, `saveDocumentAs`, `revertFilesToDisk`)
 * остаётся в `app.ts`: она знает про rpc и про пометку вкладки сохранённой.
 * Здесь — только команды: какая цель выбрана и что сказать человеку, если цели нет.
 *
 * Аргумент пути приходит из меню вкладки, поэтому у части команд есть выбор:
 * явный путь важнее активного файла — иначе правый клик сохранял бы соседа.
 */
export interface FileSaveDeps {
  openEditors: OpenEditors;
  documents: DocumentBuffers;
  saveDocument(document: TextDocument): Promise<boolean>;
  saveDocumentAs(document: TextDocument): Promise<boolean>;
  revertFilesToDisk(targets: readonly string[]): Promise<void>;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
}

export function registerFileSaveCommands(define: DefineCommand, deps: FileSaveDeps): void {
  const { openEditors, documents, saveDocument, saveDocumentAs, revertFilesToDisk, showToast } = deps;
  define(
    {
      id: 'file.save',
      title: 'Сохранить',
      category: 'Файл',
      keybinding: 'Ctrl+S',
      enabled: () => openEditors.active !== null,
    },
    async () => {
      const document = openEditors.active;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      await saveDocument(document);
    },
  );

  define(
    {
      id: 'file.saveAs',
      title: 'Сохранить как…',
      category: 'Файл',
      keybinding: 'Ctrl+Shift+S',
      enabled: () => openEditors.active !== null,
    },
    // Путь приходит из меню вкладки: сохраняем тот файл, по которому кликнули,
    // а не активный. Без аргумента — активный (палитра, горячая клавиша).
    async (path) => {
      const target = typeof path === 'string' ? path : (openEditors.active?.path ?? null);
      const document = target ? (documents.get(target) ?? null) : null;
      if (!document) {
        showToast('Нет открытого файла');
        return;
      }
      await saveDocumentAs(document);
    },
  );

  define(
    {
      id: 'file.saveAll',
      title: 'Сохранить всё',
      category: 'Файл',
      // Ctrl+Shift+S отдано «Сохранить как…» — привычному сочетанию.
      keybinding: 'Ctrl+Alt+S',
      enabled: () => documents.dirty().length > 0,
    },
    async () => {
      const dirty = documents.dirty();
      if (dirty.length === 0) {
        showToast('Все файлы уже сохранены');
        return;
      }
      for (const document of dirty) await saveDocument(document);
    },
  );

  // Возврат к версии на диске. Нужен там, где буфер разошёлся с файлом: правки
  // записал другой инструмент или они легли мимо. Без этой команды такой документ
  // оставался бы «не сохранён» до самого закрытия вкладки.
  define(
    {
      id: 'file.revertFromDisk',
      title: 'Перечитать с диска (отменить правки в буфере)',
      category: 'Файл',
      // Доступна, пока есть хоть один правленый буфер: команда умеет и путь в аргументе
      // (правый клик по вкладке), и активный файл — гасить её по одному файлу незачем.
      enabled: () => documents.dirty().length > 0,
    },
    (pathArg) => {
      const target = typeof pathArg === 'string' ? pathArg : (openEditors.active?.path ?? null);
      if (!target) return;
      return revertFilesToDisk([target]);
    },
  );

  // То же для всех разом: файлов в буфере бывает несколько, и закрывать окно,
  // отвечая по одному, — лишняя работа.
  define(
    {
      id: 'file.revertAllFromDisk',
      title: 'Перечитать все файлы с диска',
      category: 'Файл',
      enabled: () => documents.dirty().length > 0,
    },
    () => revertFilesToDisk(documents.dirty().map((document) => document.path)),
  );
}
