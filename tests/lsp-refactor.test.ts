import { describe, expect, it, vi } from 'vitest';
import { LspFeatures } from '../src/renderer/editor/host/lsp-features';
import type { RpcClient } from '../src/renderer/core/rpc';
import {
  isAnyRefactorKind,
  isRefactorKind,
  pickAnyRefactors,
  pickRefactors,
  refactorKind,
  refactorLabel,
} from '../src/shared/lsp-refactor';
import type { CodeActionItem } from '../src/shared/lsp-code-actions';

/**
 * Извлечение и «разворачивание» (inline) как свои команды. Сам рефакторинг делает
 * языковой сервер — проверяем, что мы просим правильный раздел действий, переводим
 * диапазон в 0-based и отбираем нужный подвид из общего ответа.
 */

function action(kind: string, title = kind): CodeActionItem {
  return { title, kind, preferred: false, edits: null, command: null, diagnostics: [] };
}

function recordingRpc(answer: unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: vi.fn(async (_channel: string, payload: { method: string; params: unknown }) => {
      calls.push({ method: payload.method, params: payload.params });
      return answer;
    }),
  } as unknown as RpcClient;
  return { rpc, calls };
}

describe('виды рефакторинга', () => {
  it('вид действия и русское имя — по виду рефакторинга', () => {
    expect(refactorKind('extract')).toBe('refactor.extract');
    expect(refactorKind('inline')).toBe('refactor.inline');
    expect(refactorLabel('extract')).toBe('извлечение');
    expect(refactorLabel('inline')).toBe('разворачивание');
  });

  it('родитель накрывает подвиды, но не чужой префикс', () => {
    expect(isRefactorKind('refactor.extract', 'extract')).toBe(true);
    expect(isRefactorKind('refactor.extract.function', 'extract')).toBe(true);
    expect(isRefactorKind('refactor.extract.variable', 'extract')).toBe(true);
    // Граница отрезка: похожее, но не наше — не подходит.
    expect(isRefactorKind('refactor.extraction', 'extract')).toBe(false);
    // Чужой рефакторинг и быстрые исправления не подходят.
    expect(isRefactorKind('refactor.inline', 'extract')).toBe(false);
    expect(isRefactorKind('quickfix', 'extract')).toBe(false);
    expect(isRefactorKind('', 'inline')).toBe(false);
  });

  it('отбор оставляет только действия нужного вида', () => {
    const items = [action('refactor.extract.function'), action('refactor.inline'), action('source.organizeImports')];
    expect(pickRefactors(items, 'extract').map((entry) => entry.kind)).toEqual(['refactor.extract.function']);
    expect(pickRefactors(items, 'inline').map((entry) => entry.kind)).toEqual(['refactor.inline']);
  });

  it('любой рефакторинг — это весь раздел refactor, без деления на подвиды', () => {
    expect(isAnyRefactorKind('refactor')).toBe(true);
    expect(isAnyRefactorKind('refactor.extract.function')).toBe(true);
    expect(isAnyRefactorKind('refactor.rewrite')).toBe(true);
    // Граница отрезка и чужие разделы.
    expect(isAnyRefactorKind('refactoring')).toBe(false);
    expect(isAnyRefactorKind('quickfix')).toBe(false);
    expect(isAnyRefactorKind('source.organizeImports')).toBe(false);
    expect(isAnyRefactorKind('')).toBe(false);
  });

  it('общий отбор берёт все рефакторинги и не трогает прочее', () => {
    const items = [
      action('refactor.extract.function'),
      action('refactor.inline'),
      action('refactor.rewrite'),
      action('quickfix'),
      action('source.organizeImports'),
    ];
    expect(pickAnyRefactors(items).map((entry) => entry.kind)).toEqual([
      'refactor.extract.function',
      'refactor.inline',
      'refactor.rewrite',
    ]);
  });
});

describe('LspFeatures.refactor', () => {
  it('просит раздел refactor и переводит диапазон выделения в 0-based', async () => {
    const { rpc, calls } = recordingRpc([
      action('refactor.extract.function', 'Извлечь в функцию'),
      action('refactor.inline', 'Развернуть'),
    ]);
    const features = new LspFeatures(rpc);

    const actions = await features.refactor(
      '/p/a.ts',
      {
        startLine: 3,
        startColumn: 5,
        endLine: 4,
        endColumn: 2,
      },
      'extract',
    );

    // Отобрали только извлечение.
    expect(actions.map((entry) => entry.title)).toEqual(['Извлечь в функцию']);

    const call = calls[0]!;
    expect(call.method).toBe('textDocument/codeAction');
    expect((call.params as { range: unknown }).range).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 3, character: 1 },
    });
    expect((call.params as { context: { only: string[] } }).context.only).toEqual(['refactor']);
  });

  it('нулевой диапазон (символ под кареткой) для разворачивания', async () => {
    const { rpc, calls } = recordingRpc([action('refactor.inline')]);
    const features = new LspFeatures(rpc);

    const actions = await features.refactor(
      '/p/a.ts',
      { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      'inline',
    );
    expect(actions).toHaveLength(1);

    expect((calls[0]!.params as { range: unknown }).range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });

  it('пустой ответ сервера — пустой список, а не ошибка', async () => {
    const { rpc } = recordingRpc(null);
    const features = new LspFeatures(rpc);
    await expect(
      features.refactor('/p/a.ts', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, 'extract'),
    ).resolves.toEqual([]);
  });
});

describe('LspFeatures.refactorActions', () => {
  it('просит раздел refactor и отдаёт ВСЕ рефакторинги, включая прочее', async () => {
    const { rpc, calls } = recordingRpc([
      action('refactor.extract.function', 'Извлечь в функцию'),
      action('refactor.inline', 'Развернуть'),
      action('refactor.rewrite', 'Вынести в файл'),
      action('quickfix', 'Исправить'),
    ]);
    const features = new LspFeatures(rpc);

    const actions = await features.refactorActions('/p/a.ts', {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 4,
    });

    expect(actions.map((entry) => entry.title)).toEqual(['Вынести в файл', 'Извлечь в функцию', 'Развернуть']);

    const call = calls[0]!;
    expect(call.method).toBe('textDocument/codeAction');
    expect((call.params as { context: { only: string[] } }).context.only).toEqual(['refactor']);
    expect((call.params as { range: unknown }).range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 3 },
    });
  });

  it('пусто — сервер рефакторингов не предложил', async () => {
    const { rpc } = recordingRpc([]);
    const features = new LspFeatures(rpc);
    await expect(
      features.refactorActions('/p/a.ts', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }),
    ).resolves.toEqual([]);
  });
});
