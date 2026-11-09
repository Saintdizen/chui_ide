import { describe, expect, it } from 'vitest';
import { chatTabMenuPlan } from '../src/renderer/ui/chat';

/**
 * П.9: «Контекстное меню: группы и подменю».
 *
 * До правки меню вкладки беседы было плоским списком из трёх пунктов, где два
 * экспорта были близнецами-соседями («Экспорт в Markdown», «Экспорт в JSON»).
 * Теперь это группа из подменю и отдельно группа закрытия: закрыть одну, другие,
 * все — разное по последствию, а стояло вперемешку с выводом.
 */
const plan = (overrides: Partial<Parameters<typeof chatTabMenuPlan>[0]> = {}) =>
  chatTabMenuPlan({ empty: false, others: true, ...overrides }, {
    exportAs: () => undefined, close: () => undefined,
    closeOthers: () => undefined, closeAll: () => undefined,
  });

type Item = ReturnType<typeof chatTabMenuPlan>[number];

const labels = (items: readonly Item[]) => items.map((item) => ('label' in item ? item.label : '—'));

const find = (items: readonly Item[], label: string) => items.find((item) => 'label' in item && item.label === label);

describe('меню вкладки беседы', () => {
  it('экспорт — группа из подменю, а не два близнеца-соседа', () => {
    const items = plan();
    const exportItem = find(items, 'Экспорт') as { submenu?: { label: string }[] };
    expect(exportItem.submenu?.map((entry) => entry.label)).toEqual(['В Markdown…', 'В JSON…']);
  });

  it('закрытие отделено от экспорта разделителем', () => {
    expect(labels(plan())).toEqual(['Экспорт', '—', 'Закрыть беседу', 'Закрыть другие беседы', 'Закрыть все беседы']);
  });

  it('пустая беседа гасит экспорт, но пункт не исчезает', () => {
    const exportItem = find(plan({ empty: true }), 'Экспорт');
    expect(exportItem).toMatchObject({ enabled: false });
  });

  // Источник требует гасить недоступное на месте: исчезающий пункт двигал бы
  // остальные под курсором ровно в момент клика.
  it('с одной беседой «другие» и «все» погашены, но на месте', () => {
    const items = plan({ others: false });
    expect(find(items, 'Закрыть другие беседы')).toMatchObject({ enabled: false });
    expect(find(items, 'Закрыть все беседы')).toMatchObject({ enabled: false });
    expect(labels(items)).toContain('Закрыть все беседы');
  });

  it('с несколькими беседами закрытие доступно', () => {
    const items = plan({ others: true });
    expect(find(items, 'Закрыть другие беседы')).toMatchObject({ enabled: true });
    expect(find(items, 'Закрыть все беседы')).toMatchObject({ enabled: true });
  });
});
