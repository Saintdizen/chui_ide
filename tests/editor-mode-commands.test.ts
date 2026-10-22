import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerEditorModeCommands, type EditorModeDeps, type EditorModeName } from '../src/renderer/core/editor-mode-commands';

type Run = (...args: unknown[]) => unknown;

function setup(initial: Partial<Record<EditorModeName, boolean>> = {}, hasWord = true) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  const flags = { vimMode: false, emacsMode: false, spellcheck: true, ...initial } as Record<EditorModeName, boolean>;
  const deps = {
    editors: {
      setVimMode: (on: boolean) => log.push(`apply:vim:${on}`),
      setEmacsMode: (on: boolean) => log.push(`apply:emacs:${on}`),
      addSpellingWordToDictionary: () => {
        log.push('dictionary');
        return hasWord;
      },
      ignoreSpellingWord: () => {
        log.push('ignore');
        return hasWord;
      },
    },
    mode: (name: EditorModeName) => flags[name],
    setMode: (name: EditorModeName, on: boolean) => {
      flags[name] = on;
      log.push(`save:${name}:${on}`);
    },
    showToast: (message: string) => toasts.push(message),
    refreshStatus: () => log.push('status'),
  } as unknown as EditorModeDeps;
  registerEditorModeCommands(define, deps);
  return { commands, log, toasts, flags };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerEditorModeCommands', () => {
  it('регистрирует пять команд режимов и орфографии', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'editor.addToDictionary',
      'editor.ignoreSpelling',
      'editor.toggleEmacs',
      'editor.toggleSpellcheck',
      'editor.toggleVim',
    ]);
  });

  it('Vim: применяется к редактору, сохраняется и обновляет строку состояния', () => {
    const f = setup();
    run(f, 'editor.toggleVim');
    expect(f.log).toEqual(['apply:vim:true', 'save:vimMode:true', 'status']);
    expect(f.toasts[0]).toBe('Vim-режим включён');
    expect(f.flags.vimMode).toBe(true);
  });

  it('Emacs переключается туда и обратно', () => {
    const f = setup({ emacsMode: true });
    run(f, 'editor.toggleEmacs');
    expect(f.flags.emacsMode).toBe(false);
    expect(f.toasts[0]).toBe('Emacs-режим выключен');
  });

  it('проверка орфографии — только флаг, редактор не трогаем', () => {
    const f = setup();
    run(f, 'editor.toggleSpellcheck');
    expect(f.log).toEqual(['save:spellcheck:false']);
    expect(f.flags.spellcheck).toBe(false);
  });

  it('словарь и пропуск: без слова под курсором не молчат', () => {
    const silent = setup({}, false);
    run(silent, 'editor.addToDictionary');
    run(silent, 'editor.ignoreSpelling');
    expect(silent.toasts).toEqual(['Под курсором нет слова с ошибкой', 'Под курсором нет слова с ошибкой']);
    const ok = setup();
    run(ok, 'editor.addToDictionary');
    expect(ok.toasts).toEqual([]);
    expect(ok.log).toEqual(['dictionary']);
  });
});
