import { describe, expect, it } from 'vitest';
import { createProjectDiagnostics, isProjectSource } from '../src/main/lsp/project-diagnostics';
import type { LspDiagnostic, LspProjectDiagnosticsPayload } from '../src/shared/api';

const error = (line: number): LspDiagnostic =>
  ({ severity: 'error', message: `e${line}`, line, column: 0, endLine: line, endColumn: 0 }) as LspDiagnostic;

function harness(include?: (path: string) => boolean) {
  const published: LspProjectDiagnosticsPayload[] = [];
  let sink: ((path: string, diagnostics: LspDiagnostic[]) => void) | null = null;
  const deferred: Array<() => void> = [];
  const service = createProjectDiagnostics({
    collect: (next) => {
      sink = next;
      return () => {
        sink = null;
      };
    },
    include,
    publish: (payload) => published.push(payload),
    defer: (fn) => deferred.push(fn),
  });
  return {
    service,
    published,
    deferred,
    emit: (path: string, diagnostics: LspDiagnostic[]) => sink?.(path, diagnostics),
  };
}

describe('пометки всего проекта', () => {
  it('копит файлы и отдаёт пачку одной отправкой', () => {
    const h = harness();
    h.service.start();
    h.emit('/p/a.ts', [error(2)]);
    h.emit('/p/b.ts', [error(5)]);

    expect(h.published).toEqual([]);
    h.deferred.shift()?.();

    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.files.map((file) => file.path)).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('начало обхода — сразу пустая пачка со снятием, дальше — обычные', () => {
    const h = harness();
    h.service.start();
    h.service.begin();

    // Снятие уходит сразу: в чистом проекте других пачек не будет вовсе.
    expect(h.published).toEqual([{ start: true, files: [] }]);

    h.emit('/p/a.ts', [error(1)]);
    h.deferred.shift()?.();
    expect(h.published[1]?.start).toBe(false);
    expect(h.published[1]?.files).toHaveLength(1);
  });

  it('пустой список не запоминается: сервер шлёт его и на закрытие файла', () => {
    const h = harness();
    h.service.start();
    h.emit('/p/a.ts', [error(1)]);
    h.emit('/p/a.ts', []);
    h.deferred.shift()?.();

    expect(h.published[0]?.files).toHaveLength(1);
    expect(h.published[0]?.files[0]?.diagnostics).toHaveLength(1);
  });

  it('чужие каталоги в счёт не идут', () => {
    const h = harness((file) => !file.includes('node_modules'));
    h.service.start();
    h.emit('/p/node_modules/x/index.d.ts', [error(1), error(2)]);
    h.emit('/p/src/a.ts', [error(3)]);
    h.deferred.shift()?.();

    expect(h.published[0]?.files.map((file) => file.path)).toEqual(['/p/src/a.ts']);
  });

  it('много файлов уезжают пачками, не дожидаясь таймера', () => {
    const h = harness();
    h.service.start();
    for (let i = 0; i < 64; i += 1) h.emit(`/p/${i}.ts`, [error(i)]);

    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.files).toHaveLength(64);
  });

  it('пустая пачка в окно не уходит', () => {
    const h = harness();
    h.service.start();
    h.deferred.shift()?.();

    expect(h.published).toEqual([]);
  });
});

describe('isProjectSource', () => {
  it('берёт файлы внутри проекта', () => {
    expect(isProjectSource('/p', '/p/src/a.ts')).toBe(true);
  });

  it('отсекает зависимости, сборку и чужие корни', () => {
    expect(isProjectSource('/p', '/p/node_modules/a/index.js')).toBe(false);
    expect(isProjectSource('/p', '/p/dist/a.js')).toBe(false);
    expect(isProjectSource('/p', '/other/a.ts')).toBe(false);
    expect(isProjectSource(null, '/p/a.ts')).toBe(false);
  });
});
