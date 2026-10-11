import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectMemory } from '../src/main/ai/project-memory';
import { MAX_NOTES } from '../src/shared/memory';
import { runTool, type MemoryTools, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Хранилище памяти проекта — это файл, поэтому проверяем на temp-каталоге.
 * Плюс инструменты `remember`/`forget` глазами агента: важны понятные ответы
 * при переполнении и при «нечего удалять».
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-memory-'));
  roots.push(dir);
  return dir;
}

describe('ProjectMemory: файл', () => {
  it('запоминает и возвращает заметку', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember('/proj', 'использовать pytest');

    expect(await memory.list('/proj')).toEqual([{ text: 'использовать pytest', at: expect.any(Number) }]);
  });

  it('память разных проектов не смешивается', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember('/proj/a', 'для A');
    await memory.remember('/proj/b', 'для B');

    expect((await memory.list('/proj/a')).map((note) => note.text)).toEqual(['для A']);
    expect((await memory.list('/proj/b')).map((note) => note.text)).toEqual(['для B']);
  });

  it('переживает пересоздание хранилища (запись на диск)', async () => {
    const dir = await tempDir();
    await new ProjectMemory(dir).remember('/proj', 'надолго');
    // Новый экземпляр читает с диска, а не из кеша.
    expect((await new ProjectMemory(dir).list('/proj')).map((note) => note.text)).toEqual(['надолго']);
  });

  it('forget убирает по подстроке и сообщает, сколько убрал', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember('/proj', 'первое правило');
    await memory.remember('/proj', 'второе правило');

    const result = await memory.forget('/proj', 'первое');

    expect(result.removed).toBe(1);
    expect((await memory.list('/proj')).map((note) => note.text)).toEqual(['второе правило']);
  });

  it('повреждённый файл — чистая память, а не ошибка', async () => {
    const dir = await tempDir();
    const memory = new ProjectMemory(dir);
    await memory.remember('/proj', 'нечто'); // создаёт файл
    const file = (await fs.readdir(dir))[0]!;
    await fs.writeFile(path.join(dir, file), 'не json', 'utf8');

    expect(await new ProjectMemory(dir).list('/proj')).toEqual([]);
  });

  it('без рабочей папки ничего не пишет', async () => {
    const memory = new ProjectMemory(await tempDir());
    expect(await memory.list(null)).toEqual([]);
    expect(await memory.remember(null, 'x')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('инструменты remember/forget', () => {
  function context(memory: MemoryTools | undefined): ToolContext {
    const workspace = { rootPath: () => '/proj' } as unknown as WorkspaceService;
    return { workspace, memory };
  }

  it('remember записывает и отвечает числом заметок', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(async () => ({ ok: true, notes: [{ text: 'x', at: 1 }], added: true })),
      forget: vi.fn(),
    };
    const outcome = await runTool(context(memory), 'remember', '{"text":"важное"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('записана');
    expect(memory.remember).toHaveBeenCalledWith('важное');
  });

  it('переполнение — понятный отказ с подсказкой', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(async () => ({ ok: false, reason: 'full' })),
      forget: vi.fn(),
    };
    const outcome = await runTool(context(memory), 'remember', '{"text":"x"}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('заполнена');
    expect(outcome.detail).toContain('forget');
  });

  it('forget про «нечего удалять» — не ошибка', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(),
      forget: vi.fn(async () => ({ notes: [], removed: 0 })),
    };
    const outcome = await runTool(context(memory), 'forget', '{"query":"нет такого"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('нет');
  });

  it('без памяти инструменты недоступны', async () => {
    expect((await runTool(context(undefined), 'remember', '{"text":"x"}')).ok).toBe(false);
    expect((await runTool(context(undefined), 'forget', '{"query":"x"}')).ok).toBe(false);
  });

  it('потолок заметок соблюдается хранилищем', async () => {
    const memory = new ProjectMemory(await tempDir());
    for (let index = 0; index < MAX_NOTES; index += 1) await memory.remember('/proj', `заметка ${index}`);

    const overflow = await memory.remember('/proj', 'лишняя');
    expect(overflow).toEqual({ ok: false, reason: 'full' });
  });
});
