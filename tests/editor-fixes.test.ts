import { describe, expect, it } from 'vitest';
import { createEditorFixes, type EditorFixesDeps } from '../src/renderer/core/editor-fixes';

type Doc = { languageId: string; text?: string } | undefined;

function fixes(
  over: {
    documents?: { get(path: string): Doc };
    missing?: { line: number; top: string }[];
    installed?: string[];
    actions?: unknown[];
  } = {},
) {
  const installed: string[] = over.installed ?? [];
  const deps = {
    editors: { path: () => '/p/a.py' },
    documents: over.documents ?? { get: () => ({ languageId: 'python', text: 'import yaml\n' }) },
    lsp: { codeActions: async () => over.actions ?? [], rename: async () => null },
    edits: { applyTextEdits: async () => ({ failed: [] }), applyFileEdits: async () => ({ failed: [] }) },
    importChecker: { missingFor: () => over.missing ?? [{ line: 0, top: 'yaml' }] },
    installPythonPackages: async (pkgs: string[]) => installed.push(...pkgs),
    installNodePackages: async (pkgs: string[]) => installed.push(...pkgs),
    showToast: () => undefined,
    runLensCommand: () => undefined,
  } as unknown as EditorFixesDeps;
  return { api: createEditorFixes(deps), installed };
}

describe('editor-fixes', () => {
  it('отдаёт все точки входа меню быстрых правок', () => {
    const { api } = fixes();
    expect(Object.keys(api).sort()).toEqual([
      'applyCodeAction',
      'importInstallActions',
      'runCodeActions',
      'runOrganizeImports',
      'runRefactor',
      'runRefactorMenu',
      'spellingQuickFixes',
    ]);
  });

  it('для обычного языка пунктов про установку пакетов нет', () => {
    const { api } = fixes({ documents: { get: () => ({ languageId: 'rust' }) } });
    expect(api.importInstallActions('/p/a.ts', { line: 0, column: 0 })).toEqual([]);
  });

  it('без недостающих импортов пунктов тоже нет', () => {
    const { api } = fixes({ missing: [] });
    expect(api.importInstallActions('/p/a.py', { line: 0, column: 0 })).toEqual([]);
  });

  it('для python предлагает поставить пакет по имени модуля', () => {
    const { api } = fixes();
    const items = api.importInstallActions('/p/a.py', { line: 0, column: 0 });
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).toContain('PyYAML');
  });

  it('пункт установки зовёт установщик нужного языка', async () => {
    const { api, installed } = fixes();
    const items = api.importInstallActions('/p/a.py', { line: 0, column: 0 });
    for (const item of items) item.onSelect?.();
    expect(installed.length).toBeGreaterThan(0);
  });
});
