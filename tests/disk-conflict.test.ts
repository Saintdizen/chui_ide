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

/** Мок RPC: отдаём время файла на диске (`diskMtime`), время записи и текст файла. */
function makeService(diskMtime: number | null, writeMtime = 5000, diskText = '') {
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
      if (method === 'workspace.readFile') {
        if (diskMtime === null) throw new Error('файла нет');
        return { text: diskText, mtimeMs: diskMtime };
      }
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

  it('снаружи записали РОВНО наш текст — не конфликт, «грязность» снимается', async () => {
    // Правку агента применяет документ в памяти, а на диск её записал файловый
    // инструмент: время файла разошлось, но содержимое то же — сохранять нечего.
    const { service, documents } = makeService(2000, 5000, 'правка в редакторе');
    const document = editedDocument(documents, 1000);

    expect(await service.saveDocument(document)).toBe('saved');
    expect(documents.get('/p/a.ts')?.dirty).toBe(false);
  });
});

/**
 * Ложное «не сохранён». Правку может применить документ в памяти, а на диск её
 * запишет кто-то другой (файловый инструмент, терминал, git) — тогда буфер и диск
 * совпадают, но пометка «грязный» осталась. Перечитывание обязано её снять, иначе
 * файл висел бы «не сохранён» до бесконечности: грязные документы пропускаются.
 */
describe('EditService.reloadFromDisk', () => {
  it('буфер совпал с диском — «грязность» снимается, редактор не дёргается', async () => {
    const { service, documents } = makeService(2000, 5000, 'правка в редакторе');
    const document = editedDocument(documents, 1000);

    const result = await service.reloadFromDisk('/p/a.ts');

    expect(result).toBe(document);
    expect(document.value).toBe('правка в редакторе');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(2000);
  });

  it('на диске чужая правка — буфер не трогаем', async () => {
    const { service, documents } = makeService(2000, 5000, 'чужая правка');
    const document = editedDocument(documents, 1000);

    await service.reloadFromDisk('/p/a.ts');

    expect(document.value).toBe('правка в редакторе');
    expect(document.dirty).toBe(true);
  });

  it('чистый документ перечитывается и остаётся чистым', async () => {
    const { service, documents } = makeService(2000, 5000, 'новый текст');
    const document = documents.open('/p/a.ts', 'старый текст');
    document.markSaved(1000);

    await service.reloadFromDisk('/p/a.ts');

    expect(document.value).toBe('новый текст');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(2000);
  });
});

/**
 * Возврат к версии на диске. В отличие от перечитывания, здесь буфер именно
 * отбрасывается — это единственный путь снять «не сохранён» с файла, чей буфер
 * разошёлся с диском и правки в котором уже не нужны (их записал другой
 * инструмент). Без него такой файл закрывался бы только вместе с вкладкой.
 */
describe('EditService.revertToDisk', () => {
  it('правки в буфере заменяются версией с диска, «грязность» снимается', async () => {
    const { service, documents } = makeService(2000, 5000, 'версия с диска');
    const document = editedDocument(documents, 1000);

    const result = await service.revertToDisk('/p/a.ts');

    expect(result).toBe(document);
    expect(document.value).toBe('версия с диска');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(2000);
  });

  it('совпавший буфер тоже очищается', async () => {
    const { service, documents } = makeService(2000, 5000, 'правка в редакторе');
    const document = editedDocument(documents, 1000);

    await service.revertToDisk('/p/a.ts');

    expect(document.value).toBe('правка в редакторе');
    expect(document.dirty).toBe(false);
  });

  it('файл не открыт — открывается и сразу считается чистым', async () => {
    const { service, documents } = makeService(2000, 5000, 'текст с диска');

    const document = await service.revertToDisk('/p/a.ts');

    expect(documents.get('/p/a.ts')).toBe(document);
    expect(document.value).toBe('текст с диска');
    expect(document.dirty).toBe(false);
  });
});

/**
 * Возврат к версии на диске. В отличие от перечитывания, здесь буфер именно
 * отбрасывается — это единственный путь снять «не сохранён» с файла, чей буфер
 * разошёлся с диском и правки в котором уже не нужны (их записал другой
 * инструмент). Без него такой файл закрывался бы только вместе с вкладкой.
 */
describe('EditService.revertToDisk', () => {
  it('правки в буфере заменяются версией с диска, «грязность» снимается', async () => {
    const { service, documents } = makeService(2000, 5000, 'версия с диска');
    const document = editedDocument(documents, 1000);

    const result = await service.revertToDisk('/p/a.ts');

    expect(result).toBe(document);
    expect(document.value).toBe('версия с диска');
    expect(document.dirty).toBe(false);
    expect(document.diskMtime).toBe(2000);
  });

  it('совпавший буфер тоже очищается', async () => {
    const { service, documents } = makeService(2000, 5000, 'правка в редакторе');
    const document = editedDocument(documents, 1000);

    await service.revertToDisk('/p/a.ts');

    expect(document.value).toBe('правка в редакторе');
    expect(document.dirty).toBe(false);
  });

  it('файл не открыт — открывается и сразу считается чистым', async () => {
    const { service, documents } = makeService(2000, 5000, 'текст с диска');

    const document = await service.revertToDisk('/p/a.ts');

    expect(documents.get('/p/a.ts')).toBe(document);
    expect(document.value).toBe('текст с диска');
    expect(document.dirty).toBe(false);
  });
});

/**
 * Один файл — один текст, кто бы его ни записал. Правки ассистента шли в обход
 * `applySaveEdits`, и файл, записанный агентом, получал другой текст, чем тот же
 * файл, записанный человеком через Ctrl+S: без перевода строки в конце, с хвостами.
 * Настройка называется «Перевод строки в конце файла» и живёт в `settings.editor`,
 * а `writePolicy` в `app.ts` говорит прямо: политика одна для всех, кто пишет.
 */
describe('saveDocument: правки текста те же, что у Ctrl+S', () => {
  it('перевод строки в конце ставится и при записи из сервиса правок', async () => {
    const documents = new DocumentStore();
    let written = '';
    const rpc = {
      request: vi.fn(async (method: string, params: { text?: string }) => {
        if (method === 'workspace.stat') return { path: '/p/a.ts', kind: 'file', size: 1, mtimeMs: 1000 };
        if (method === 'workspace.writeFile') {
          written = params.text ?? '';
          return { mtimeMs: 2000 };
        }
        return {};
      }),
    } as unknown as RpcClient;
    const service = new EditService({
      documents,
      editors: {} as never,
      rpc,
      policy: () => ({ trimTrailingWhitespace: true, insertFinalNewline: true }),
    });
    const document = documents.open('/p/a.ts', 'текст');
    document.markDisk(1000);
    document.setText('правка агента  ', 'programmatic');

    expect(await service.saveDocument(document)).toBe('saved');
    // Хвост подрезан, перевод строки поставлен — ровно как на Ctrl+S.
    expect(written).toBe('правка агента\n');
    // Буфер на экране совпал с диском: иначе вкладка осталась бы «грязной» после записи.
    expect(document.dirty).toBe(false);
  });

  it('политики нет — пишем как есть, ничего не выдумывая', async () => {
    const documents = new DocumentStore();
    let written = '';
    const rpc = {
      request: vi.fn(async (method: string, params: { text?: string }) => {
        if (method === 'workspace.stat') return { path: '/p/a.ts', kind: 'file', size: 1, mtimeMs: 1000 };
        if (method === 'workspace.writeFile') {
          written = params.text ?? '';
          return { mtimeMs: 2000 };
        }
        return {};
      }),
    } as unknown as RpcClient;
    const service = new EditService({ documents, editors: {} as never, rpc });
    const document = documents.open('/p/a.ts', 'текст');
    document.markDisk(1000);
    document.setText('без хвоста', 'programmatic');

    await service.saveDocument(document);
    expect(written).toBe('без хвоста');
  });
});
