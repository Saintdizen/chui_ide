import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createSymbolPicker } from '../src/renderer/ui/symbol-picker';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Ctrl+Enter в палитре символов открывает файл РЯДОМ, а Enter — в текущей панели.
 * Здесь проверяем, что палитра передаёт `side=true` наружу (раскладку делает app.ts).
 */
describe('symbol-picker: открыть рядом', () => {
  beforeEach(() => {
    // fake timers ДО mini-dom: иначе window.setTimeout держит настоящий таймер.
    vi.useFakeTimers();
    installMiniDom();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const found = [{ name: 'getTitle', kind: 'функция', container: null, path: '/p/a.ts', line: 3, column: 1 }];
  const rpc = { request: vi.fn(async () => found) } as never;
  async function typeAndWait(input: {
    value: string;
    dispatchEvent: (e: Record<string, unknown>) => void;
  }): Promise<void> {
    input.value = 'get';
    input.dispatchEvent({ type: 'input' });
    await vi.runAllTimersAsync();
  }

  it('Ctrl+Enter передаёт side=true', async () => {
    const openSymbol = vi.fn();
    const picker = createSymbolPicker({ rpc, openSymbol });
    const input = picker.element.querySelector('input') as unknown as {
      value: string;
      dispatchEvent: (e: Record<string, unknown>) => void;
    };
    picker.open();
    await typeAndWait(input);
    input.dispatchEvent({ type: 'keydown', key: 'Enter', ctrlKey: true, preventDefault() {} });
    expect(openSymbol).toHaveBeenCalledWith(expect.objectContaining({ name: 'getTitle' }), true);
  });

  it('Enter без модификатора открывает в текущей панели', async () => {
    const openSymbol = vi.fn();
    const picker = createSymbolPicker({ rpc, openSymbol });
    const input = picker.element.querySelector('input') as unknown as {
      value: string;
      dispatchEvent: (e: Record<string, unknown>) => void;
    };
    picker.open();
    await typeAndWait(input);
    input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    expect(openSymbol).toHaveBeenCalledWith(expect.objectContaining({ name: 'getTitle' }), false);
  });

  it('minQuery:0 — грузит источник сразу при открытии', async () => {
    const openSymbol = vi.fn();
    const load = vi.fn(async () => [
      { name: 'alpha', kind: 'метод', container: 'Класс', path: '/p/a.ts', line: 2, column: 1 },
    ]);
    const picker = createSymbolPicker({
      rpc,
      openSymbol,
      source: { placeholder: 'x', breadcrumb: true, minQuery: 0, load },
    });
    picker.open();
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledWith('');
    const row = picker.element.querySelector('.palette-item');
    expect(row).not.toBeNull();
  });

  it('@kind фильтрует по виду символа', async () => {
    const openSymbol = vi.fn();
    const load = vi.fn(async () => [
      { name: 'run', kind: 'метод', container: null, path: '/p/a.ts', line: 1, column: 1 },
      { name: 'box', kind: 'переменная', container: null, path: '/p/a.ts', line: 9, column: 1 },
    ]);
    const picker = createSymbolPicker({
      rpc,
      openSymbol,
      source: { placeholder: 'x', minQuery: 0, load },
    });
    picker.open();
    await vi.runAllTimersAsync();
    const input = picker.element.querySelector('input') as unknown as {
      value: string;
      dispatchEvent: (e: Record<string, unknown>) => void;
    };
    input.value = '@перем';
    input.dispatchEvent({ type: 'input' });
    await vi.runAllTimersAsync();
    const names = [
      ...(picker.element.querySelectorAll('.palette-item-title') as unknown as Array<{ textContent?: string }>),
    ].map((n) => n.textContent);
    expect(names).toEqual(['box']);
  });
});
