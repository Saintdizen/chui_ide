import { describe, expect, it } from 'vitest';
import type { TextDocument } from '../src/renderer/core/document';
import { createFileWrite, type FileWritePorts } from '../src/renderer/core/file-write';

/**
 * Сторож записи на диск: закрывает пробел, который держал только `tsc`.
 *
 * Модуль состоит из `ports`, и всё интересное — в том, ЧЕМ он отвечает на вопрос
 * «можно ли сейчас писать». Три порта решают дело: `roots` (где можно писать),
 * `edits.saveDocument` (кто спрашивает про расхождение с диском) и
 * `git.saveBeforeCommit` (настройка своя, не общая с checkout).
 */

interface Doc {
  path: string;
  value: string;
  readOnly: boolean;
  setText(value: string, origin: string): void;
}

function doc(path: string, value = 'on-disk', readOnly = false): TextDocument {
  const d: Doc = {
    path,
    value,
    readOnly,
    setText(next, _origin) {
      d.value = next;
    },
  };
  // Фейк: модулю от документа нужны только эти четыре члена.
  return d as unknown as TextDocument;
}

function setup(
  options: {
    docs?: Doc[];
    saveResult?: 'saved' | 'conflict';
    policy?: { trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean; formatOnSave?: boolean };
    confirm?: boolean;
    saveBeforeCommit?: boolean;
    saveBeforeCheckout?: boolean;
    dialogPath?: string | null;
    writeFails?: string;
    closeChoice?: string;
    dialogThrows?: boolean;
    closeThrows?: boolean;
  } = {},
) {
  const docs = options.docs ?? [];
  const rec = {
    toasts: [] as string[],
    written: [] as { path: string; text: string }[],
    closed: [] as string[],
    opened: [] as string[],
    refreshed: 0,
    saved: [] as { path: string; force: boolean }[],
    asked: [] as string[],
  };
  const policy = {
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    formatOnSave: false,
    ...options.policy,
  };

  const ports = {
    documents: {
      get: (path: string) => docs.find((d) => d.path === path),
      dirty: () => docs.filter((d) => d.value !== 'on-disk'),
    },
    edits: {
      saveDocument: async (document: Doc, opts?: { force?: boolean }) => {
        rec.saved.push({ path: document.path, force: opts?.force === true });
        return options.saveResult ?? 'saved';
      },
    },
    rpc: {
      request: async (method: string, params?: Record<string, unknown>) => {
        rec.asked.push(method);
        if (method === 'dialog.saveFile') {
          if (options.dialogThrows) throw new Error('диалог недоступен');
          return { path: options.dialogPath ?? null };
        }
        if (method === 'dialog.confirmClose') return { choice: options.closeChoice ?? 'discard' };
        if (method === 'window.close' && options.closeThrows) throw new Error('окно не закрылось');
        if (method === 'workspace.writeFile') {
          if (options.writeFails) throw new Error(options.writeFails);
          rec.written.push({ path: String(params?.path), text: String(params?.text) });
          return { mtimeMs: 1 };
        }
        return undefined;
      },
    },
    openEditors: { close: (path: string) => rec.closed.push(path) },
    save: { policy: () => policy, format: async () => undefined },
    git: {
      saveBeforeCommit: () => options.saveBeforeCommit,
      saveBeforeCheckout: () => options.saveBeforeCheckout,
      refresh: async () => {
        rec.refreshed += 1;
      },
    },
    roots: () => [{ root: '/proj', name: 'proj' }],
    openPath: async (path: string) => {
      rec.opened.push(path);
    },
    refreshTree: () => undefined,
    confirm: async (ask: { title: string }) => {
      rec.toasts.push(`confirm:${ask.title}`);
      return options.confirm ?? false;
    },
    showToast: (message: string, kind?: string) => rec.toasts.push(kind ? `${kind}:${message}` : message),
    basename: (path: string) => path.split('/').pop() ?? path,
  };

  return { fileWrite: createFileWrite(ports as unknown as FileWritePorts), rec, docs };
}

describe('file-write: Ctrl+S', () => {
  it('только для чтения — не пишется и говорит почему', async () => {
    const d = doc('/proj/a.ts', 'edited', true);
    const { fileWrite, rec } = setup({ docs: [d] });
    expect(await fileWrite.saveDocument(d)).toBe(false);
    expect(rec.saved).toHaveLength(0);
    expect(rec.toasts[0]).toContain('только для чтения');
  });

  it('расхождение с диском: отказ человека — записи нет', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveResult: 'conflict', confirm: false });
    expect(await fileWrite.saveDocument(d)).toBe(false);
    expect(rec.saved.map((s) => s.force)).toEqual([false]);
    expect(rec.toasts.some((t) => t.startsWith('Сохранено'))).toBe(false);
  });

  it('расхождение с диском: согласие — вторая попытка с force', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveResult: 'conflict', confirm: true });
    expect(await fileWrite.saveDocument(d)).toBe(true);
    expect(rec.saved.map((s) => s.force)).toEqual([false, true]);
  });

  it('правила записи проводятся через документ, а не только на диск', async () => {
    const d = doc('/proj/a.ts', 'line  \n');
    const { fileWrite } = setup({
      docs: [d],
      policy: { trimTrailingWhitespace: true, insertFinalNewline: true },
    });
    await fileWrite.saveDocument(d);
    expect(d.value).toBe('line\n');
  });
});

describe('file-write: «Сохранить как»', () => {
  it('путь вне рабочей области — не пишем', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: '/elsewhere/b.ts' });
    expect(await fileWrite.saveDocumentAs(d)).toBe(false);
    expect(rec.written).toHaveLength(0);
    expect(rec.toasts.at(-1)).toContain('рабочей области');
  });

  it('путь внутри — запись, вкладка переезжает', async () => {
    const d = doc('/proj/sub/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: '/proj/sub/b.ts' });
    expect(await fileWrite.saveDocumentAs(d)).toBe(true);
    expect(rec.written).toEqual([{ path: '/proj/sub/b.ts', text: 'edited' }]);
    expect(rec.closed).toEqual(['/proj/sub/a.ts']);
    expect(rec.opened).toEqual(['/proj/sub/b.ts']);
  });

  it('диалог отменили — ни записи, ни ошибки', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: null });
    expect(await fileWrite.saveDocumentAs(d)).toBe(false);
    expect(rec.written).toHaveLength(0);
    expect(rec.toasts).toHaveLength(0);
  });

  it('тот же путь — это обычное сохранение, не копия', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: '/proj/a.ts' });
    expect(await fileWrite.saveDocumentAs(d)).toBe(true);
    expect(rec.written).toHaveLength(0);
    expect(rec.saved).toHaveLength(1);
  });

  it('диалог упал — ни записи, ни ложного «сохранено»', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogThrows: true });
    expect(await fileWrite.saveDocumentAs(d)).toBe(false);
    expect(rec.written).toHaveLength(0);
  });

  it('ошибка записи — вкладка не закрывается и не открывается', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: '/proj/b.ts', writeFails: 'EACCES' });
    expect(await fileWrite.saveDocumentAs(d)).toBe(false);
    expect(rec.closed).toHaveLength(0);
    expect(rec.opened).toHaveLength(0);
    expect(rec.toasts.at(-1)).toContain('EACCES');
  });

  it('только для чтения — даже не спрашиваем путь', async () => {
    const d = doc('/proj/a.ts', 'edited', true);
    const { fileWrite, rec } = setup({ docs: [d], dialogPath: '/proj/b.ts' });
    expect(await fileWrite.saveDocumentAs(d)).toBe(false);
    expect(rec.asked).not.toContain('dialog.saveFile');
  });
});

describe('file-write: закрытие окна', () => {
  it('cancel — окно остаётся', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], closeChoice: 'cancel' });
    await fileWrite.closeWindowSafely();
    expect(rec.asked).not.toContain('window.close');
  });

  it('discard — закрываем без сохранения', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], closeChoice: 'discard' });
    await fileWrite.closeWindowSafely();
    expect(rec.saved).toHaveLength(0);
    expect(rec.asked).toContain('window.close');
  });

  it('save — сохраняем каждый грязный буфер', async () => {
    const a = doc('/proj/a.ts', 'edited');
    const b = doc('/proj/b.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [a, b], closeChoice: 'save' });
    await fileWrite.closeWindowSafely();
    expect(rec.saved.map((s) => s.path)).toEqual(['/proj/a.ts', '/proj/b.ts']);
    expect(rec.asked).toContain('window.close');
  });

  it('save, но перезапись отклонили — окно не закрываем', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], closeChoice: 'save', saveResult: 'conflict', confirm: false });
    await fileWrite.closeWindowSafely();
    expect(rec.asked).not.toContain('window.close');
  });

  it('флаг closing снят после закрытия', async () => {
    const { fileWrite } = setup({});
    expect(fileWrite.isClosing()).toBe(false);
    await fileWrite.closeWindowSafely();
    expect(fileWrite.isClosing()).toBe(false);
  });

  it('окно не закрылось — ошибка показана, флаг closing снят', async () => {
    const { fileWrite, rec } = setup({ closeThrows: true });
    await fileWrite.closeWindowSafely();
    expect(rec.toasts.some((t) => t.includes('окно не закрылось'))).toBe(true);
    expect(fileWrite.isClosing()).toBe(false);
  });

  it('к лаунчеру — closeProject ПЕРЕД window.close', async () => {
    const { fileWrite, rec } = setup({});
    await fileWrite.closeWindowSafely(true);
    const cr = rec.asked.indexOf('app.closeProject');
    const wc = rec.asked.indexOf('window.close');
    expect(cr).toBeGreaterThanOrEqual(0);
    expect(cr).toBeLessThan(wc);
  });

  it('чистые буферы — диалог не нужен', async () => {
    const { fileWrite, rec } = setup({ docs: [doc('/proj/a.ts')] });
    await fileWrite.closeWindowSafely();
    expect(rec.asked).not.toContain('dialog.confirmClose');
    expect(rec.asked).toContain('window.close');
  });
});

describe('file-write: сохранение перед git', () => {
  it('только для чтения среди грязных — коммит отменяется', async () => {
    const ro = doc('/proj/ro.ts', 'edited', true);
    const { fileWrite, rec } = setup({ docs: [ro] });
    expect(await fileWrite.saveDirtyForGit()).toBe(false);
    expect(rec.saved).toHaveLength(0);
    expect(rec.toasts[0]).toContain('только чтение');
    expect(rec.refreshed).toBe(0);
  });

  it('сохранили — снимок git пересчитан', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d] });
    expect(await fileWrite.saveDirtyForGit()).toBe(true);
    expect(rec.saved).toHaveLength(1);
    expect(rec.refreshed).toBe(1);
  });

  it('настройка выключена — не сохраняем, но снимок пересчитываем', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveBeforeCommit: false });
    expect(await fileWrite.saveDirtyForGit()).toBe(true);
    expect(rec.saved).toHaveLength(0);
    expect(rec.refreshed).toBe(1);
  });

  it('checkout: своя настройка — спрашиваем человека', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveBeforeCheckout: false, confirm: true });
    expect(await fileWrite.prepareCheckout()).toBe(true);
    expect(rec.toasts.some((t) => t.startsWith('confirm:Есть несохранённые'))).toBe(true);
    expect(rec.saved).toHaveLength(1);
  });

  it('checkout: отказ человека — не переключаемся и не пишем', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveBeforeCheckout: false, confirm: false });
    expect(await fileWrite.prepareCheckout()).toBe(false);
    expect(rec.saved).toHaveLength(0);
  });

  it('checkout: настройка включена — без вопроса сохраняем', async () => {
    const d = doc('/proj/a.ts', 'edited');
    const { fileWrite, rec } = setup({ docs: [d], saveBeforeCheckout: true });
    expect(await fileWrite.prepareCheckout()).toBe(true);
    expect(rec.toasts.some((t) => t.startsWith('confirm:'))).toBe(false);
    expect(rec.saved).toHaveLength(1);
  });

  it('checkout: только для чтения — отказ, даже с согласием', async () => {
    const ro = doc('/proj/ro.ts', 'edited', true);
    const { fileWrite, rec } = setup({ docs: [ro], confirm: true });
    expect(await fileWrite.prepareCheckout()).toBe(false);
    expect(rec.saved).toHaveLength(0);
  });
});
