import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApplyEditsHostResult } from '../src/shared/api';
import { mergePatchResult } from '../src/renderer/ui/chat-patches';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Что инструменты правки говорят о записи на диск.
 *
 * Смысл проверки: правка может лечь только в буфер редактора — без полного доступа
 * файл пишет человек, а при конфликте с чужой правкой запись не проходит вовсе.
 * Файлы читаются с диска, поэтому агент обязан об этом узнать: иначе он считает
 * текст применённым, а следующее чтение вернёт старый — и ошибка покажется не в
 * правке, а в чтении.
 */

const ROOT = path.resolve('/proj');

const EDITS_ARGS =
  '{"edits":[{"path":"/proj/a.ts","edits":[{"startLine":1,"startColumn":1,"endLine":1,"endColumn":2,"newText":"x"}]}]}';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const workspace = { rootPath: () => ROOT } as unknown as WorkspaceService;
  return { workspace, ...overrides };
}

/** Мост правок: отдаём готовый ответ renderer и считаем вызовы. */
function bridge(result: ApplyEditsHostResult) {
  return vi.fn(async () => result);
}

describe('apply_edit: записан ли файл на диск', () => {
  it('всё записано — о буфере не говорим', async () => {
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 2, version: 3 }], failed: [] },
    });
    const outcome = await runTool(context({ applyEdits }), 'apply_edit', EDITS_ARGS);

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe('применено файлов: 1');
    expect(outcome.detail).not.toContain('буфер');
  });

  it('правка осталась в буфере — в итоге это сказано прямо', async () => {
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 2, version: 3 }], failed: [] },
      unwritten: ['/proj/a.ts'],
    });
    const outcome = await runTool(context({ applyEdits }), 'apply_edit', EDITS_ARGS);

    expect(outcome.summary).toBe('применено файлов: 1, не записано на диск: 1');
    expect(outcome.detail).toContain('буфер a.ts');
  });

  it('отказ пользователя — про запись речи нет', async () => {
    const applyEdits = bridge({ rejected: true });
    const outcome = await runTool(context({ applyEdits }), 'apply_edit', EDITS_ARGS);

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('отклонил');
  });
});

describe('apply_patch: записан ли файл на диск', () => {
  it('якорь разошёлся — файл не применён вовсе', async () => {
    const applyPatches = bridge({
      rejected: false,
      result: {
        reports: [],
        failed: [{ path: '/proj/a.ts', message: 'фрагмент не найден' }],
      },
    });
    const outcome = await runTool(
      context({ applyPatches }),
      'apply_patch',
      '{"patches":[{"path":"/proj/a.ts","patches":[{"oldText":"x","newText":"y"}]}]}',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toBe('применено файлов: 0, с ошибками: 1');
  });

  it('одна запись осталась в буфере — говорим и о ней', async () => {
    // Ответ собираем тем же сводом, что и окно (`mergePatchResult`): иначе проверка
    // сторожила бы только main, а оговорку терял бы renderer — и в живом окне её
    // не было бы видно, хотя тест зелёный.
    const applyPatches = bridge(
      mergePatchResult(
        {
          rejected: false,
          result: {
            reports: [
              { path: '/proj/a.ts', applied: 1, version: 1 },
              { path: '/proj/b.ts', applied: 1, version: 1 },
            ],
            failed: [],
          },
          unwritten: ['/proj/b.ts'],
        },
        [],
      ),
    );
    const outcome = await runTool(
      context({ applyPatches }),
      'apply_patch',
      '{"patches":[{"path":"/proj/a.ts","patches":[{"oldText":"x","newText":"y"}]},{"path":"/proj/b.ts","patches":[{"oldText":"x","newText":"y"}]}]}',
    );

    expect(outcome.summary).toBe('применено файлов: 2, не записано на диск: 1');
    expect(outcome.detail).toContain('буфер b.ts');
    expect(outcome.detail).not.toContain('буфер a.ts');
  });
});
