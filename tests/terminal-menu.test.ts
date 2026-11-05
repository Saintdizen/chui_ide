import { describe, expect, it, vi } from 'vitest';
import { terminalMenuItems, type TerminalMenuActions } from '../src/renderer/ui/terminal';

/**
 * П.9: «Контекстное меню: группы и подменю».
 *
 * У консоли меню не было вовсе — в коде это было записано честно: «событие
 * `paste` тоже слушаем: его пришлёт контекстное меню и вставка мышью», а само
 * меню никто не строил. Значит и скопировать выделенное мышью было нечем:
 * `Ctrl+C` в терминале — сигнал процессу.
 */
function actions(overrides: Partial<TerminalMenuActions> = {}): TerminalMenuActions {
  return {
    hasSelection: false,
    exited: false,
    copy: vi.fn(),
    paste: vi.fn(),
    find: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    ...overrides,
  };
}

const labels = (items: ReturnType<typeof terminalMenuItems>) =>
  items.map((item) => ('label' in item ? item.label : '—'));

const find = (items: ReturnType<typeof terminalMenuItems>, label: string) =>
  items.find((item) => 'label' in item && item.label === label);

describe('меню консоли', () => {
  it('пункты идут группами: буфер, экран, опасное', () => {
    expect(labels(terminalMenuItems(actions()))).toEqual([
      'Копировать',
      'Вставить',
      '—',
      'Найти в консоли',
      'Очистить экран',
      '—',
      'Завершить процесс',
    ]);
  });

  it('сочетания подписаны у тех пунктов, у которых они есть', () => {
    const items = terminalMenuItems(actions());
    expect(find(items, 'Копировать')).toMatchObject({ hint: 'Ctrl+Shift+C' });
    expect(find(items, 'Вставить')).toMatchObject({ hint: 'Ctrl+V' });
    // У очистки и завершения сочетания нет — выдумывать подпись нельзя.
    expect(find(items, 'Очистить экран')).not.toHaveProperty('hint');
  });

  // Копирование по Ctrl+C в терминале — сигнал. Мышиное выделение без меню
  // не скопировать, поэтому пункт обязан работать.
  it('«Копировать» гаснет без выделения, но не исчезает', () => {
    const items = terminalMenuItems(actions({ hasSelection: false }));
    expect(find(items, 'Копировать')).toMatchObject({ enabled: false });
    expect(labels(items)).toContain('Копировать');
  });

  it('с выделением «Копировать» работает', () => {
    const acts = actions({ hasSelection: true });
    const items = terminalMenuItems(acts);
    expect(find(items, 'Копировать')).toMatchObject({ enabled: true });
    (find(items, 'Копировать') as { onSelect: () => void }).onSelect();
    expect(acts.copy).toHaveBeenCalled();
  });

  it('в завершённой сессии «Завершить процесс» погашен, но на месте', () => {
    const items = terminalMenuItems(actions({ exited: true }));
    expect(find(items, 'Завершить процесс')).toMatchObject({ enabled: false, danger: true });
  });

  it('завершение — в опасной группе, последним', () => {
    const items = terminalMenuItems(actions());
    expect(items.at(-1)).toMatchObject({ label: 'Завершить процесс', danger: true });
  });
});
