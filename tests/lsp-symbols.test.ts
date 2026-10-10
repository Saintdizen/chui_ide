import { describe, expect, it } from 'vitest';
import { filterSymbols, toProjectSymbols, type ProjectSymbol } from '../src/shared/lsp-symbols';

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
    expect(toProjectSymbols(raw, toPath)[0].kind).toBe('символ');
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

describe('filterSymbols', () => {
  const symbols: ProjectSymbol[] = [
    { name: 'Session', kind: 'класс', container: null, path: '/p/a.py', line: 10, column: 7 },
    { name: 'session_open', kind: 'функция', container: null, path: '/p/a.py', line: 20, column: 1 },
    { name: 'Session', kind: 'класс', container: null, path: '/p/a.py', line: 10, column: 7 },
    { name: 'Other', kind: 'класс', container: null, path: '/p/b.py', line: 3, column: 1 },
  ];

  it('фильтрует по подстроке без учёта регистра', () => {
    expect(filterSymbols(symbols, 'sess').map((s) => s.name)).toEqual(['Session', 'session_open']);
  });

  it('убирает повторы одного символа', () => {
    // 'Session' — подстрока и в 'session_open', поэтому дубли проверяем
    // на одном и том же символе, а не на разных именах.
    const duplicated = [symbols[0], symbols[0]];
    expect(filterSymbols(duplicated, 'Session')).toHaveLength(1);
  });

  it('пустой запрос отдаёт всё без повторов', () => {
    expect(filterSymbols(symbols, '')).toHaveLength(3);
  });

  it('уважает предел списка', () => {
    expect(filterSymbols(symbols, 's', 1)).toHaveLength(1);
  });
});
