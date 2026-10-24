import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';

/**
 * `present` — объявить готовый результат. Ведёт себя скромно: файл не читает и не
 * меняет, только проверяет, что он есть, и отдаёт список в ленту.
 *
 * Проверяем главное: объявить несуществующее нельзя (кнопка-обманка хуже отказа),
 * папка — не результат, а потолок не даёт превратить ответ в список проекта.
 */
function context(
  stat: (path: string) => Promise<{ path: string; kind: 'file' | 'directory' | 'symlink' }>,
): ToolContext {
  const workspace = { stat } as unknown as ToolContext['workspace'];
  return { workspace };
}

/** Простое «файл есть»: путь возвращается как пришёл. */
const exists = async (filePath: string): Promise<{ path: string; kind: 'file' | 'directory' | 'symlink' }> => ({
  path: filePath,
  kind: 'file',
});

describe('present', () => {
  it('объявляет файл результатом и отдаёт его в ленту', async () => {
    const outcome = await runTool(
      context(exists),
      'present',
      JSON.stringify({ paths: ['/p/docs/тз.md'], note: 'ТЗ в markdown' }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.presented).toEqual([{ path: '/p/docs/тз.md', note: 'ТЗ в markdown' }]);
    // Подпись короткая: имя файла, а не путь целиком.
    expect(outcome.summary).toContain('тз.md');
    // Модели сказано, что ссылки в тексте больше не нужны.
    expect(outcome.detail).toContain('кнопками');
  });

  it('без note карточка тоже работает', async () => {
    const outcome = await runTool(context(exists), 'present', JSON.stringify({ paths: ['/p/a.txt'] }));
    expect(outcome.ok).toBe(true);
    expect(outcome.presented).toEqual([{ path: '/p/a.txt' }]);
  });

  it('несуществующий файл — отказ, а не кнопка-обманка', async () => {
    const outcome = await runTool(
      context(async (filePath) => {
        if (filePath.includes('нет')) throw new Error('Путь не найден');
        return { path: filePath, kind: 'file' };
      }),
      'present',
      JSON.stringify({ paths: ['/p/есть.md', '/p/нет.md'] }),
    );

    // Найденное показываем, пропавшее называем словами.
    expect(outcome.ok).toBe(true);
    expect(outcome.presented).toEqual([{ path: '/p/есть.md' }]);
    expect(outcome.detail).toContain('/p/нет.md');
  });

  it('папка — не результат: её в карточку не выводим', async () => {
    const outcome = await runTool(
      context(async (filePath) => ({ path: filePath, kind: 'directory' })),
      'present',
      JSON.stringify({ paths: ['/p/docs'] }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.presented).toBeUndefined();
    expect(outcome.detail).toContain('папка');
  });

  it('пустой список — отказ с объяснением, что нужно', async () => {
    const outcome = await runTool(context(exists), 'present', JSON.stringify({ paths: [] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('paths');
  });

  it('одиночный path вместо списка принимается: модель путает форму', async () => {
    const outcome = await runTool(context(exists), 'present', JSON.stringify({ path: '/p/один.txt' }));
    expect(outcome.presented).toEqual([{ path: '/p/один.txt' }]);
  });

  it('место из line/column достаётся первому файлу', async () => {
    const outcome = await runTool(
      context(exists),
      'present',
      JSON.stringify({ paths: ['/p/главное.md', '/p/ещё.md'], line: 12, column: 5 }),
    );

    // Якорь у present один: второй файл открывается целиком, без чужих строк.
    expect(outcome.presented).toEqual([{ path: '/p/главное.md', line: 12, column: 5 }, { path: '/p/ещё.md' }]);
  });

  it('одна строка без column — тоже место', async () => {
    const outcome = await runTool(context(exists), 'present', JSON.stringify({ paths: ['/p/a.txt'], line: 7 }));
    expect(outcome.presented).toEqual([{ path: '/p/a.txt', line: 7 }]);
  });

  it('мусор вместо места — никакого места, но файл всё равно показан', async () => {
    // Ноль, дробь и строка — не строки в файле: с ними кнопка встанет наугад.
    for (const place of [{ line: 0 }, { line: 2.5 }, { line: '12' }, { column: 4 }]) {
      const outcome = await runTool(context(exists), 'present', JSON.stringify({ paths: ['/p/a.txt'], ...place }));
      expect(outcome.presented).toEqual([{ path: '/p/a.txt' }]);
    }
  });

  it('потолок не даёт превратить ответ в список проекта', async () => {
    const many = Array.from({ length: 12 }, (_, index) => `/p/f${index}.txt`);
    const outcome = await runTool(context(exists), 'present', JSON.stringify({ paths: many }));

    expect(outcome.presented).toHaveLength(8);
    expect(outcome.detail).toContain('Ещё 4');
  });
});
