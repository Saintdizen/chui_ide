import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';

/** Флаги режимов ввода и проверки — те, что переключаются командами. */
export type EditorModeName = 'vimMode' | 'emacsMode' | 'spellcheck';

export interface EditorModeActions {
  setVimMode(on: boolean): void;
  setEmacsMode(on: boolean): void;
  /** true — слово взято из-под каретки; false — брать нечего. */
  addSpellingWordToDictionary(): boolean;
  ignoreSpellingWord(): boolean;
}

export interface EditorModeDeps {
  editors: EditorModeActions;
  /** Текущее значение флага из настроек. */
  mode(name: EditorModeName): boolean;
  /** Записать флаг: локальные настройки и диск — одним шагом. */
  setMode(name: EditorModeName, on: boolean): void;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
  /** Чип режима в строке состояния — его надо перерисовать сразу. */
  refreshStatus(): void;
}

/**
 * Режимы ввода (Vim, Emacs) и орфография.
 *
 * Переключение применяется сразу и к уже открытым панелям, не дожидаясь повторного
 * чтения настроек: флаг живёт в двух местах (настройки и ввод редактора), и команда
 * обязана обновить оба. Чтение и запись флага приходят снаружи — здесь только
 * порядок «сначала применить, потом сообщить, потом сохранить».
 */
export function registerEditorModeCommands(define: DefineCommand, deps: EditorModeDeps): void {
  const { editors, mode, setMode, showToast, refreshStatus } = deps;

  /**
   * Vim-режим: модальное управление клавишами. Настройка переживает перезапуск, а
   * состояние (текущий режим) живёт в вводе редактора. Переключение применяется сразу,
   * не дожидаясь повторного чтения настроек.
   */
  define({ id: 'editor.toggleVim', title: 'Vim-режим: включить или выключить', category: 'Редактор' }, () => {
    const next = !mode('vimMode');
    editors.setVimMode(next);
    setMode('vimMode', next);
    refreshStatus();
    showToast(next ? 'Vim-режим включён' : 'Vim-режим выключен');
  });

  /**
   * Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода. Переключение применяется
   * сразу (и к уже открытым панелям), а не дожидается повторного чтения настроек.
   */
  define({ id: 'editor.toggleEmacs', title: 'Emacs-режим: включить или выключить', category: 'Редактор' }, () => {
    const next = !mode('emacsMode');
    editors.setEmacsMode(next);
    setMode('emacsMode', next);
    showToast(next ? 'Emacs-режим включён' : 'Emacs-режим выключен');
  });

  // Орфография: добавить слово под курсором в словарь или пропустить его на сеанс.
  define(
    {
      id: 'editor.addToDictionary',
      title: 'Орфография: добавить слово в словарь',
      category: 'Редактор',
      keywords: ['spell', 'dictionary', 'орфография', 'словарь'],
    },
    () => {
      if (!editors.addSpellingWordToDictionary()) showToast('Под курсором нет слова с ошибкой');
    },
  );

  define(
    {
      id: 'editor.ignoreSpelling',
      title: 'Орфография: пропустить слово',
      category: 'Редактор',
      keywords: ['spell', 'ignore', 'орфография', 'пропустить'],
    },
    () => {
      if (!editors.ignoreSpellingWord()) showToast('Под курсором нет слова с ошибкой');
    },
  );

  // Проверка живёт в настройках сервера языка: её включает он, а не редактор,
  // поэтому здесь нет применения «на месте» — только флаг и сохранение.
  define(
    {
      id: 'editor.toggleSpellcheck',
      title: 'Орфография: включить или выключить проверку',
      category: 'Редактор',
      keywords: ['spell', 'spellcheck', 'орфография'],
    },
    () => {
      setMode('spellcheck', !mode('spellcheck'));
    },
  );
}
