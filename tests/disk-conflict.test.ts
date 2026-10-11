import { describe, expect, it, vi } from 'vitest';
import { diskConflict } from '../src/renderer/core/document';
import { DocumentStore } from '../src/renderer/core/document-store';
import { EditService } from '../src/renderer/core/edits';
import type { RpcClient } from '../src/renderer/core/rpc';

/**
 * Защита от перезаписи чужой правки. Файл на диске мог изменить ассистент,
 * терминал или другой инструмент — тогда сохранение буфера редактора молча
 * стёрло бы эту правку. Признак конфликта считаем по времени файла, и он должен
 * молчать в двух случаях: когда мы ещё не знаем время и когда файла нет.
 */
describe('diskConflict', () => {
  it('время файла неизвестно — не мешаем сохранять', () => {
    expect(diskConflict(0, 123456)).toBe(false);
  });

  it('файла нет или stat не удался — не мешаем сохранять', () => {
    expect(diskConflict(123456, null)).toBe(false);
  });

  it('время совпало — конфликта нет', () => {
    expect(diskConflict(123456, 123456)).toBe(false);
  });

  it('файл изменился снаружи — конфликт', () => {
    expect(diskConflict(123456, 123999)).toBe(true);
  });
});

/** Мок RPC: отдаём время файла на диске (`diskMtime`) и время записи (`writeMtime`). */
function makeService(diskMtime: number | null, writeMtime = 5000) {
  const documents = new DocumentStore();
  const calls: string[] = [];
  const rpc = {
    request: vi.fn(async (method: string) => {
      calls.push(method);
      if (method === 'workspace.stat') {
        if (diskMtime === null) throw new Error('файла нет');
        return { path: '/p/a.ts', kind: 'file', size: 1, mtimeMs: diskMtime };
      }
      if (method === 'workspace.writeFile') return { mtimeMs: writeMtime };
      return {};
    }),
  } as unknown as RpcClient;
  const service = new EditService({ documents, editors: {} as never, rpc });
  return { service, documents, calls };
}

/** Открытый документ с правкой в буфере и известным временем файла на диске. */
function editedDocument(documents: DocumentStore, knownMtime: number) {
  const document = documents.open('/p/a.ts', 'исходный текст');
  document.markDisk(knownMtime);
  document.setText('правка в редакторе', 'user');
  return document;
}

/**
 * Сам сервис правок: решает, писать ли буфер на диск. Проверяем именно тот
 * случай, из-за которого терялись правки: файл изменился снаружи, и сохранение
 * из редактора затирало чужую запись без предупреждения.
 */
describe('EditService.saveDocument', () => {
  it('файл изменился на диске — не пишем и остаёмся «грязными»', async () => {
    const { service, documents, calls } = makeService(2000);
    const document = editedDocument(documents, 1000);

    expect(await service.saveDocument(document)).toBe('conflict');
    expect(calls).not.toContain('workspace.writeFile');
    expect(document.dirty).toBe(true);
  });

  it('force перезаписывает вопреки конфликту и снимает «грязность»', async () => {
    const { service, documents, calls } = makeService(2000, 3000);
    const document = editedDocument(documents, 1000);

    expect(await service.saveDocument(document, { force: true })).toBe('saved');
    expect(calls).toContain('workspace.writeFile');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(3000);
  });

  it('время совпало — пишем и запоминаем новое время файла', async () => {
    const { service, documents } = makeService(1000, 1500);
    const document = editedDocument(documents, 1000);

    expect(await service.saveDocument(document)).toBe('saved');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(1500);
  });

  it('файла нет (stat не удался) — сохраняем без ложной тревоги', async () => {
    const { service, documents } = makeService(null, 700);
    const document = editedDocument(documents, 1000);

    expect(await service.saveDocument(document)).toBe('saved');
  });
});
