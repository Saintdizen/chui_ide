import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectMemory } from '../src/main/ai/project-memory';
import { MAX_NOTES, type MemoryScope, type RememberResult } from '../src/shared/memory';
import { runTool, type MemoryTools, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';
import { removeTemp } from './temp';

/**
 * Хранилище памяти — .md-файлы в двух областях, поэтому проверяем на temp-каталоге.
 * Плюс инструменты `remember`/`forget` глазами агента: важны понятные ответы при
 * переполнении, «нечего удалять» и при выборе области.
 */

const roots: string[] = [];

afterEach(async () => {
  await removeTemp(roots);
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-memory-'));
  roots.push(dir);
  return dir;
}

/** Имена файлов .md в каталоге памяти. */
async function memoryFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
}

describe('ProjectMemory: .md-файлы', () => {
  it('запоминает и возвращает заметку, файл — markdown', async () => {
    const dir = await tempDir();
    const memory = new ProjectMemory(dir);
    await memory.remember('/proj', 'использовать pytest');

    expect(await memory.list('/proj')).toEqual([{ text: 'использовать pytest' }]);
    const files = await memoryFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith('.md')).toBe(true);
    expect(await fs.readFile(path.join(dir, files[0]!), 'utf8')).toContain('- использовать pytest');
  });

  it('память разных проектов не смешивается', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember('/proj/a', 'для A');
    await memory.remember('/proj/b', 'для B');

    expect((await memory.list('/proj/a')).map((note) => note.text)).toEqual(['для A']);
    expect((await memory.list('/proj/b')).map((note) => note.text)).toEqual(['для B']);
  });

  it('глобальная область одна на все проекты и лежит отдельным файлом', async () => {
    const dir = await tempDir();
    const memory = new ProjectMemory(dir);
    await memory.remember('/proj/a', 'личное', 'global');
    // Другой проект видит ту же глобальную заметку — она не привязана к корню.
    expect((await memory.list('/proj/b', 'global')).map((note) => note.text)).toEqual(['личное']);
    // И она НЕ попала в память проекта.
    expect(await memory.list('/proj/a', 'workspace')).toEqual([]);

    const files = await memoryFiles(dir);
    expect(files).toContain('global.md');
  });

  it('глобальная память доступна и без открытого проекта', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember(null, 'язык ответов — русский', 'global');
    expect((await memory.list(null, 'global')).map((note) => note.text)).toEqual(['язык ответов — русский']);
    // Память проекта без корня недоступна.
    expect(await memory.list(null, 'workspace')).toEqual([]);
  });

  it('переживает пересоздание хранилища (запись на диск)', async () => {
    const dir = await tempDir();
    await new ProjectMemory(dir).remember('/proj', 'надолго');
    // Новый экземпляр читает с диска, а не из кеша.
    expect((await new ProjectMemory(dir).list('/proj')).map((note) => note.text)).toEqual(['надолго']);
  });

  it('правка файла руками подхватывается при чтении', async () => {
    const dir = await tempDir();
    const memory = new ProjectMemory(dir);
    await memory.remember('/proj', 'первое');
    const file = path.join(dir, (await memoryFiles(dir))[0]!);
    // Дописываем заметку вручную, как это сделал бы человек в блокноте.
    await fs.appendFile(file, '- дописано руками\n', 'utf8');

    expect((await new ProjectMemory(dir).list('/proj')).map((note) => note.text)).toEqual([
      'первое',
      'дописано руками',
    ]);
  });

  it('forget убирает по подстроке и сообщает, сколько убрал', async () => {
    const memory = new ProjectMemory(await tempDir());
    await memory.remember('/proj', 'первое правило');
    await memory.remember('/proj', 'второе правило');

    const result = await memory.forget('/proj', 'первое');

    expect(result.removed).toBe(1);
    expect((await memory.list('/proj')).map((note) => note.text)).toEqual(['второе правило']);
  });

  it('нечитаемый файл — чистая память, а не ошибка', async () => {
    const dir = await tempDir();
    const memory = new ProjectMemory(dir);
    await memory.remember('/proj', 'нечто');
    const file = path.join(dir, (await memoryFiles(dir))[0]!);
    await fs.rm(file);
    await fs.mkdir(file); // на месте файла — каталог: чтение провалится

    expect(await new ProjectMemory(dir).list('/proj')).toEqual([]);
  });

  it('без рабочей папки проектную заметку не пишет', async () => {
    const memory = new ProjectMemory(await tempDir());
    expect(await memory.remember(null, 'x', 'workspace')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('инструменты remember/forget', () => {
  function context(memory: MemoryTools | undefined): ToolContext {
    const workspace = { rootPath: () => '/proj' } as unknown as WorkspaceService;
    return { workspace, memory };
  }

  it('remember записывает и отвечает числом заметок', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(
        async (_text: string, _scope?: MemoryScope): Promise<RememberResult> => ({
          ok: true,
          notes: [{ text: 'x' }],
          added: true,
        }),
      ),
      forget: vi.fn(),
      notes: vi.fn(async () => []),
    };
    const outcome = await runTool(context(memory), 'mind', '{"action":"remember","text":"важное"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('записана');
    // Без scope — память проекта.
    expect(memory.remember).toHaveBeenCalledWith('важное', 'workspace');
  });

  it('scope: "global" уходит в глобальную область', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(
        async (_text: string, _scope?: MemoryScope): Promise<RememberResult> => ({
          ok: true,
          notes: [{ text: 'x' }],
          added: true,
        }),
      ),
      forget: vi.fn(),
      notes: vi.fn(async () => []),
    };
    const outcome = await runTool(context(memory), 'mind', '{"action":"remember","text":"личное","scope":"global"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('глобальной');
    expect(memory.remember).toHaveBeenCalledWith('личное', 'global');
  });

  it('вытеснение на потолке видно в ответе', async () => {
    // Отказ `full` стоил агенту трёх шагов (`notes` → `forget` → `remember`) и он же
    // отвечал за переполнение. Теперь хранилище убирает самую давнюю заметку само.
    const memory: MemoryTools = {
      remember: vi.fn(
        async (_text: string, _scope?: MemoryScope): Promise<RememberResult> => ({
          ok: true,
          notes: [],
          added: true,
          dropped: 'самая давняя',
        }),
      ),
      forget: vi.fn(),
      notes: vi.fn(async () => []),
    };
    const outcome = await runTool(context(memory), 'mind', '{"action":"remember","text":"x"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('самая давняя');
  });

  it('notes показывает всю память, а не только ту часть, что в промпте', async () => {
    // В промпт едет только хвост памяти (`MEMORY_PROMPT_CHARS`): замер живой беседы
    // дал 12 показанных заметок из 40 — без полного списка `forget` бьёт наугад.
    const memory: MemoryTools = {
      remember: vi.fn(),
      forget: vi.fn(),
      notes: vi.fn(async () => [{ text: 'первая' }, { text: 'вторая' }]),
    };
    const outcome = await runTool(context(memory), 'mind', '{"action":"notes"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('1. первая');
    expect(outcome.detail).toContain('2. вторая');
    expect(outcome.detail).toContain('все заметки');
    // Без scope — память проекта, как у remember/forget.
    expect(memory.notes).toHaveBeenCalledWith('workspace');
  });

  it('forget про «нечего удалять» — не ошибка', async () => {
    const memory: MemoryTools = {
      remember: vi.fn(),
      forget: vi.fn(async () => ({ notes: [], removed: 0 })),
      notes: vi.fn(async () => []),
    };
    const outcome = await runTool(context(memory), 'mind', '{"action":"forget","query":"нет такого"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('нет');
  });

  it('без памяти инструмент недоступен', async () => {
    expect((await runTool(context(undefined), 'mind', '{"action":"remember","text":"x"}')).ok).toBe(false);
    expect((await runTool(context(undefined), 'mind', '{"action":"forget","query":"x"}')).ok).toBe(false);
  });

  it('незнакомое действие называет допустимые', async () => {
    const memory: MemoryTools = { remember: vi.fn(), forget: vi.fn(), notes: vi.fn(async () => []) };
    const outcome = await runTool(context(memory), 'mind', '{"action":"list"}');
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('remember, forget');
  });

  it('аргумент своего действия спрашивается по имени', async () => {
    // Схема общая: `text` и `query` нужны разным действиям, и ответ говорит, какое.
    const memory: MemoryTools = { remember: vi.fn(), forget: vi.fn(), notes: vi.fn(async () => []) };
    const lost = await runTool(context(memory), 'mind', '{"action":"forget"}');
    expect(lost.ok).toBe(false);
    expect(lost.summary).toContain('query');
    expect(memory.forget).not.toHaveBeenCalled();
  });

  it('потолок заметок держится вытеснением', async () => {
    const memory = new ProjectMemory(await tempDir());
    for (let index = 0; index < MAX_NOTES; index += 1) await memory.remember('/proj', `заметка ${index}`);

    const result = await memory.remember('/proj', 'лишняя');
    if (!result.ok) throw new Error('ожидалось успешное добавление');
    expect(result.dropped).toBe('заметка 0');
    expect(result.notes).toHaveLength(MAX_NOTES);
    expect(result.notes[MAX_NOTES - 1]).toEqual({ text: 'лишняя' });
  });
});
