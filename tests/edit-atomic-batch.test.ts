import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { EditService } from '../src/renderer/core/edits';
import type { EditorApi } from '../src/renderer/core/editor-api';
import { translateEdits } from '../src/renderer/editor/host/document-edits';
import { DocumentRegistry } from '../src/renderer/editor/host/document-registry';
import type { TextEdit } from '../src/shared/edits';

/**
 * Пачка правок ложится целиком или никак.
 *
 * Промах: `applyFileEdits` шла файл за файлом, и каждый применялся отдельно со
 * своей записью в историю. Если третий файл не сошёлся (устаревшая версия, файл
 * только для чтения, якорь мимо) — первые два уже правлены, а откат приходилось
 * жать по разу на файл. Rename/code action из языкового сервера — правка ОДНА,
 * и половина её в рабочем дереве — это сломанный код.
 */

function fakeRpc(disk: Map<string, string>) {
  return {
    request: async (method: string, params: { path: string; text?: string }) => {
      const text = disk.get(params.path);
      if (method === 'workspace.stat') {
        return text === undefined
          ? { existence: 'missing', mtimeMs: null, size: 0 }
          : { existence: 'file', mtimeMs: 1_000, size: text.length };
      }
      if (method === 'workspace.readFile') {
        if (text === undefined) throw new Error('нет файла');
        return { text, mtimeMs: 1_000, readOnly: false, size: text.length };
      }
      if (method === 'workspace.writeFile') {
        disk.set(params.path, params.text ?? '');
        return { mtimeMs: 2_000 };
      }
      throw new Error(`неизвестный метод: ${method}`);
    },
  };
}

function standIn(documents: DocumentStore): EditorApi {
  const registry = new DocumentRegistry(documents);
  const editor = {
    applyEdits(document: { path: string }, edits: readonly TextEdit[]) {
      const translated = translateEdits(registry.resolve(document as never), edits);
      if (translated.changes.length === 0) return translated;
      (document as unknown as { applyEdits: (e: readonly TextEdit[], s: string) => number }).applyEdits(
        edits,
        'programmatic',
      );
      return translated;
    },
    previewEdits(document: { path: string }, edits: readonly TextEdit[]) {
      return translateEdits(registry.resolve(document as never), edits);
    },
  };
  return editor as unknown as EditorApi;
}

const EDIT_A: TextEdit = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, oldText: 'aaa', newText: 'AAA' };
const EDIT_B: TextEdit = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, oldText: 'bbb', newText: 'BBB' };

function setup() {
  const disk = new Map<string, string>([
    ['/p/a.ts', 'aaa\n'],
    ['/p/b.ts', 'bbb\n'],
  ]);
  const rpc = fakeRpc(disk);
  const documents = new DocumentStore();
  const editors = standIn(documents);
  const edits = new EditService({ documents, editors, rpc: rpc as never });
  const a = documents.open('/p/a.ts', 'aaa\n');
  const b = documents.open('/p/b.ts', 'bbb\n');
  a.markDisk(1_000);
  b.markDisk(1_000);
  return { disk, documents, edits, a, b };
}

describe('пачка правок атомарна', () => {
  it('сбой во втором файле — первый остаётся нетронутым', async () => {
    const { edits, a, b } = setup();
    const staleVersion = b.version - 1;

    const result = await edits.applyFileEdits([
      { path: '/p/a.ts', edits: [EDIT_A] },
      { path: '/p/b.ts', edits: [EDIT_B], expectedVersion: staleVersion },
    ]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('/p/b.ts');
    expect(result.reports).toEqual([]);
    // Первый файл НЕ тронут — пачка не применилась.
    expect(a.value).toBe('aaa\n');
    expect(a.dirty).toBe(false);
    expect(b.value).toBe('bbb\n');
  });

  it('весь пакет сходится — применяются оба', async () => {
    const { edits, a, b } = setup();

    const result = await edits.applyFileEdits([
      { path: '/p/a.ts', edits: [EDIT_A] },
      { path: '/p/b.ts', edits: [EDIT_B] },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.reports.map((r) => r.path)).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(a.value).toBe('AAA\n');
    expect(b.value).toBe('BBB\n');
  });
});
