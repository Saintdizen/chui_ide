import { describe, expect, it } from 'vitest';
import { TODO_QUERY, registerSearchCommands, type SearchDeps } from '../src/renderer/core/search-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Три команды поиска ведут в одну панель, и разница только в запросе: пустой,
 * готовый (пометки) или никакой (структурный поиск со своим окном). Сторож держит
 * именно это: поиск по проекту не должен запускать запрос сам.
 */
function setup() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const shown: string[] = [];
  const searched: { query: string; isRegex: boolean }[] = [];
  const structural: number[] = [];
  const deps = {
    dock: { show: (view: string) => shown.push(view) },
    searchView: {
      search: (query: string, options: { isRegex: boolean }) => searched.push({ query, isRegex: options.isRegex }),
    },
    structuralSearch: { open: () => structural.push(1) },
  } as unknown as SearchDeps;
  registerSearchCommands(define, deps);
  return { commands, shown, searched, structural };
}

describe('registerSearchCommands', () => {
  it('регистрирует три команды поиска', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual(['editor.structuralReplace', 'search.project', 'search.todo']);
  });

  it('поиск по проекту только показывает панель, запрос не запускает', async () => {
    const { commands, shown, searched } = setup();
    await commands.get('search.project')!();
    expect(shown).toEqual(['search']);
    expect(searched).toEqual([]);
  });

  it('поиск пометок открывает панель и запускает регулярку', async () => {
    const { commands, shown, searched } = setup();
    await commands.get('search.todo')!();
    expect(shown).toEqual(['search']);
    expect(searched).toEqual([{ query: TODO_QUERY, isRegex: true }]);
  });

  it('регулярка пометок ловит целые слова, а не подстроки', () => {
    const pattern = new RegExp(TODO_QUERY);
    expect(pattern.test('// TODO: доделать')).toBe(true);
    expect(pattern.test('// FIXME позже')).toBe(true);
    // Иначе шум съел бы полезное: TODOS и hackathon — не пометки.
    expect(pattern.test('const TODOS = 3')).toBe(false);
    expect(pattern.test('hackathon()')).toBe(false);
  });

  it('структурный поиск открывает своё окно, а не панель', async () => {
    const { commands, shown, searched, structural } = setup();
    await commands.get('editor.structuralReplace')!();
    expect(structural).toHaveLength(1);
    expect(shown).toEqual([]);
    expect(searched).toEqual([]);
  });
});
