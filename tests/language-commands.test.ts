import { describe, expect, it } from 'vitest';
import { registerLanguageCommands, type LanguageDeps } from '../src/renderer/core/language-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Язык и тесты. Ценные здесь — отказы генерации: каждое «нельзя» должно
 * объяснять причину, а не молчать, и файл не должен создаваться зря.
 */
function setup(options: { aiOn?: boolean; code?: string; testPath?: string | null } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  const deps = {
    dock: { show: (view: string) => log.push(`dock:${view}`) },
    rpc: {
      request: async (method: string) => {
        log.push(`rpc:${method}`);
        if (method === 'lsp.restart') return { running: [{ label: 'tsserver' }], servers: [{ label: 'tsserver' }] };
        if (method === 'ai.generateTest') return { code: 'test("x", () => {});' };
        return { ok: true };
      },
    },
    applyLspStatus: () => log.push('applyLsp'),
    refreshLspStatus: () => log.push('refreshLsp'),
    showToast: (message: string) => toasts.push(message),
    editors: {
      currentPath: '/proj/src/a.ts',
      selectedText: () => options.code ?? 'export const a = 1;',
      activeLanguage: () => 'typescript',
    },
    documents: { get: () => ({ value: options.code ?? '' }) },
    workspace: {
      root: '/proj',
      relative: () => 'src/a.ts',
      ownerOf: () => ({ root: '/proj' }),
    },
    aiEnabled: () => options.aiOn ?? true,
    warnAiDisabled: () => toasts.push('ИИ выключен'),
    explorer: { scheduleRefresh: () => log.push('refresh') },
    openPath: async (path: string) => log.push(`open:${path}`),
    schedule: (_ms: number, run: () => void) => run(),
  } as unknown as LanguageDeps;
  registerLanguageCommands(define, deps);
  return { commands, log, toasts };
}

describe('registerLanguageCommands', () => {
  it('регистрирует три команды', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual(['ai.generateTest', 'lsp.restart', 'tests.open']);
  });

  it('панель тестов — это показ дока, без запросов', () => {
    const { commands, log } = setup();
    commands.get('tests.open')!();
    expect(log).toEqual(['dock:tests']);
  });

  it('перезапуск серверов показывает новый статус и перепроверяет его', async () => {
    const { commands, log, toasts } = setup();
    await commands.get('lsp.restart')!();
    expect(log).toEqual(['rpc:lsp.restart', 'applyLsp', 'refreshLsp']);
    expect(toasts).toEqual(['Серверы: tsserver']);
  });

  it('при выключенном ИИ генерация не идёт в main', async () => {
    const { commands, log, toasts } = setup({ aiOn: false });
    await commands.get('ai.generateTest')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['ИИ выключен']);
  });

  it('пустой файл тестировать нечем', async () => {
    const { commands, log, toasts } = setup({ code: '' });
    await commands.get('ai.generateTest')!();
    expect(log).not.toContain('rpc:ai.generateTest');
    expect(toasts[0]).toBe('Нечего тестировать: пустой файл');
  });

  it('успех: файл создан, дерево обновлено, файл открыт', async () => {
    const { commands, log, toasts } = setup();
    await commands.get('ai.generateTest')!();
    expect(log).toEqual([
      'rpc:ai.generateTest',
      'rpc:workspace.createFile',
      'refresh',
      // Тест ложится в tests/, как ждёт соглашение проекта, а не рядом с файлом.
      'open:/proj/tests/a.test.ts',
    ]);
    expect(toasts.at(-1)).toBe('Тест создан: tests/a.test.ts');
  });
});
