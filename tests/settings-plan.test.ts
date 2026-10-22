import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/shared/api';
import { settingsPlan } from '../src/shared/settings-plan';

/**
 * Заготовка настроек: полный объект собирать незачем — план читает только блоки
 * `editor`, `lsp` и `run`. Остальное поля нам не нужны, поэтому приведение типа.
 */
function settings(): Settings {
  return {
    editor: { spellWords: [], autoSave: 'afterDelay', autoSaveDelayMs: 1000 },
    lsp: { enabled: true },
    run: { pythonPath: '', packageManager: 'auto' },
  } as unknown as Settings;
}

describe('план применения настроек', () => {
  it('ничего не перестраивает, когда ничего не менялось', () => {
    const value = settings();
    expect(settingsPlan(value, structuredClone(value))).toEqual({
      spellWords: false,
      autoSave: false,
      warmLsp: false,
      imports: false,
    });
  });

  it('словарь человека пересобирается только при смене списка слов', () => {
    const before = settings();
    const after = structuredClone(before);
    after.editor.spellWords = ['чаво'];
    expect(settingsPlan(before, after).spellWords).toBe(true);
  });

  it('автосохранение перезапускается и от смены паузы, не только режима', () => {
    const before = settings();
    const after = structuredClone(before);
    after.editor.autoSaveDelayMs = before.editor.autoSaveDelayMs + 500;
    expect(settingsPlan(before, after).autoSave).toBe(true);
  });

  it('серверы будят только на включении того же тумблера', () => {
    const before = settings();
    const off = structuredClone(before);
    off.lsp.enabled = false;
    const on = structuredClone(before);
    on.lsp.enabled = true;
    expect(settingsPlan(off, on).warmLsp).toBe(true);
    expect(settingsPlan(on, off).warmLsp).toBe(false);
  });

  it('импорты перепроверяются по значению блока запуска, а не по ссылке', () => {
    const before = settings();
    const same = structuredClone(before);
    // Тот же самое содержимое — новый объект: разбор JSON делает так каждый раз.
    expect(settingsPlan(before, same).imports).toBe(false);
    const changed = structuredClone(before);
    changed.run.pythonPath = '/usr/bin/python3';
    expect(settingsPlan(before, changed).imports).toBe(true);
  });
});
