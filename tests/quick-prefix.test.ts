import { describe, expect, it } from 'vitest';
import { QUICK_MODES, parseQuickPrefix, prefixOf } from '../src/renderer/core/quick-prefix';

/**
 * Один ввод — четыре режима. Ошибка в разборе не видна: список просто
 * оказывается не тем, и человек ищет причину не там.
 */
describe('разбор префикса', () => {
  it('без префикса — файлы', () => {
    expect(parseQuickPrefix('ui/chat.ts')).toEqual({ mode: 'files', query: 'ui/chat.ts', marker: '' });
  });

  it('`>` — команды', () => {
    expect(parseQuickPrefix('>свернуть')).toEqual({ mode: 'commands', query: 'свернуть', marker: '>' });
  });

  it('`@` — символы файла, `#` — поиск по проекту', () => {
    expect(parseQuickPrefix('@render').mode).toBe('symbols');
    expect(parseQuickPrefix('#createElement').mode).toBe('text');
  });

  it('пробел между знаком и запросом не мешает', () => {
    expect(parseQuickPrefix('>  свернуть')).toEqual({ mode: 'commands', query: 'свернуть', marker: '>' });
  });

  it('пробел перед префиксом не мешает: человек мог кликнуть в поле и нажать пробел', () => {
    expect(parseQuickPrefix('  >свернуть').mode).toBe('commands');
  });

  it('префикс только в начале: `a > b` — это имя файла', () => {
    expect(parseQuickPrefix('a > b')).toEqual({ mode: 'files', query: 'a > b', marker: '' });
  });

  it('один знак и есть весь запрос', () => {
    expect(parseQuickPrefix('>')).toEqual({ mode: 'commands', query: '', marker: '>' });
  });

  it('обратный ход: префикс восстанавливается по режиму', () => {
    for (const { marker, mode } of QUICK_MODES) expect(prefixOf(mode)).toBe(marker);
  });
});
