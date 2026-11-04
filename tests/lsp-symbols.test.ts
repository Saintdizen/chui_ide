import { describe, expect, it } from 'vitest';
import {
  filterSymbols,
  flattenFileSymbols,
  mergeSymbols,
  toProjectSymbols,
  type FileSymbol,
  type ProjectSymbol,
} from '../src/shared/lsp-symbols';

/** Маппер ссылки в путь: в main это `fileURLToPath`, в тесте — простая замена. */
const toPath = (uri: string): string => decodeURIComponent(uri.replace('file://', ''));

describe('toProjectSymbols', () => {
  it('разбирает SymbolInformation с координатами', () => {
    const raw = [
      {
        name: 'Session',
        kind: 5,
        containerName: 'app.auth',
        location: { uri: 'file:///p/app/auth.py', range: { start: { line: 9, character: 6 } } },
      },
    ];
    expect(toProjectSymbols(raw, toPath)).toEqual([
      { name: 'Session', kind: 'класс', container: 'app.auth', path: '/p/app/auth.py', line: 10, column: 7 },
    ]);
  });

  it('без диапазона координаты — начало файла', () => {
    const raw = [{ name: 'x', kind: 13, location: { uri: 'file:///p/a.py' } }];
    expect(toProjectSymbols(raw, toPath)[0]).toMatchObject({ path: '/p/a.py', line: 1, column: 1 });
  });

  it('неизвестный вид символа — общая подпись', () => {
    const raw = [{ name: 'x', kind: 99, location: { uri: 'file:///p/a.py' } }];
    expect(toProjectSymbols(raw, toPath)[0]!.kind).toBe('символ');
  });

  it('записи без имени или ссылки пропускаются', () => {
    const raw = [
      { kind: 5 },
      { name: 'ok', kind: 12, location: {} },
      { name: 'good', kind: 12, location: { uri: 'file:///p/a.py' } },
    ];
    expect(toProjectSymbols(raw, toPath).map((item) => item.name)).toEqual(['good']);
  });

  it('битая ссылка не роняет разбор', () => {
    const raw = [{ name: 'x', kind: 12, location: { uri: 'file:///p/a.py' } }];
    expect(
      toProjectSymbols(raw, () => {
        throw new Error('битая');
      }),
    ).toEqual([]);
  });

  it('не массив — пустой список', () => {
    expect(toProjectSymbols(null, toPath)).toEqual([]);
    expect(toProjectSymbols({ name: 'x' }, toPath)).toEqual([]);
  });
});

describe('flattenFileSymbols', () => {
  const sym = (name: string, line: number, children: FileSymbol[] = []): FileSymbol =>
    ({ name, kind: 'функция', line, endLine: line, children }) as unknown as FileSymbol;

  it('раскладывает дерево в плоский список с хлебной тропой', () => {
    const tree = [sym('Класс', 1, [sym('Метод', 3)])];
    const flat = flattenFileSymbols(tree, '/p/a.ts');
    expect(flat.map((s) => [s.name, s.container, s.line])).toEqual([
      ['Класс', null, 1],
      ['Метод', 'Класс', 3],
    ]);
    expect(flat[1]?.path).toBe('/p/a.ts');
  });
});

describe('filterSymbols', () => {
  const symbols: ProjectSymbol[] = [
    { name: 'Session', kind: 'класс', container: null, path: '/p/a.py', line: 10, column: 7 },
    { name: 'session_open', kind: 'функция', container: null, path: '/p/a.py', line: 20, column: 1 },
    { name: 'Session', kind: 'класс', container: null, path: '/p/a.py', line: 10, column: 7 },
    { name: 'Other', kind: 'класс', container: null, path: '/p/b.py', line: 3, column: 1 },
  ];

  it('фильтрует без учёта регистра и ранжирует по близости', () => {
    // Нечёткий сорт: 'session_open' совпадает плотнее ('session' в начале), поэтому выше.
    expect(filterSymbols(symbols, 'sess').map((s) => s.name)).toEqual(['session_open', 'Session']);
  });

  it('нечёткий поиск: «горбы» находят символ', () => {
    const list: ProjectSymbol[] = [
      { name: 'getTitle', kind: 'функция', container: null, path: '/p/a.ts', line: 1, column: 1 },
      { name: 'getBody', kind: 'функция', container: null, path: '/p/a.ts', line: 9, column: 1 },
    ];
    // gT — заглавные буквы имени, идут подряд-подпоследовательностью.
    expect(filterSymbols(list, 'gT').map((s) => s.name)).toEqual(['getTitle']);
  });

  it('совпавшие сортируются по оценке: точнее — выше', () => {
    const list: ProjectSymbol[] = [
      { name: 'sessionOpenLater', kind: 'функция', container: null, path: '/p/a.ts', line: 1, column: 1 },
      { name: 'session', kind: 'функция', container: null, path: '/p/a.ts', line: 2, column: 1 },
    ];
    expect(filterSymbols(list, 'session').map((s) => s.name)[0]).toBe('session');
  });

  it('убирает повторы одного символа', () => {
    // 'Session' — подстрока и в 'session_open', поэтому дубли проверяем
    // на одном и том же символе, а не на разных именах.
    const duplicated = [symbols[0]!, symbols[0]!];
    expect(filterSymbols(duplicated, 'Session')).toHaveLength(1);
  });

  it('пустой запрос отдаёт всё без повторов', () => {
    expect(filterSymbols(symbols, '')).toHaveLength(3);
  });

  it('уважает предел списка', () => {
    expect(filterSymbols(symbols, 's', 1)).toHaveLength(1);
  });
});

describe('mergeSymbols', () => {
  const fromServer: ProjectSymbol = {
    name: 'Session',
    kind: 'класс',
    container: null,
    path: 'a.py',
    line: 3,
    column: 1,
  };
  const fromIndex: ProjectSymbol = {
    name: 'SessionData',
    kind: 'класс',
    container: null,
    path: 'b.py',
    line: 7,
    column: 1,
  };

  it('ответ сервера идёт первым, карта добавляет недостающее', () => {
    expect(mergeSymbols([fromServer], [fromIndex]).map((symbol) => symbol.name)).toEqual(['Session', 'SessionData']);
  });

  it('один и тот же символ из двух источников остаётся одним', () => {
    expect(mergeSymbols([fromServer], [{ ...fromServer }])).toHaveLength(1);
  });

  it('пустой ответ сервера — это ответ карты', () => {
    expect(mergeSymbols([], [fromIndex])).toEqual([fromIndex]);
  });
});
