import { describe, expect, it, vi } from 'vitest';
import { createDiskConflict, type DiskConflictPorts } from '../src/renderer/core/disk-conflict';
import type { TextDocument } from '../src/renderer/core/document';

/** Буфер: модулю от документа нужны только путь и пометка «не сохранён». */
const doc = (path: string, dirty = false) => ({ path, dirty }) as unknown as TextDocument;

interface ToastCall {
  message: string;
  kind: string;
  action?: { label: string; run(): void };
}

/** Стенд: буферы, порты и запись того, что модуль сказал и сделал. */
function makeStand(options: { dirty?: boolean; revertOk?: boolean } = {}) {
  const documents = new Map<string, TextDocument>();
  const dirtyListeners: ((document: TextDocument) => void)[] = [];
  const closeListeners: ((document: TextDocument) => void)[] = [];
  const toasts: ToastCall[] = [];

  const reloadFromDisk = vi.fn(async (path: string) => documents.get(path) ?? doc(path));
  const revertToDisk = vi.fn(async (path: string) => {
    if (options.revertOk === false) throw new Error('нет доступа');
    return documents.get(path) ?? doc(path);
  });
  const refreshView = vi.fn();
  const scheduleTreeRefresh = vi.fn();
  const confirmRevert = vi.fn(async () => true);
  const showToast = vi.fn((message: string, kind: string, opts?: { action?: { label: string; run(): void } }) => {
    toasts.push({ message, kind, action: opts?.action });
  });

  const ports: DiskConflictPorts = {
    documents: {
      get: (path) => documents.get(path),
      onDidChangeDirty: (listener) => dirtyListeners.push(listener),
      onDidClose: (listener) => closeListeners.push(listener),
    },
    reloadFromDisk,
    revertToDisk,
    refreshView,
    scheduleTreeRefresh,
    confirmRevert,
    showToast: showToast as unknown as DiskConflictPorts['showToast'],
  };

  return {
    conflict: createDiskConflict(ports),
    toasts,
    reloadFromDisk,
    revertToDisk,
    refreshView,
    scheduleTreeRefresh,
    confirmRevert,
    open(path: string, dirty = options.dirty ?? false) {
      documents.set(path, doc(path, dirty));
    },
    setDirty(path: string, dirty: boolean) {
      const document = doc(path, dirty);
      documents.set(path, document);
      for (const listener of dirtyListeners) listener(document);
    },
    close(path: string) {
      const document = documents.get(path) ?? doc(path);
      documents.delete(path);
      for (const listener of closeListeners) listener(document);
    },
  };
}

describe('reloadIfOpen', () => {
  it('файл не открыт — перечитывать нечего и говорить не о чем', async () => {
    const stand = makeStand();
    await stand.conflict.reloadIfOpen('/w/a.ts');
    expect(stand.reloadFromDisk).not.toHaveBeenCalled();
    expect(stand.toasts).toEqual([]);
  });

  it('картинка: обновляем экран, в буфер не читаем — там оказался бы бинарь', async () => {
    const stand = makeStand();
    stand.open('/w/logo.png', true);
    await stand.conflict.reloadIfOpen('/w/logo.png');
    expect(stand.refreshView).toHaveBeenCalledWith('/w/logo.png');
    expect(stand.reloadFromDisk).not.toHaveBeenCalled();
    expect(stand.toasts).toEqual([]);
  });

  it('документ Office: та же история — обновился только экран', async () => {
    const stand = makeStand();
    stand.open('/w/otchet.docx', true);
    await stand.conflict.reloadIfOpen('/w/otchet.docx');
    expect(stand.refreshView).toHaveBeenCalledWith('/w/otchet.docx');
    expect(stand.reloadFromDisk).not.toHaveBeenCalled();
    expect(stand.toasts).toEqual([]);
  });

  it('чистый буфер перечитывается молча', async () => {
    const stand = makeStand();
    stand.open('/w/a.ts');
    await stand.conflict.reloadIfOpen('/w/a.ts');
    expect(stand.reloadFromDisk).toHaveBeenCalledWith('/w/a.ts');
    expect(stand.toasts).toEqual([]);
  });

  it('грязный буфер: говорим вслух и сразу даём «Перечитать»', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');

    expect(stand.toasts).toHaveLength(1);
    expect(stand.toasts[0]?.message).toContain('a.ts');
    expect(stand.toasts[0]?.message).toContain('целы');
    expect(stand.toasts[0]?.action?.label).toBe('Перечитать');
  });

  it('о расхождении сказали один раз: наблюдатель не сыплет тостами', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');
    await stand.conflict.reloadIfOpen('/w/a.ts');
    await stand.conflict.reloadIfOpen('/w/a.ts');
    expect(stand.toasts).toHaveLength(1);
  });

  it('буфер снова совпал с диском — следующий разлом объясняем заново', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');
    stand.setDirty('/w/a.ts', false);
    stand.setDirty('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');
    expect(stand.toasts).toHaveLength(2);
  });

  it('вкладку закрыли и открыли снова — память маршрут не держит', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');
    stand.close('/w/a.ts');
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');
    expect(stand.toasts).toHaveLength(2);
  });

  it('«Перечитать» в тосте возвращает файл к версии на диске, а не спрашивает ещё раз', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.reloadIfOpen('/w/a.ts');

    stand.toasts[0]?.action?.run();
    await vi.waitFor(() => expect(stand.revertToDisk).toHaveBeenCalledWith('/w/a.ts'));
    expect(stand.confirmRevert).toHaveBeenCalledTimes(1);
  });
});

describe('revertFilesToDisk', () => {
  it('правок в буфере нет — ничего не спрашиваем', async () => {
    const stand = makeStand();
    stand.open('/w/a.ts');
    await stand.conflict.revertFilesToDisk(['/w/a.ts']);
    expect(stand.confirmRevert).not.toHaveBeenCalled();
    expect(stand.revertToDisk).not.toHaveBeenCalled();
    expect(stand.toasts[0]?.message).toBe('Правок в буфере нет');
  });

  it('отказ в диалоге — правки остаются', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    stand.confirmRevert.mockResolvedValueOnce(false);
    await stand.conflict.revertFilesToDisk(['/w/a.ts']);
    expect(stand.revertToDisk).not.toHaveBeenCalled();
    expect(stand.toasts).toEqual([]);
  });

  it('спрашиваем только про грязные: у чистого файла терять нечего', async () => {
    const stand = makeStand();
    stand.open('/w/a.ts', true);
    stand.open('/w/b.ts');
    await stand.conflict.revertFilesToDisk(['/w/a.ts', '/w/b.ts']);
    expect(stand.confirmRevert).toHaveBeenCalledWith(['/w/a.ts']);
    expect(stand.revertToDisk).toHaveBeenCalledTimes(1);
  });

  it('один файл — имя в тосте, дерево пересобрано', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    await stand.conflict.revertFilesToDisk(['/w/a.ts']);
    expect(stand.toasts.at(-1)?.message).toBe('Перечитано с диска: a.ts');
    expect(stand.scheduleTreeRefresh).toHaveBeenCalledTimes(1);
  });

  it('несколько файлов — числом, а не списком имён', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    stand.open('/w/b.ts', true);
    await stand.conflict.revertFilesToDisk(['/w/a.ts', '/w/b.ts']);
    expect(stand.toasts.at(-1)?.message).toBe('Перечитано с диска: файлов 2');
  });

  it('один файл не прочитался — остальные читаются, сбой назван', async () => {
    const stand = makeStand({ dirty: true });
    stand.open('/w/a.ts', true);
    stand.open('/w/b.ts', true);
    stand.revertToDisk.mockRejectedValueOnce(new Error('нет доступа'));
    await stand.conflict.revertFilesToDisk(['/w/a.ts', '/w/b.ts']);

    expect(stand.revertToDisk).toHaveBeenCalledTimes(2);
    expect(stand.toasts.some((t) => t.kind === 'error' && t.message.includes('a.ts'))).toBe(true);
    expect(stand.toasts.at(-1)?.message).toBe('Перечитано с диска: b.ts');
  });

  it('не прочитался ни один — «перечитано» не объявляем и дерево зря не дёргаем', async () => {
    const stand = makeStand({ dirty: true, revertOk: false });
    stand.open('/w/a.ts', true);
    await stand.conflict.revertFilesToDisk(['/w/a.ts']);
    expect(stand.scheduleTreeRefresh).not.toHaveBeenCalled();
    expect(stand.toasts.some((t) => t.message.startsWith('Перечитано'))).toBe(false);
  });
});
