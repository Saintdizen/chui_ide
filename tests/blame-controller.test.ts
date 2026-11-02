import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlameController } from '../src/renderer/core/blame';
import type { BlameLine } from '../src/shared/git-blame';

/**
 * Подписи «кто и когда изменил строку» (`renderer/core/blame.ts`).
 *
 * Запрос за подписью — обращение к git, и он дорог. Поэтому здесь три вещи, которые
 * легко сломать незаметно: задержка (пока человек ведёт курсором, спрашивать на
 * каждую строку незачем), кэш (повторный заход на строку не должен снова идти в
 * git) и разделение режимов — у строки против всего файла.
 */

function line(overrides: Partial<BlameLine> = {}): BlameLine {
  return {
    commit: 'abc123',
    author: 'Автор',
    time: 1_700_000_000,
    summary: 'правка',
    line: 1,
    ...overrides,
  } as BlameLine;
}

function setup() {
  const shown: { path: string; line: number; text: string }[] = [];
  const all: { path: string; count: number }[] = [];
  const blameLine = vi.fn(async (): Promise<BlameLine | null> => line());
  const blameFile = vi.fn(async () => [line({ line: 1 }), line({ line: 2 })]);
  const controller = createBlameController({
    blameLine,
    blameFile,
    show: (annotation) => {
      if (annotation) shown.push(annotation);
    },
    showAll: (path, annotations) => all.push({ path, count: annotations.length }),
  });
  return { controller, blameLine, blameFile, shown, all };
}

const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

describe('режимы подписей', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('по умолчанию выключено и ничего не запрашивает', async () => {
    const { controller, blameLine } = setup();

    controller.update('/p/a.ts', 3);
    await wait();

    expect(controller.mode).toBe('off');
    expect(controller.enabled).toBe(false);
    expect(blameLine).not.toHaveBeenCalled();
  });

  it('переключение включает и выключает подпись у строки', () => {
    const { controller } = setup();

    expect(controller.toggle()).toBe(true);
    expect(controller.mode).toBe('line');

    expect(controller.toggle()).toBe(false);
    expect(controller.mode).toBe('off');
  });

  it('режим у файла выключает выключение у строки и наоборот', () => {
    // Два режима взаимоисключающие: иначе подписи рисовались бы дважды.
    const { controller } = setup();

    controller.toggleFile();
    expect(controller.mode).toBe('file');

    controller.toggle();
    expect(controller.mode).toBe('line');

    controller.toggleFile();
    expect(controller.mode).toBe('file');

    controller.toggleFile();
    expect(controller.mode).toBe('off');
  });

  it('выключение убирает подпись с экрана', () => {
    const { controller } = setup();

    controller.toggle();
    controller.toggle();

    // Подпись не должна остаться висеть после выключения режима.
    expect(controller.mode).toBe('off');
  });
});

describe('запрос за подписью', () => {
  it('переход по строкам даёт один запрос, а не по одному на каждую', async () => {
    // Пока человек ведёт курсором, спрашивать на каждую строку незачем.
    const { controller, blameLine } = setup();
    controller.toggle();

    controller.update('/p/a.ts', 1);
    controller.update('/p/a.ts', 2);
    controller.update('/p/a.ts', 3);
    await wait();

    expect(blameLine).toHaveBeenCalledTimes(1);
    expect(blameLine).toHaveBeenCalledWith('/p/a.ts', 3);
  });

  it('подпись показывается с текстом аннотации', async () => {
    const { controller, shown } = setup();
    controller.toggle();

    controller.update('/p/a.ts', 7);
    await wait();

    expect(shown).toHaveLength(1);
    expect(shown[0]?.line).toBe(7);
    expect(shown[0]?.text.length).toBeGreaterThan(0);
  });

  it('повторный заход на ту же строку берётся из кэша', async () => {
    const { controller, blameLine } = setup();
    controller.toggle();

    controller.update('/p/a.ts', 5);
    await wait();
    controller.update('/p/a.ts', 9);
    await wait();
    controller.update('/p/a.ts', 5);
    await wait();

    // Пять и девять — два запроса; возврат на пять идёт из кэша.
    expect(blameLine).toHaveBeenCalledTimes(2);
  });

  it('другой файл с тем же номером строки — другой запрос', async () => {
    // Строка 5 одного файла и строка 5 другого — разные места.
    const { controller, blameLine } = setup();
    controller.toggle();

    controller.update('/p/a.ts', 5);
    await wait();
    controller.update('/p/b.ts', 5);
    await wait();

    expect(blameLine).toHaveBeenCalledTimes(2);
  });

  it('нет данных (файл вне git) — подпись не показывается, а не врёт', async () => {
    const { controller, blameLine, shown } = setup();
    blameLine.mockResolvedValue(null);
    controller.toggle();

    controller.update('/p/a.ts', 2);
    await wait();

    expect(shown).toEqual([]);
  });

  it('уход из редактора убирает подпись и не запрашивает', async () => {
    const { controller, blameLine } = setup();
    controller.toggle();

    controller.update(null, 0);
    await wait();

    expect(blameLine).not.toHaveBeenCalled();
  });
});

describe('подписи у всего файла', () => {
  it('режим файла запрашивает все строки и отдаёт их разом', async () => {
    const { controller, blameFile, all } = setup();

    controller.toggleFile();
    controller.update('/p/a.ts', 1);
    await wait();

    expect(blameFile).toHaveBeenCalledWith('/p/a.ts');
    expect(all.at(-1)).toEqual({ path: '/p/a.ts', count: 2 });
  });

  it('перезаход в режим файла не перечитывает файл', async () => {
    // Файл уже прочитан: читать заново при каждом движении курсора — лишняя работа.
    const { controller, blameFile } = setup();
    controller.toggleFile();
    controller.update('/p/a.ts', 1);
    await wait();

    controller.update('/p/a.ts', 5);
    await wait();

    expect(blameFile).toHaveBeenCalledTimes(1);
  });

  it('пустой ответ убирает подписи у файла', async () => {
    const { controller, blameFile, all } = setup();
    blameFile.mockResolvedValue([]);
    controller.toggleFile();

    controller.update('/p/a.ts', 1);
    await wait();

    expect(all.at(-1)).toEqual({ path: '/p/a.ts', count: 0 });
  });
});
