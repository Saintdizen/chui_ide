import { describe, expect, it } from 'vitest';
import { terminalSnapshot } from '../src/shared/terminal-snapshot';
import type { Cell, Line } from '../src/renderer/terminal/core/screen';

/**
 * Вывод терминала как контекст для модели. Терминал рисует прямоугольник:
 * пробелы до края и пустые строки подвала — его, а не смысл. Если их не
 * убрать, модель получает сотни пустых токенов вместо ошибки сборки.
 */

const cell = (chars: string, width = 1): Cell => ({ chars, width, attr: {} as Cell['attr'] });
const line = (text: string): Line => ({ cells: [...text].map((ch) => cell(ch)), wrapped: false });

describe('terminalSnapshot', () => {
  it('отрезает пустые строки в конце', () => {
    const snapshot = terminalSnapshot([line('npm ERR! build failed'), line(''), line('')]);
    expect(snapshot.text).toBe('npm ERR! build failed');
    expect(snapshot.lines).toBe(1);
  });

  it('убирает пробелы до правого края', () => {
    const snapshot = terminalSnapshot([line('error: 1        ')]);
    expect(snapshot.text).toBe('error: 1');
  });

  it('берёт последние строки по пределу', () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(`line ${i}`));
    const snapshot = terminalSnapshot(lines, 10);
    expect(snapshot.lines).toBe(10);
    expect(snapshot.text.startsWith('line 90')).toBe(true);
  });

  it('пустой экран — пустой контекст, а не сотня переводов', () => {
    expect(terminalSnapshot([line(''), line('')])).toEqual({ text: '', lines: 0 });
  });

  it('широкий знак не раздваивается', () => {
    const wide: Line = { cells: [cell('я'), cell('', 0), cell('x')], wrapped: false };
    expect(terminalSnapshot([wide]).text).toBe('яx');
  });
});
