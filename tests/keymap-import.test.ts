import { describe, expect, it } from 'vitest';
import { importIdeaKeymap, importVsCodeKeymap, mergeImportedOverrides } from '../src/shared/keymap-import';

/**
 * Импорт чужих карт клавиш. Главное: не связать команду с клавишей, которая
 * делает не то; не потерять «снять сочетание»; не перебить настроенное.
 */
describe('importVsCodeKeymap', () => {
  it('читает комментарии и хвостовые запятые — так пишет VS Code', () => {
    const text = `[
      // моё
      { "key": "ctrl+s", "command": "workbench.action.files.save" },
      { "key": "ctrl+shift+f", "command": "workbench.action.findInFiles", },
    ]`;
    const result = importVsCodeKeymap(text);
    expect(result.overrides).toEqual([
      { command: 'file.save', combo: 'Ctrl+S' },
      { command: 'search.project', combo: 'Ctrl+Shift+F' },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('`-команда` — снятие сочетания, а не пропуск', () => {
    const result = importVsCodeKeymap('[{"key":"ctrl+s","command":"-workbench.action.files.save"}]');
    expect(result.overrides).toEqual([{ command: 'file.save', combo: '' }]);
  });

  it('неизвестная команда — в unknown, а не привязана наугад', () => {
    const result = importVsCodeKeymap('[{"key":"ctrl+k","command":"workbench.action.terminal.split"}]');
    expect(result.overrides).toEqual([]);
    expect(result.unknown).toEqual(['workbench.action.terminal.split']);
    expect(result.total).toBe(1);
  });

  it('незнакомый модификатор — сочетание отброшено', () => {
    // hyper+... у нас не нажмётся; связать с ним команду значит соврать.
    const result = importVsCodeKeymap('[{"key":"hyper+s","command":"workbench.action.files.save"}]');
    expect(result.overrides).toEqual([]);
  });

  it('cmd считается Ctrl: иначе Mac-раскладка не нажмётся вовсе', () => {
    const result = importVsCodeKeymap('[{"key":"cmd+s","command":"workbench.action.files.save"}]');
    expect(result.overrides[0]!.combo).toBe('Ctrl+S');
  });

  it('служебные клавиши названы нашими именами', () => {
    const result = importVsCodeKeymap('[{"key":"ctrl+esc","command":"workbench.action.showCommands"}]');
    expect(result.overrides[0]!.combo).toBe('Ctrl+Escape');
  });

  it('не массив — ошибка словами, а не молчание', () => {
    expect(importVsCodeKeymap('{}').error).toBeTruthy();
  });

  it('битый JSON — ошибка, без падения', () => {
    expect(importVsCodeKeymap('[{"key": ').error).toBeTruthy();
  });
});

describe('importIdeaKeymap', () => {
  it('читает действие и сочетание', () => {
    const xml = `<keymap><action id="ReformatCode"><keyboard-shortcut keymap="$default" first-keystroke="ctrl alt L"/></action></keymap>`;
    expect(importIdeaKeymap(xml).overrides).toEqual([{ command: 'editor.format', combo: 'Ctrl+Alt+L' }]);
  });

  it('несколько сочетаний у действия — все', () => {
    const xml = `<action id="Find"><keyboard-shortcut first-keystroke="ctrl f"/><keyboard-shortcut first-keystroke="alt f3"/></action>`;
    expect(importIdeaKeymap(xml).overrides.map((entry) => entry.combo)).toEqual(['Ctrl+F', 'Alt+F3']);
  });

  it('неизвестное действие — в unknown', () => {
    const xml = `<action id="SomePluginAction"><keyboard-shortcut first-keystroke="ctrl q"/></action>`;
    const result = importIdeaKeymap(xml);
    expect(result.overrides).toEqual([]);
    expect(result.unknown).toEqual(['SomePluginAction']);
  });

  it('действие без сочетаний не считается', () => {
    expect(importIdeaKeymap('<action id="Find"></action>').total).toBe(0);
  });
});

describe('mergeImportedOverrides', () => {
  it('своё не перебивается импортом', () => {
    const mine = [{ command: 'file.save', combo: 'Ctrl+Shift+S' }];
    const imported = [
      { command: 'file.save', combo: 'Ctrl+S' },
      { command: 'editor.format', combo: 'Ctrl+Alt+L' },
    ];
    const merged = mergeImportedOverrides(mine, imported);
    expect(merged.overrides).toEqual([
      { command: 'file.save', combo: 'Ctrl+Shift+S' },
      { command: 'editor.format', combo: 'Ctrl+Alt+L' },
    ]);
    expect(merged.skipped).toBe(1);
  });
});
