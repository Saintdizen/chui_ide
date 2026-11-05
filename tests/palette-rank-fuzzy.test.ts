import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../src/renderer/core/commands';
import { rankCommandMatches, rankCommands } from '../src/renderer/core/palette-rank';

/**
 * Нечёткий поиск в палитре: буквы по порядку, но не подряд.
 *
 * Смысл — `свн` → «Свернуть всё». Без этого приходится помнить слово целиком,
 * а палитра нужна как раз тогда, когда помнишь обрывки.
 */
const command = (id: string, title: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor =>
  ({ id, title, category: 'Вид', ...extra }) as CommandDescriptor;

const registry: CommandDescriptor[] = [
  command('view.collapseAll', 'Свернуть всё'),
  command('view.expandAll', 'Развернуть всё'),
  command('panel.toggle', 'Скрыть панель'),
  command('editor.wordWrap', 'Перенос строк'),
];

const titles = (query: string): string[] => (rankCommands(registry, query) ?? []).map((item) => item.title);

describe('буквы по порядку', () => {
  it('`свн` находит «Свернуть всё»', () => {
    expect(titles('свн')).toContain('Свернуть всё');
  });

  it('нечёткое идёт после совпадений по словам', () => {
    // «Свернуть» начинается с запроса, поэтому первая; нечёткие — следом.
    expect(titles('свернуть')[0]).toBe('Свернуть всё');
  });

  it('порядок букв важен: `нврс` не находит', () => {
    expect(titles('нврс')).toEqual([]);
  });

  it('буквы из разных слов названия считаются: `свсе` → «Свернуть всё»', () => {
    expect(titles('свсе')).toContain('Свернуть всё');
  });

  it('ё и регистр не мешают', () => {
    expect(titles('свёрн').length).toBeGreaterThan(0);
    expect(titles('СВН')).toContain('Свернуть всё');
  });
});

describe('что подсветить', () => {
  it('позиции — индексы ИСХОДНОГО названия, а не свёрнутого', () => {
    const [first] = rankCommandMatches(registry, 'свн') ?? [];
    expect(first?.descriptor.title).toBe('Свернуть всё');
    // с(0) в(1) н(4): «Свернуть» — с, в, потом н в середине.
    expect(first?.positions).toEqual([0, 1, 4]);
  });

  it('совпадение по слову подсвечивает целое слово', () => {
    const [first] = rankCommandMatches(registry, 'панель') ?? [];
    expect(first?.descriptor.title).toBe('Скрыть панель');
    expect(first?.positions).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('точное совпадение подсвечивает всё название', () => {
    const [first] = rankCommandMatches(registry, 'свернуть всё') ?? [];
    expect(first?.positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('ё находит е, а подсветка ложится на реальный символ', () => {
    const withYo = [command('a', 'Свёртка')];
    const [first] = rankCommandMatches(withYo, 'сверт') ?? [];
    expect(first?.positions).toEqual([0, 1, 2, 3, 4]);
  });

  it('пустой запрос — это «не искали»: null, а не список', () => {
    // На `null` палитра показывает историю; пустой список она показала бы как
    // «ничего не нашлось», и это была бы неправда.
    expect(rankCommandMatches(registry, '  ')).toBeNull();
  });

  it('нет совпадений — пустой список: искали и не нашли', () => {
    expect(rankCommandMatches(registry, 'ъъъ')).toEqual([]);
  });
});
