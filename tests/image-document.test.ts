import { describe, expect, it, vi } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { EditService } from '../src/renderer/core/edits';

/**
 * Картинка — не текст, и в буфере её быть не должно.
 *
 * Проверка сторожит именно это: документ-заглушка картинки всегда пуст, а файл
 * с диска за ней не читается. Иначе бинарь попадает в документ и оттуда уезжает
 * дальше — в копию кода («заглядывание»), в поиск по открытым файлам и на диск
 * при сохранении. Так уже было: `reloadFromDisk` перечитывал картинку как текст,
 * и в окне вместо картинки появлялись её байты.
 */

/** Правки и редактор здесь не нужны: до них картинку не доводят. */
function service(): { documents: DocumentStore; edits: EditService; readFile: ReturnType<typeof vi.fn> } {
  const documents = new DocumentStore();
  const readFile = vi.fn(async () => {
    throw new Error('файл картинки читать нельзя');
  });
  const edits = new EditService({
    documents,
    editors: {} as never,
    rpc: { request: readFile } as never,
  });
  return { documents, edits, readFile };
}

describe('документ картинки', () => {
  it('заглушка заводится пустой и файл не читается', async () => {
    const { edits, readFile } = service();
    const document = await edits.ensureDocument('/proj/shot.png');

    expect(document.value).toBe('');
    expect(document.readOnly).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('перечитывание с диска не тянет байты в буфер', async () => {
    const { edits, readFile } = service();
    await edits.ensureDocument('/proj/shot.png');

    const document = await edits.reloadFromDisk('/proj/shot.png');
    expect(document.value).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('возврат к версии с диска тоже не читает картинку текстом', async () => {
    const { edits, readFile } = service();
    await edits.ensureDocument('/proj/shot.png');

    const document = await edits.revertToDisk('/proj/shot.png');
    expect(document.value).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('бинарь, попавший в документ раньше, вычищается', async () => {
    // Так выглядел сбой: в документе картинки лежали её байты, и окно показывало их.
    const { documents, edits } = service();
    const stale = documents.open('/proj/shot.png', '\u0089PNG\r\n\u001a\nбитые байты');

    const document = await edits.ensureDocument('/proj/shot.png');
    expect(document).toBe(stale);
    expect(document.value).toBe('');
    // Документ не «правленый»: чистили не человека ради, а чтобы пометка не врала.
    expect(document.dirty).toBe(false);
  });

  it('текстовый файл читается с диска как обычно', async () => {
    const { edits, readFile } = service();
    readFile.mockResolvedValueOnce({ text: 'строка', readOnly: false, mtimeMs: 1 });

    const document = await edits.ensureDocument('/proj/note.ts');
    expect(document.value).toBe('строка');
    expect(readFile).toHaveBeenCalledWith('workspace.readFile', { path: '/proj/note.ts' });
  });
});
