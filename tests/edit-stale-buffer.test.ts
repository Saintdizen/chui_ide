import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { EditService } from '../src/renderer/core/edits';
import type { EditorApi } from '../src/renderer/core/editor-api';
import { translateEdits } from '../src/renderer/editor/host/document-edits';
import { DocumentRegistry } from '../src/renderer/editor/host/document-registry';
import type { TextEdit } from '../src/shared/edits';

/**
 * Буфер отстал от диска — правка всё равно ложится в свежий текст.
 *
 * Промах: вкладка открыта давно, файл с тех пор переписали снаружи (git, терминал,
 * файловый инструмент), буфер остался прежним. Якоря правки агента приходят из
 * чтения ГЛАВНОГО процесса, то есть с диска, — и в старом буфере не находятся:
 * правка ложится мимо (или не ложится вовсе), а сохранение затем отказывает
 * «файл изменён на диске». Агент видел «применено — N» рядом с «на диск не
 * записано» и повторял круг тем же якорем.
 *
 * Договорённость: чистый буфер перед правкой подтягивается к диску, грязный — нет
 * (там несохранённая работа человека, и расхождение с диском у него настоящее).
 */

const OLD = 'import a;\nimport b;\n';
const FRESH = 'import a;\nimport d;\n';

interface DiskFile {
  text: string;
  mtimeMs: number;
}

function fakeRpc(disk: Map<string, DiskFile>) {
  const writes: Array<{ path: string; text: string }> = [];
  const request = async (method: string, params: { path: string; text?: string }) => {
    const file = disk.get(params.path);
    if (method === 'workspace.stat') {
      return file
        ? { existence: 'file', mtimeMs: file.mtimeMs, size: file.text.length }
        : { existence: 'missing', mtimeMs: null, size: 0 };
    }
    if (method === 'workspace.readFile') {
      if (!file) throw new Error('нет файла');
      return { text: file.text, mtimeMs: file.mtimeMs, readOnly: false, size: file.text.length };
    }
    if (method === 'workspace.writeFile') {
      writes.push({ path: params.path, text: params.text ?? '' });
      const mtimeMs = 3_000;
      disk.set(params.path, { text: params.text ?? '', mtimeMs });
      return { mtimeMs };
    }
    throw new Error(`неизвестный метод: ${method}`);
  };
  return { request, writes };
}

/** Хозяин редактора в минимуме: файл за кадром правит документ. */
function standIn(documents: DocumentStore): EditorApi {
  const registry = new DocumentRegistry(documents);
  const editor = {
    applyEdits(document: { path: string }, edits: readonly TextEdit[]) {
      const buffer = registry.resolve(document as never);
      const translated = translateEdits(buffer, edits);
      if (translated.changes.length === 0) return translated;
      (document as unknown as { applyEdits: (e: readonly TextEdit[], s: string) => number }).applyEdits(
        edits,
        'programmatic',
      );
      return translated;
    },
  };
  return editor as unknown as EditorApi;
}

const EDIT: TextEdit = {
  startLine: 2,
  startColumn: 1,
  endLine: 2,
  endColumn: 10,
  oldText: 'import d;',
  newText: 'import c;\nimport d;',
};

function setup(diskText: string) {
  const disk = new Map<string, DiskFile>([['/p/a.ts', { text: diskText, mtimeMs: 2_000 }]]);
  const rpc = fakeRpc(disk);
  const documents = new DocumentStore();
  const edits = new EditService({ documents, editors: standIn(documents), rpc: rpc as never });
  return { disk, rpc, documents, edits };
}

describe('правка при отставшем буфере', () => {
  it('чистый буфер подтягивается к диску, правка ложится в свежий текст', async () => {
    const { edits, documents } = setup(FRESH);
    const document = documents.open('/p/a.ts', OLD);
    document.markDisk(1_000); // буфер видел файл до чужой записи

    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT] }]);

    expect(result.failed).toEqual([]);
    expect(result.reports).toEqual([{ path: '/p/a.ts', applied: 1, version: expect.any(Number) }]);
    expect(document.value).toBe('import a;\nimport c;\nimport d;\n');
    expect(document.dirty).toBe(true);
  });

  it('после подтягивания запись проходит: отказа «файл изменён на диске» нет', async () => {
    const { edits, documents, rpc } = setup(FRESH);
    const document = documents.open('/p/a.ts', OLD);
    document.markDisk(1_000);

    await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT] }]);
    expect(await edits.saveDocument(document)).toBe('saved');
    expect(rpc.writes).toEqual([{ path: '/p/a.ts', text: 'import a;\nimport c;\nimport d;\n' }]);
  });

  it('версия из чтения не спорит с подтянутым буфером', async () => {
    const { edits, documents } = setup(FRESH);
    const document = documents.open('/p/a.ts', OLD);
    document.markDisk(1_000);
    const staleVersion = document.version;

    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT], expectedVersion: staleVersion }]);

    expect(result.failed).toEqual([]);
    expect(result.reports[0]?.applied).toBe(1);
  });

  it('грязный буфер не трогаем: правка ложится в работу человека, запись осторожна', async () => {
    const { edits, documents } = setup(FRESH);
    const document = documents.open('/p/a.ts', OLD);
    document.markDisk(1_000);
    document.setText('import a;\nimport b;\nimport mine;\n', 'user');

    // Якоря с диска в грязном буфере нет — правка не применяется и говорит почему.
    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT] }]);

    expect(result.reports).toEqual([]);
    expect(result.failed[0]?.message).toContain('не совпал');
    expect(document.value).toBe('import a;\nimport b;\nimport mine;\n');
    // Расхождение с диском настоящее — сохранять без спроса нельзя.
    expect(await edits.saveDocument(document)).toBe('conflict');
  });
});
