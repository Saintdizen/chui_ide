import { describe, expect, it } from 'vitest';
import { callKeyOf, callOverlaps, overlapOf, repeatedCallIndexes, type OverlapCall } from '../src/shared/call-overlaps';

const call = (name: string, arguments_: string): OverlapCall => ({ name, arguments: arguments_ });

describe('пересечения инструментов', () => {
  it('размечает поиск объявления через search и lsp', () => {
    expect(
      overlapOf(
        call('search', '{"action":"code","query":"User"}'),
        call('lsp', '{"action":"definition","symbol":"User"}'),
      ),
    ).toBe('search-lsp');
    expect(
      overlapOf(call('lsp', '{"action":"references","symbol":"X"}'), call('search', '{"action":"code","query":"X"}')),
    ).toBe('search-lsp');
    // `lsp(outline)` — структура файла, а не тот же поиск объявления.
    expect(
      overlapOf(call('search', '{"action":"code","query":"X"}'), call('lsp', '{"action":"outline","path":"a.ts"}')),
    ).toBeNull();
  });

  it('размечает тесты и линтер в terminal рядом со специализированными инструментами', () => {
    expect(overlapOf(call('terminal', '{"action":"run","command":"npm test"}'), call('run_tests', '{}'))).toBe(
      'terminal-tests',
    );
    expect(
      overlapOf(call('terminal', '{"action":"run","command":"eslint src"}'), call('checks', '{"action":"lint"}')),
    ).toBe('terminal-lints');
    expect(
      overlapOf(call('terminal', '{"action":"run","command":"npm run build"}'), call('run_tests', '{}')),
    ).toBeNull();
  });

  it('размечает два способа открыть страницу и две формы правки файла', () => {
    expect(
      overlapOf(call('web', '{"action":"fetch","url":"https://x.test"}'), call('browser', '{"action":"snapshot"}')),
    ).toBe('web-browser');
    expect(
      overlapOf(call('file', '{"action":"replace","query":"old"}'), call('edit', '{"oldText":"old","newText":"new"}')),
    ).toBe('file-edit');
  });

  it('считает пары только соседних вызовов', () => {
    const calls = [call('list', '{}'), call('read', '{"path":"a.ts"}'), call('project_map', '{}')];
    expect(callOverlaps(calls)).toEqual([]);
    const adjacent = [call('list', '{}'), call('project_map', '{}')];
    expect(callOverlaps(adjacent)).toEqual([{ a: 0, b: 1, kind: 'list-project_map' }]);
  });

  it('находит повтор вызова, не обращая внимания на порядок ключей', () => {
    const calls = [
      call('search', '{"query":"User","action":"code"}'),
      call('search', '{"action":"code","query":"User"}'),
      call('read', '{"path":"a.ts"}'),
    ];
    expect(callKeyOf(calls[0]!)).toBe(callKeyOf(calls[1]!));
    expect(repeatedCallIndexes(calls)).toEqual([1]);
    expect(repeatedCallIndexes([calls[0]!, calls[1]!, calls[1]!])).toEqual([1, 2]);
  });

  it('не падает на сломанные аргументы и считает их текстом', () => {
    const broken = call('read', '{"path":');
    expect(callKeyOf(broken)).toBe('read:{"path":');
    expect(repeatedCallIndexes([broken, call('read', '{"path":')])).toEqual([1]);
  });
});
