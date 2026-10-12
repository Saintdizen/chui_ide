import { describe, expect, it } from 'vitest';
import { KeybindingService, comboFromEvent, isModifierKey, type Keybinding } from '../src/renderer/core/keybindings';
import { normalizeKeybindingOverrides } from '../src/shared/keybindings';
import type { CommandRegistry } from '../src/renderer/core/commands';

/**
 * Горячие клавиши: приведение переопределений из настроек и наложение их на сочетания
 * по умолчанию. Проверяется без DOM: `effective` не трогает окно, а `comboFromEvent`
 * читает только поля события.
 */
describe('normalizeKeybindingOverrides', () => {
  it('мусор отбрасывается', () => {
    expect(normalizeKeybindingOverrides(undefined)).toEqual([]);
    expect(normalizeKeybindingOverrides('x')).toEqual([]);
    expect(normalizeKeybindingOverrides([1, null, {}, { command: '', combo: 'Ctrl+K' }])).toEqual([]);
  });

  it('команда одна: последнее переопределение выигрывает', () => {
    expect(
      normalizeKeybindingOverrides([
        { command: 'a', combo: 'Ctrl+1' },
        { command: 'a', combo: 'Ctrl+2' },
      ]),
    ).toEqual([{ command: 'a', combo: 'Ctrl+2' }]);
  });

  it('сочетание подрезается, пустое допустимо (снятие)', () => {
    expect(normalizeKeybindingOverrides([{ command: 'a', combo: '  Ctrl+K ' }])).toEqual([
      { command: 'a', combo: 'Ctrl+K' },
    ]);
    expect(normalizeKeybindingOverrides([{ command: 'a', combo: '' }])).toEqual([{ command: 'a', combo: '' }]);
  });
});

describe('comboFromEvent', () => {
  const event = (parts: Partial<KeyboardEvent>): KeyboardEvent => parts as unknown as KeyboardEvent;

  it('собирает модификаторы и знак в привычном порядке', () => {
    expect(comboFromEvent(event({ ctrlKey: true, shiftKey: true, key: 'k' }))).toBe('Ctrl+Shift+K');
  });

  it('Cmd на macOS считается как Ctrl', () => {
    expect(comboFromEvent(event({ metaKey: true, key: 'p' }))).toBe('Ctrl+P');
  });

  it('функциональные и прочие непечатные клавиши проходят как есть', () => {
    expect(comboFromEvent(event({ key: 'F5' }))).toBe('F5');
    expect(comboFromEvent(event({ ctrlKey: true, key: 'Escape' }))).toBe('Ctrl+Escape');
  });
});

describe('isModifierKey', () => {
  it('модификаторы — не сочетание', () => {
    expect(isModifierKey('Control')).toBe(true);
    expect(isModifierKey('Shift')).toBe(true);
    expect(isModifierKey('k')).toBe(false);
    expect(isModifierKey('F5')).toBe(false);
  });
});

describe('KeybindingService.effective', () => {
  const defaults: readonly Keybinding[] = [
    { combo: 'Ctrl+K', command: 'a' },
    { combo: 'Ctrl+J', command: 'b' },
  ];
  const commands = {} as CommandRegistry;
  const service = (overrides: ReturnType<typeof normalizeKeybindingOverrides>): KeybindingService =>
    new KeybindingService(commands, defaults, () => overrides);

  it('без переопределений — сочетания по умолчанию', () => {
    expect(service([]).effective()).toEqual([
      { combo: 'Ctrl+K', command: 'a' },
      { combo: 'Ctrl+J', command: 'b' },
    ]);
  });

  it('переопределение заменяет сочетание команды', () => {
    expect(service([{ command: 'a', combo: 'Ctrl+9' }]).effective()).toEqual([
      { combo: 'Ctrl+9', command: 'a' },
      { combo: 'Ctrl+J', command: 'b' },
    ]);
  });

  it('пустое сочетание снимает команду со списка', () => {
    expect(service([{ command: 'a', combo: '' }]).effective()).toEqual([{ combo: 'Ctrl+J', command: 'b' }]);
  });

  it('переопределение чужой команды ничего не меняет', () => {
    expect(service([{ command: 'zzz', combo: 'Ctrl+0' }]).effective()).toEqual([...defaults]);
  });
});
