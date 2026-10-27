import { describe, expect, it } from 'vitest';
import {
  formatDocument,
  formatOutcomeMessage,
  formatRangeWithServer,
  registerFormatCommands,
  type FormatDeps,
} from '../src/renderer/core/format-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Форматирование: два пути, и путать их нельзя. Инструмент проекта (ruff, prettier)
 * переписывает файл целиком, языковой сервер — только участок. Сторож держит границы:
 * только-чтение не трогаем, отсутствие инструмента называем честно, «менять нечего» —
 * это не ошибка.
 */
function document(overrides: Partial<{ path: string; text: string; readOnly: boolean; languageId: string }> = {}) {
  const doc = {
    path: overrides.path ?? '/p/a.py',
    value: overrides.text ?? 'x=1',
    readOnly: overrides.readOnly ?? false,
    languageId: overrides.languageId ?? 'python',
    setText: (next: string) => {
      doc.value = next;
    },
  };
  return doc;
}

function setup(
  options: {
    active?: ReturnType<typeof document> | null;
    hasSelection?: boolean;
    serverEdits?: unknown[];
    rpcAnswer?: unknown;
  } = {},
) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const doc = options.active === undefined ? document() : options.active;
  const deps = {
    documents: { get: (path: string) => (doc && doc.path === path ? doc : undefined) },
    lsp: { formatRange: async () => options.serverEdits ?? [] },
    edits: { applyFileEdits: async () => ({ failed: [] }) },
    rpc: { request: async () => options.rpcAnswer ?? null },
    openEditors: { active: doc },
    workspace: {
      hasSelection: () => options.hasSelection ?? false,
      selectionRange: () => ({ startLine: 1, startColumn: 1, endLine: 2, endColumn: 3 }),
    },
    showToast: (message: string) => toasts.push(message),
  } as unknown as FormatDeps;
  registerFormatCommands(define, deps);
  // Стенд всегда отдаёт живой документ (вариант с null только у `openEditors.active`),
  // а тесты читают его текст напрямую — отсюда точный тип, а не союз с null.
  return { commands, toasts, deps, doc: doc as ReturnType<typeof document> };
}

describe('registerFormatCommands', () => {
  it('регистрирует ровно две команды форматирования', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual(['format.document', 'format.selection']);
  });

  it('форматирует файл инструментом проекта и меняет текст', async () => {
    const { commands, toasts, doc } = setup({ rpcAnswer: { tool: 'ruff', text: 'x = 1' } });
    await commands.get('format.document')!();
    expect(doc.value).toBe('x = 1');
    expect(toasts).toEqual(['Файл отформатирован']);
  });

  it('файл только для чтения не трогает и говорит почему', async () => {
    const { commands, toasts, doc } = setup({ active: document({ readOnly: true }) });
    await commands.get('format.document')!();
    expect(doc.value).toBe('x=1');
    expect(toasts).toEqual(['Файл открыт только для чтения — форматировать нечего']);
  });

  it('нет инструмента в проекте — «unavailable», а не «менять нечего»', async () => {
    const { deps, doc } = setup({ rpcAnswer: null });
    expect(await formatDocument(deps, doc as never)).toBe('unavailable');
  });

  it('форматтер вернул тот же текст — «unchanged», текст не переписываем', async () => {
    const { deps, doc } = setup({ rpcAnswer: { tool: 'ruff', text: 'x=1' } });
    expect(await formatDocument(deps, doc as never)).toBe('unchanged');
    expect(doc.value).toBe('x=1');
  });
});

describe('пути форматирования', () => {
  it('без выделения команда участка форматирует файл целиком', async () => {
    const { commands, toasts, doc } = setup({ hasSelection: false, rpcAnswer: { tool: 'ruff', text: 'y = 2' } });
    await commands.get('format.selection')!();
    expect(doc.value).toBe('y = 2');
    expect(toasts).toEqual(['Файл отформатирован']);
  });

  it('с выделением идёт в сервер, а не в инструмент проекта', async () => {
    const { commands, toasts, doc } = setup({ hasSelection: true, serverEdits: [] });
    await commands.get('format.selection')!();
    expect(doc.value).toBe('x=1');
    expect(toasts).toEqual(['Нечем форматировать участок: языковой сервер этого не умеет']);
  });

  it('сервер вернул правки — применяем их и молчим', async () => {
    const edits = [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, newText: 'y=1' }];
    const { toasts, deps, doc } = setup({ serverEdits: edits });
    const ok = await formatRangeWithServer(deps, doc.path, {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    });
    expect(ok).toBe(true);
    expect(toasts).toEqual([]);
  });

  it('текст итога различает «нет инструмента» и «менять нечего»', () => {
    expect(formatOutcomeMessage('python', 'changed')).toBe('Файл отформатирован');
    expect(formatOutcomeMessage('python', 'unchanged')).toBe('Менять нечего');
    expect(formatOutcomeMessage('node', 'unavailable')).toContain('в проекте нет');
  });
});
