import { describe, expect, it } from 'vitest';
import type { LspDiagnostic } from '../src/shared/api';
import { DiagnosticsStore } from '../src/renderer/editor/host/diagnostics';

function diagnostic(partial: Partial<LspDiagnostic> & { line: number }): LspDiagnostic {
  return {
    severity: 'error',
    column: 1,
    endLine: partial.line,
    endColumn: 1,
    message: 'сообщение',
    ...partial,
  };
}

describe('DiagnosticsStore', () => {
  it('пометки складываются под своим владельцем и не затирают чужие', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 3, message: 'от сервера' })]);
    store.set('/p/a.ts', 'imports', [diagnostic({ line: 1, severity: 'warning', message: 'импорт' })]);

    // Свежие пометки сервера заменяют ЕГО набор целиком, но не трогают «imports».
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 5, message: 'новое от сервера' })]);

    const items = store.forPath('/p/a.ts');
    expect(items.map((item) => item.message)).toEqual(['импорт', 'новое от сервера']);
  });

  it('пустой набор убирает владельца, а без владельцев исчезает и файл', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'imports', [diagnostic({ line: 1 })]);
    store.set('/p/a.ts', 'imports', []);
    expect(store.forPath('/p/a.ts')).toEqual([]);
    expect(store.paths()).toEqual([]);
  });

  it('forPath сортирует пометки по строке и столбцу', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'lsp', [
      diagnostic({ line: 9, column: 1 }),
      diagnostic({ line: 2, column: 8 }),
      diagnostic({ line: 2, column: 3 }),
    ]);
    expect(store.forPath('/p/a.ts').map((item) => `${item.line}:${item.column}`)).toEqual(['2:3', '2:8', '9:1']);
  });

  it('счётчики считают ошибки и предупреждения, info не считают', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'lsp', [
      diagnostic({ line: 1, severity: 'error' }),
      diagnostic({ line: 2, severity: 'warning' }),
    ]);
    store.set('/p/b.ts', 'imports', [
      diagnostic({ line: 1, severity: 'warning' }),
      diagnostic({ line: 2, severity: 'info' }),
    ]);
    expect(store.problemCounts()).toEqual({ errors: 1, warnings: 2 });
  });

  it('markers отдаёт список с путём и источником, при пути — только его', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 1, source: 'pylsp' })]);
    store.set('/p/b.ts', 'imports', [diagnostic({ line: 2, severity: 'warning' })]);

    const all = store.markers();
    expect(all.map((item) => item.path)).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(all[0]!.source).toBe('pylsp');
    // Источник не задан — пустая строка, а не undefined (так ждёт контракт).
    expect(all[1]!.source).toBe('');

    expect(store.markers('/p/b.ts')).toHaveLength(1);
  });

  it('markers сортирует по пути, затем по строке и столбцу', () => {
    const store = new DiagnosticsStore();
    store.set('/p/b.ts', 'lsp', [diagnostic({ line: 1 })]);
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 7 }), diagnostic({ line: 2 })]);

    expect(store.markers().map((item) => `${item.path}:${item.line}`)).toEqual(['/p/a.ts:2', '/p/a.ts:7', '/p/b.ts:1']);
  });

  it('clear убирает пометки файла', () => {
    const store = new DiagnosticsStore();
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 1 })]);
    store.clear('/p/a.ts');
    expect(store.forPath('/p/a.ts')).toEqual([]);
    expect(store.paths()).toEqual([]);
  });

  it('изменение набора сообщает подписчикам', () => {
    const store = new DiagnosticsStore();
    let calls = 0;
    store.onDidChange(() => {
      calls += 1;
    });
    store.set('/p/a.ts', 'lsp', [diagnostic({ line: 1 })]);
    expect(calls).toBe(1);
    store.set('/p/b.ts', 'imports', []);
    expect(calls).toBe(2);
  });
});
