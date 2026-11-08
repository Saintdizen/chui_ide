import { describe, expect, it } from 'vitest';
import { openFiles } from '../src/main/ai/agent-open-files';
import type { ToolContext } from '../src/main/ai/tool-context';

/**
 * `open_files` отвечает на вопрос, который в чате звучит чаще всего: «что у меня
 * сейчас открыто». Важны две вещи: активная вкладка видна отдельно, а пути
 * приходят от корня проекта — абсолютные от модели бесполезны и дороги.
 */

function ctx(files: { path: string; line: number; column: number; active: boolean }[] | null): ToolContext {
  return {
    workspace: { rootPath: () => '/проект' },
    openFiles: files === null ? undefined : async () => ({ files }),
  } as unknown as ToolContext;
}

describe('open_files', () => {
  it('без моста отвечает отказом, а не падает', async () => {
    const result = await openFiles(ctx(null));
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('недоступен');
  });

  it('ничего не открыто — это ответ, а не ошибка', async () => {
    const result = await openFiles(ctx([]));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('нет');
  });

  it('активный файл отмечен и идёт первым', async () => {
    const result = await openFiles(
      ctx([
        { path: '/проект/src/b.ts', line: 4, column: 2, active: false },
        { path: '/проект/src/a.ts', line: 12, column: 7, active: true },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toBeDefined();
    const lines = result.detail!.split('\n');
    expect(lines[0]).toContain('→ ');
    expect(lines[0]).toContain('src/a.ts:12:7');
    expect(lines[1]).toContain('src/b.ts:4:2');
  });

  it('пути от корня, а не абсолютные', async () => {
    const result = await openFiles(ctx([{ path: '/проект/src/a.ts', line: 1, column: 1, active: true }]));
    expect(result.detail).toContain('src/a.ts');
    expect(result.detail).not.toContain('/проект/src/a.ts');
  });
});
