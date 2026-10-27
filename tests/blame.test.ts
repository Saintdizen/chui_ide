import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlameController, type BlameAnnotation } from '../src/renderer/core/blame';
import type { BlameLine } from '../src/shared/git-blame';

/** Строка blame с разумными умолчаниями: в тесте важна пара полей, остальное — фон. */
const blameLine = (over: Partial<BlameLine> = {}): BlameLine => ({
  line: 1,
  hash: 'abc1234',
  author: 'Аня',
  date: '2024-01-02',
  summary: 'правка',
  text: 'code',
  ...over,
});

/** Контроллер с подставными источниками: следим, что и когда он показывает. */
function makeController(respond: (path: string, line: number) => Promise<BlameLine | null>) {
  const shown: Array<BlameAnnotation | null> = [];
  const shownAll: Array<{ path: string; annotations: BlameAnnotation[] }> = [];
  const request = vi.fn(respond);
  const controller = createBlameController({
    blameLine: request,
    // Режим «подписи у всего файла» — своя ветка; здесь проверяется только подпись у строки.
    blameFile: async () => [],
    show: (annotation) => shown.push(annotation),
    showAll: (path, annotations) => shownAll.push({ path, annotations }),
  });
  return { controller, shown, shownAll, request };
}

/** Проматывает задержку запроса и даёт промисам разрешиться. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(200);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createBlameController', () => {
  it('по умолчанию выключен и ничего не запрашивает', async () => {
    vi.useFakeTimers();
    const { controller, shown, request } = makeController(async () => blameLine());

    controller.update('/p/a.ts', 3);
    await settle();

    expect(controller.enabled).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // Показ выключен — редактору сказано убрать подпись.
    expect(shown).toEqual([null]);
  });

  it('после включения показывает подпись для строки под курсором', async () => {
    vi.useFakeTimers();
    const { controller, shown } = makeController(async () => blameLine({ author: 'Борис', date: '2023-05-06' }));

    controller.toggle();
    controller.update('/p/a.ts', 7);
    await settle();

    expect(shown.at(-1)).toEqual({ path: '/p/a.ts', line: 7, text: 'Борис, 2023-05-06 · правка' });
  });

  it('повторный заход на ту же строку не дёргает git — работает кэш', async () => {
    vi.useFakeTimers();
    const { controller, request } = makeController(async () => blameLine());

    controller.toggle();
    controller.update('/p/a.ts', 3);
    await settle();
    controller.update('/p/a.ts', 9);
    await settle();
    controller.update('/p/a.ts', 3);
    await settle();

    // Две разные строки — два запроса; возврат на первую из кэша.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('устаревший ответ не перекрывает свежую строку', async () => {
    vi.useFakeTimers();
    // Первая строка «отвечает» медленно, вторая — сразу: показывать должна вторая.
    const releaseFirst: { run: (() => void) | null } = { run: null };
    const { controller, shown } = makeController((_path, line) => {
      if (line === 1) {
        return new Promise<BlameLine | null>((resolve) => {
          releaseFirst.run = () => resolve(blameLine({ line: 1, author: 'Старый' }));
        });
      }
      return Promise.resolve(blameLine({ line: line, author: 'Свежий' }));
    });

    controller.toggle();
    controller.update('/p/a.ts', 1);
    await settle();
    controller.update('/p/a.ts', 2);
    await settle();
    releaseFirst.run?.();
    await settle();

    const last = shown.at(-1);
    expect(last?.line).toBe(2);
    expect(last?.text).toContain('Свежий');
  });

  it('выключение убирает подпись', async () => {
    vi.useFakeTimers();
    const { controller, shown } = makeController(async () => blameLine());

    controller.toggle();
    controller.update('/p/a.ts', 3);
    await settle();
    controller.toggle();

    expect(controller.enabled).toBe(false);
    expect(shown.at(-1)).toBeNull();
  });

  it('строку без данных показывает как отсутствие подписи', async () => {
    vi.useFakeTimers();
    const { controller, shown } = makeController(async () => null);

    controller.toggle();
    controller.update('/p/a.ts', 3);
    await settle();

    expect(shown.at(-1)).toBeNull();
  });

  it('файл сменился на «нет файла» — подпись снимается', async () => {
    vi.useFakeTimers();
    const { controller, shown } = makeController(async () => blameLine());

    controller.toggle();
    controller.update('/p/a.ts', 3);
    await settle();
    controller.update(null, 0);

    expect(shown.at(-1)).toBeNull();
  });
});
