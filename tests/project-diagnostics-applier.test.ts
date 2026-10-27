import { describe, expect, it } from 'vitest';
import { createProjectDiagnosticsApplier } from '../src/renderer/core/project-diagnostics';
import type { LspDiagnostic } from '../src/shared/api';

const error: LspDiagnostic = {
  severity: 'error',
  message: 'e',
  line: 0,
  column: 0,
  endLine: 0,
  endColumn: 0,
} as LspDiagnostic;

describe('пометки обхода в окно', () => {
  function harness() {
    const sets: Array<{ path: string; count: number }> = [];
    const apply = createProjectDiagnosticsApplier({
      setMarkers: (path, diagnostics) => sets.push({ path, count: diagnostics.length }),
    });
    return { apply, sets };
  }

  it('кладёт пометки файлов отдельным источником', () => {
    const h = harness();
    h.apply({ start: true, files: [{ path: '/p/a.ts', diagnostics: [error] }] });

    expect(h.sets).toEqual([{ path: '/p/a.ts', count: 1 }]);
  });

  it('новый обход снимает пометки прошлого: удалённый файл не должен болеть вечно', () => {
    const h = harness();
    h.apply({ start: true, files: [{ path: '/p/gone.ts', diagnostics: [error] }] });
    h.apply({ start: true, files: [{ path: '/p/live.ts', diagnostics: [] }] });

    expect(h.sets[1]).toEqual({ path: '/p/gone.ts', count: 0 });
  });

  it('пустой список снимает прежние пометки файла — ошибку починили', () => {
    const h = harness();
    h.apply({ start: true, files: [{ path: '/p/a.ts', diagnostics: [error] }] });
    h.apply({ start: false, files: [{ path: '/p/a.ts', diagnostics: [] }] });

    expect(h.sets.at(-1)).toEqual({ path: '/p/a.ts', count: 0 });
  });
});
