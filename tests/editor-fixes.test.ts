import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeActionItem } from '../src/shared/lsp-code-actions';
import { createEditorFixes, type EditorFixesDeps } from '../src/renderer/core/editor-fixes';

/**
 * Быстрые правки под курсором — то место, где решение «применить сразу или
 * спросить» принимается по числу предложений. Показывать список из одной строки
 * или молча применить — разница, которую видно только здесь.
 */
const shown: { items: { label?: string; hint?: string; separator?: boolean }[]; left: number; top: number }[] = [];

vi.mock('../src/renderer/ui/popup-menu', () => ({
  showPopupMenu: (items: unknown[], left: number, top: number) => {
    shown.push({ items: items as never, left, top });
  },
}));

type Doc = { languageId: string; text?: string; lineCount?: number; readOnly?: boolean } | undefined;

interface Over {
  documents?: { get(path: string): Doc };
  missing?: { line: number; top: string }[];
  installed?: string[];
  actions?: CodeActionItem[];
  organize?: CodeActionItem[];
  refactor?: (path: string, range: unknown, action: unknown) => Promise<CodeActionItem[]>;
  refactorActions?: CodeActionItem[];
  spelling?: { suggestions: string[]; replace: boolean } | null;
  apply?: { failed: { path?: string; message: string }[] };
  toasts?: string[];
  lens?: string[];
  selection?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

function fixes(over: Over = {}) {
  const installed: string[] = over.installed ?? [];
  const toasts: string[] = over.toasts ?? [];
  const lens: string[] = over.lens ?? [];
  const range = over.selection ?? { startLine: 1, startColumn: 1, endLine: 2, endColumn: 5 };
  const deps = {
    editors: {
      path: () => '/p/a.ts',
      lspDiagnostics: () => [{ line: 2, column: 1, severity: 'warning', message: 'тут' }],
      caretPoint: () => ({ left: 40, bottom: 120 }),
      selectionRange: () => range,
      spellingSuggestionsAtCursor: () => over.spelling ?? null,
      replaceSpellingWord: (word: string) => {
        lens.push(`replace:${word}`);
        return over.spelling?.replace ?? true;
      },
      addSpellingWordToDictionary: () => lens.push('dictionary'),
      ignoreSpellingWord: () => lens.push('ignore'),
    },
    documents: over.documents ?? {
      get: () => ({ languageId: 'python', text: 'import yaml\n', lineCount: 4 }),
    },
    lsp: {
      codeActions: async () => over.actions ?? [],
      organizeImports: async () => over.organize ?? [],
      refactor: over.refactor ?? (async () => []),
      refactorActions: async () => over.refactorActions ?? [],
      rename: async () => null,
    },
    edits: {
      applyFileEdits: async () => over.apply ?? { failed: [] },
      applyTextEdits: async () => ({ failed: [] }),
    },
    importChecker: { missingFor: () => over.missing ?? [{ line: 0, top: 'yaml' }] },
    installPythonPackages: async (pkgs: string[]) => installed.push(...pkgs),
    installNodePackages: async (pkgs: string[]) => installed.push(...pkgs),
    showToast: (message: string) => toasts.push(message),
    runLensCommand: (path: string, command: { command: string }) => lens.push(`${path}:${command.command}`),
  } as unknown as EditorFixesDeps;
  return { api: createEditorFixes(deps), installed, toasts, lens, range };
}

const action = (over: Partial<CodeActionItem> = {}): CodeActionItem =>
  ({ title: 'Сделать так', kind: 'quickfix', ...over }) as CodeActionItem;

beforeEach(() => {
  shown.length = 0;
});


describe('editor-fixes: установка пакетов', () => {
  it('для обычного языка пунктов про установку пакетов нет', () => {
    const { api } = fixes({ documents: { get: () => ({ languageId: 'rust' }) } });
    expect(api.importInstallActions('/p/a.ts', { line: 0, column: 0 })).toEqual([]);
  });

  it('без недостающих импортов пунктов тоже нет', () => {
    const { api } = fixes({ missing: [] });
    expect(api.importInstallActions('/p/a.py', { line: 0, column: 0 })).toEqual([]);
  });

  it('недостающий импорт в другой строке не предлагается', () => {
    const { api } = fixes({ missing: [{ line: 5, top: 'yaml' }] });
    expect(api.importInstallActions('/p/a.py', { line: 0, column: 0 })).toEqual([]);
  });

  it('пункт установки переводит модуль в пакет и зовёт установщик', () => {
    const { api, installed } = fixes();
    const items = api.importInstallActions('/p/a.py', { line: 0, column: 0 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'Установить пакет PyYAML (pip)' });
    if ('onSelect' in items[0]!) items[0]!.onSelect?.();
    expect(installed).toEqual(['PyYAML']);
  });
});

describe('editor-fixes: правки под курсором', () => {
  it('одно предложение всё равно показывается списком — у каретки', async () => {
    const { api, lens } = fixes({
      actions: [action({ edits: [{ path: '/p/a.ts', edits: [] }], command: { command: 'run', arguments: [] } })],
    });
    await api.runCodeActions('/p/a.ts', { line: 2, column: 1 });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.items.map((item) => item.label)).toEqual(['Сделать так']);
    expect(shown[0]!.left).toBe(40);
    // Каретка внизу на 120 — список отступает на два пикселя, чтобы не встать на строку.
    expect(shown[0]!.top).toBe(122);
    expect(lens).toEqual([]);
  });

  it('пустой список говорит, что предлагать нечего', async () => {
    const { api, toasts } = fixes();
    await api.runCodeActions('/p/a.ts', { line: 2, column: 1 });
    expect(toasts).toEqual(['Быстрых исправлений здесь нет']);
    expect(shown).toHaveLength(0);
  });

  it('правка из списка применяется: правки — в документы, команда — в линзу', async () => {
    const { api, lens } = fixes({ actions: [action({ edits: [{ path: '/p/a.ts', edits: [] }] })] });
    await api.runCodeActions('/p/a.ts', { line: 2, column: 1 });
    const [item] = shown[0]!.items;
    if (item && 'onSelect' in item) (item as { onSelect: () => void }).onSelect();
    await Promise.resolve();
    expect(lens).toEqual([]);
  });

  it('неудавшаяся правка сообщается текстом первой ошибки', async () => {
    const { api, toasts } = fixes({
      actions: [action({ edits: [{ path: '/p/a.ts', edits: [] }] })],
      apply: { failed: [{ message: 'участок не найден' }] },
    });
    await api.applyCodeAction('/p/a.ts', action({ edits: [{ path: '/p/a.ts', edits: [] }] }));
    expect(toasts).toEqual(['участок не найден']);
  });

  it('правка с командой зовёт команду линзы, без команды — только правки', async () => {
    const withCommand = fixes();
    await withCommand.api.applyCodeAction('/p/a.ts', action({ command: { command: 'go', arguments: [] } }));
    expect(withCommand.lens).toEqual(['/p/a.ts:go']);

    const silent = fixes();
    await silent.api.applyCodeAction('/p/a.ts', action({ edits: [{ path: '/p/a.ts', edits: [] }] }));
    expect(silent.lens).toEqual([]);
    expect(silent.toasts).toEqual([]);
  });
});

describe('editor-fixes: импорты и переделки', () => {
  it('организация импортов: молчит при успехе, ругается при отказе', async () => {
    const ok = fixes({ organize: [action({ edits: [{ path: '/p/a.ts', edits: [] }] })] });
    await ok.api.runOrganizeImports('/p/a.ts');
    expect(ok.toasts).toEqual([]);

    const bad = fixes({
      organize: [action({ edits: [{ path: '/p/a.ts', edits: [] }] })],
      apply: { failed: [{ message: 'нет такого места' }] },
    });
    await bad.api.runOrganizeImports('/p/a.ts');
    expect(bad.toasts).toEqual(['нет такого места']);
  });

  it('организация импортов без предложений и без документа говорит разное', async () => {
    const { api, toasts } = fixes();
    await api.runOrganizeImports('/p/a.ts');
    expect(toasts).toEqual(['Упорядочить импорты сервер не предложил']);

    const noDoc = fixes({ documents: { get: () => undefined } });
    await noDoc.api.runOrganizeImports('/p/a.ts');
    expect(noDoc.toasts).toEqual([]);
  });

  it('переделка: одно предложение применяется, несколько — меню', async () => {
    const single = fixes({ refactorActions: [action({ edits: [{ path: '/p/a.ts', edits: [] }] })] });
    await single.api.runRefactorMenu('/p/a.ts');
    expect(shown).toHaveLength(0);

    const many = fixes({ refactorActions: [action({ title: 'A' }), action({ title: 'B' })] });
    await many.api.runRefactorMenu('/p/a.ts');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.items.map((item) => item.label)).toEqual(['A', 'B']);
  });

  it('переделка без предложений называет, чего не предложил сервер', async () => {
    const { api, toasts } = fixes();
    await api.runRefactorMenu('/p/a.ts');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('не предложил');
  });

  it('переделка зовёт сервер с выделением курсора', async () => {
    const refactor = vi.fn(async () => []);
    const { api, range, toasts } = fixes({ refactor });
    await api.runRefactor('/p/a.ts', 'extract');
    expect(refactor).toHaveBeenCalledWith('/p/a.ts', range, 'extract');
    expect(toasts).toHaveLength(1);
  });

  it('в режиме только чтения переделка не начинается', async () => {
    const { api, toasts, lens } = fixes({
      documents: { get: () => ({ languageId: 'typescript', readOnly: true }) },
    });
    await api.runRefactor('/p/a.ts', 'extract');
    expect(toasts[0]).toContain('только для чтения');
    expect(lens).toEqual([]);
  });
});

describe('editor-fixes: орфография', () => {
  it('без замечаний орфографии пунктов нет', () => {
    const { api } = fixes();
    expect(api.spellingQuickFixes()).toEqual([]);
  });

  it('предлагает замены, словарь и пропуск слова', () => {
    const { api } = fixes({ spelling: { suggestions: ['слово', 'слава'], replace: true } });
    const labels = api.spellingQuickFixes().map((item) => ('label' in item ? item.label : '—'));
    expect(labels).toEqual([
      'Заменить на «слово»',
      'Заменить на «слава»',
      'Добавить в словарь',
      'Пропустить слово',
    ]);
  });

  it('без вариантов замены остаются только словарь и пропуск', () => {
    const { api } = fixes({ spelling: { suggestions: [], replace: true } });
    const labels = api.spellingQuickFixes().map((item) => ('label' in item ? item.label : '—'));
    expect(labels).toEqual(['Добавить в словарь', 'Пропустить слово']);
  });
});
