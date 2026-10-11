import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SearchSymbol } from '../src/shared/code-search';
import type { FileEdit } from '../src/shared/edits';
import type { SymbolLocation } from '../src/shared/lsp-locations';
import { runTool, type SymbolSearch, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Ссылки и переход к определению глазами агента.
 *
 * Проверяем без живого языкового сервера: важно поведение обёртки — по имени
 * находится объявление, к серверу уходит правильная позиция, недоступный сервер
 * честно называется, а путь вне проекта не проходит. Сам разбор ответов сервера
 * проверяется в `lsp-locations.test.ts`.
 */

// Корень — через `path.resolve`, а аргументы-пути подаём через `JSON.stringify`:
// инструмент приводит путь к своему диску и разделителю, и POSIX-литерал на
// Windows не совпал бы с ним (как и обратный слэш внутри строки JSON).
const ROOT = path.resolve('/proj');

/** Объявление символа так, как его отдаёт `workspace/symbol`. */
const declaration = (over: Partial<SearchSymbol> = {}): SearchSymbol => ({
  name: 'saveCalibration',
  kind: 'метод',
  container: 'SettingsStore',
  path: `${ROOT}/src/settings.ts`,
  line: 42,
  column: 3,
  ...over,
});

/** Заглушка языкового сервера: поиск символов и запросы про ссылки/переход/переименование. */
function makeSymbols(over: Partial<SymbolSearch> = {}) {
  return {
    // Возвращаем символ с именем из запроса: так его пропустит ранжирование по имени.
    projectSymbols: vi.fn(async (query: string) => [declaration({ name: query })] as readonly SearchSymbol[]),
    languageFor: vi.fn(() => 'typescript'),
    references: vi.fn(async () => [] as readonly SymbolLocation[]),
    definition: vi.fn(async () => [] as readonly SymbolLocation[]),
    rename: vi.fn(async () => [] as readonly FileEdit[]),
    ...over,
  };
}

function context(symbols: SymbolSearch | undefined, options: Partial<ToolContext> = {}): ToolContext {
  const workspace = {
    rootPath: () => ROOT,
    readFile: async () => ({ text: 'const x = 1;\n', mtimeMs: 0 }),
  } as unknown as WorkspaceService;
  return { workspace, symbols, ...options };
}

/** Мост применения правок: запоминает, что ушло в документную модель. */
function applySpy(rejected = false) {
  return vi.fn(async (edits: FileEdit[]) => ({
    ...(rejected
      ? { rejected: true as const }
      : { result: { reports: edits.map((f) => ({ path: f.path, applied: f.edits.length, version: 1 })), failed: [] } }),
  }));
}

describe('find_references', () => {
  it('находит объявление по имени и спрашивает ссылки в его позиции', async () => {
    const symbols = makeSymbols({
      references: vi.fn(async () => [
        { path: `${ROOT}/src/a.ts`, line: 10, column: 1 },
        { path: `${ROOT}/src/b.ts`, line: 3, column: 5 },
      ]),
    });

    const outcome = await runTool(context(symbols), 'find_references', '{"symbol":"saveCalibration"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('мест 2');
    // Позиция объявления уходит 1-based как есть — перевод в 0-based делает сервис.
    expect(symbols.references).toHaveBeenCalledWith(
      `${ROOT}/src/settings.ts`,
      'typescript',
      expect.any(String),
      42,
      3,
      true,
    );
    expect(outcome.detail).toBe('src/a.ts:10:1\nsrc/b.ts:3:5');
  });

  it('includeDeclaration=false передаётся в сервис', async () => {
    const symbols = makeSymbols();
    await runTool(context(symbols), 'find_references', '{"symbol":"x","includeDeclaration":false}');

    expect(symbols.references).toHaveBeenCalledWith(expect.any(String), 'typescript', expect.any(String), 42, 3, false);
  });

  it('объявление не найдено — не ошибка, а понятный ответ', async () => {
    const symbols = makeSymbols({ projectSymbols: vi.fn(async () => [] as readonly SearchSymbol[]) });
    const outcome = await runTool(context(symbols), 'find_references', '{"symbol":"nope"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('не найдено');
    expect(symbols.references).not.toHaveBeenCalled();
  });

  it('сервер не умеет ссылки — говорим об этом, а не «ничего не найдено»', async () => {
    const symbols = makeSymbols({ references: vi.fn(async () => null) });
    const outcome = await runTool(context(symbols), 'find_references', '{"symbol":"x"}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не ищет ссылки');
  });

  it('без языкового сервера инструмент недоступен', async () => {
    const outcome = await runTool(context(makeSymbols(), { symbols: undefined }), 'find_references', '{"symbol":"x"}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не подключён');
  });

  it('фильтр по файлу выбирает объявление из него, а не первое по рангу', async () => {
    const symbols = makeSymbols({
      projectSymbols: vi.fn(
        async () =>
          [
            declaration({ path: `${ROOT}/src/first.ts`, line: 1 }),
            declaration({ path: `${ROOT}/src/second.ts`, line: 99 }),
          ] as readonly SearchSymbol[],
      ),
    });
    await runTool(
      context(symbols),
      'find_references',
      JSON.stringify({ symbol: 'saveCalibration', path: path.join(ROOT, 'src', 'second.ts') }),
    );

    expect(symbols.references).toHaveBeenCalledWith(
      `${ROOT}/src/second.ts`,
      'typescript',
      expect.any(String),
      99,
      3,
      true,
    );
  });

  it('путь вне рабочей папки не сужает поиск молча (фильтр игнорируется)', async () => {
    const symbols = makeSymbols();
    await runTool(context(symbols), 'find_references', '{"symbol":"x","path":"/etc/passwd"}');

    // Фильтр отброшен, взят лучший символ по имени.
    expect(symbols.references).toHaveBeenCalledWith(
      `${ROOT}/src/settings.ts`,
      'typescript',
      expect.any(String),
      42,
      3,
      true,
    );
  });
});

describe('go_to_definition', () => {
  it('по имени отдаёт объявления символа', async () => {
    const symbols = makeSymbols();
    const outcome = await runTool(context(symbols), 'go_to_definition', '{"symbol":"saveCalibration"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('мест 1');
    expect(outcome.detail).toBe('src/settings.ts:42:3');
  });

  it('из позиции использования спрашивает сервер и переводит позицию в 0-based', async () => {
    const symbols = makeSymbols({
      definition: vi.fn(async () => [{ path: `${ROOT}/src/settings.ts`, line: 42, column: 3 }]),
    });
    const usePath = path.join(ROOT, 'src', 'use.ts');
    const outcome = await runTool(
      context(symbols),
      'go_to_definition',
      JSON.stringify({ path: usePath, line: 8, column: 11 }),
    );

    expect(outcome.ok).toBe(true);
    expect(symbols.definition).toHaveBeenCalledWith(usePath, 'typescript', expect.any(String), 8, 11);
    expect(outcome.detail).toBe('src/settings.ts:42:3');
  });

  it('без столбца позиция использования берётся с начала строки', async () => {
    const symbols = makeSymbols({ definition: vi.fn(async () => [{ path: `${ROOT}/a.ts`, line: 1, column: 1 }]) });
    const usePath = path.join(ROOT, 'use.ts');
    await runTool(context(symbols), 'go_to_definition', JSON.stringify({ path: usePath, line: 8 }));

    expect(symbols.definition).toHaveBeenCalledWith(usePath, 'typescript', expect.any(String), 8, 1);
  });

  it('ни имени, ни позиции — понятная подсказка', async () => {
    const outcome = await runTool(context(makeSymbols()), 'go_to_definition', '{}');
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('symbol');
  });

  it('язык не распознан — честный отказ вместо пустого перехода', async () => {
    const symbols = makeSymbols({ languageFor: vi.fn(() => null) });
    const outcome = await runTool(
      context(symbols),
      'go_to_definition',
      JSON.stringify({ path: path.join(ROOT, 'a.txt'), line: 1 }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('язык не распознан');
  });
});

describe('rename_symbol', () => {
  const edits: FileEdit[] = [
    {
      path: `${ROOT}/src/a.ts`,
      edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 3, newText: 'newName' }],
    },
  ];

  it('находит символ по имени, спрашивает сервер и применяет правки', async () => {
    const symbols = makeSymbols({ rename: vi.fn(async () => edits) });
    const applyEdits = applySpy();
    const outcome = await runTool(
      context(symbols, { applyEdits }),
      'rename_symbol',
      '{"symbol":"saveCalibration","newName":"newName"}',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('saveCalibration → newName');
    // Позиция объявления уходит 1-based как есть; перевод в 0-based делает сервис.
    expect(symbols.rename).toHaveBeenCalledWith(
      `${ROOT}/src/settings.ts`,
      'typescript',
      expect.any(String),
      42,
      3,
      'newName',
    );
    expect(applyEdits).toHaveBeenCalledOnce();
  });

  it('отклонённые пользователем правки — не ошибка инструмента, а ответ', async () => {
    const symbols = makeSymbols({ rename: vi.fn(async () => edits) });
    const outcome = await runTool(
      context(symbols, { applyEdits: applySpy(true) }),
      'rename_symbol',
      '{"symbol":"x","newName":"y"}',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('отклонил переименование');
  });

  it('сервер не умеет переименование — говорим об этом прямо', async () => {
    const symbols = makeSymbols({ rename: vi.fn(async () => null) });
    const outcome = await runTool(
      context(symbols, { applyEdits: applySpy() }),
      'rename_symbol',
      '{"symbol":"x","newName":"y"}',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не умеет переименование');
  });

  it('новое имя совпадает со старым — нечего делать', async () => {
    const outcome = await runTool(
      context(makeSymbols(), { applyEdits: applySpy() }),
      'rename_symbol',
      '{"symbol":"x","newName":"x"}',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('совпадает');
  });

  it('без моста правок инструмент недоступен', async () => {
    const outcome = await runTool(
      context(makeSymbols(), { applyEdits: undefined }),
      'rename_symbol',
      '{"symbol":"x","newName":"y"}',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не подключено');
  });
});
