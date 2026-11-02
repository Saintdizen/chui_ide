import { describe, expect, it, vi } from 'vitest';
import { ReviewModel } from '../src/renderer/core/review-model';
import type { ReviewThread } from '../src/shared/review';
import { Emitter } from '../src/renderer/core/events';

/**
 * Замечания к коду (`renderer/core/review-model.ts`).
 *
 * Логика тредов — чистые функции в `shared/review.ts` и проверена отдельно. Здесь
 * поведение модели: что грузится при смене проекта, когда запись уходит в main и
 * что не теряется при гонке загрузок.
 *
 * RPC и рабочая область — заглушки: модель работает с ними через узкие интерфейсы,
 * и именно это позволяет проверить её без файловой системы.
 */

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't1',
    path: 'src/a.ts',
    side: 'modified',
    line: 3,
    anchor: 'const a = 1;',
    resolved: false,
    comments: [{ id: 'c1', author: 'вы', text: 'почему так?', createdAt: 1_767_225_600_000 }],
    ...overrides,
  };
}

/** Рабочая область: один корень, смена которого дёргает подписчиков. */
function workspace(root: string | null = '/proj') {
  const emitter = new Emitter<unknown>();
  return {
    root,
    onDidChange: emitter.event,
    setRoot(next: string | null) {
      this.root = next;
      emitter.fire(next);
    },
  };
}

function rpc(load: () => Promise<ReviewThread[]>) {
  const calls: { method: string; params?: unknown }[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === 'review.load') return load();
    return [];
  });
  return { calls, request };
}

/** Дать отработать загрузке, запущенной из конструктора. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('замечания к коду: загрузка', () => {
  it('без открытого проекта замечаний нет и запрос не уходит', async () => {
    const client = rpc(async () => [thread()]);
    const model = new ReviewModel(client as never, workspace(null) as never);
    await settled();

    expect(model.all).toEqual([]);
    expect(client.calls.map((call) => call.method)).not.toContain('review.load');
  });

  it('при открытом проекте читает список из main', async () => {
    const client = rpc(async () => [thread()]);
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();

    expect(model.all).toHaveLength(1);
    expect(model.forFile('src/a.ts')).toHaveLength(1);
  });

  it('хранилище недоступно — пустой список, а не отказ открыть проект', async () => {
    const client = rpc(async () => Promise.reject(new Error('нет файла')));
    const model = new ReviewModel(client as never, workspace() as never);

    await expect(model.reload()).resolves.toBeUndefined();
    expect(model.all).toEqual([]);
  });

  it('поздний ответ прошлого проекта не подменяет новый', async () => {
    // Пока грузили, открыли другой проект: ответ уже не к месту, иначе замечания
    // одного проекта показались бы в другом.
    let release: (value: ReviewThread[]) => void = () => {};
    const first = new Promise<ReviewThread[]>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const client = rpc(() => {
      call += 1;
      return call === 1 ? first : Promise.resolve([thread({ path: 'новый-проект.ts' })]);
    });
    const area = workspace('/a');
    const model = new ReviewModel(client as never, area as never);

    // Смену корня объявляем событием, как настоящая рабочая область: подмена `root`
    // напрямую повторную загрузку не запускает.
    area.setRoot('/b');
    await settled();
    // Старый ответ приходит последним — показать надо замечания нового проекта.
    release([thread({ path: 'из-старого-проекта.ts' })]);
    await settled();

    expect(model.all.map((item) => item.path)).toEqual(['новый-проект.ts']);
  });
});

describe('замечания к коду: правки', () => {
  it('пустой текст не создаёт тред и не пишет на диск', async () => {
    const client = rpc(async () => []);
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();

    expect(model.add('src/a.ts', 'modified', 1, 'текст', '   ')).toBeNull();
    expect(client.calls.map((call) => call.method)).not.toContain('review.save');
  });

  it('новое замечание сразу сохраняется и будит подписчиков', async () => {
    const client = rpc(async () => []);
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();
    const changed = vi.fn();
    model.onDidChange(changed);

    const id = model.add('src/a.ts', 'modified', 3, 'const a = 1;', 'почему так?');

    expect(id).toBeTruthy();
    expect(model.all).toHaveLength(1);
    expect(changed).toHaveBeenCalled();
    expect(client.calls.some((call) => call.method === 'review.save')).toBe(true);
  });

  it('ответ, решение и удаление меняют список', async () => {
    const client = rpc(async () => [thread()]);
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();

    model.reply('t1', 'поправил');
    expect(model.all[0]?.comments).toHaveLength(2);

    model.resolve('t1', true);
    expect(model.counts().resolved).toBe(1);
    expect(model.counts().open).toBe(0);

    model.resolve('t1', false);
    expect(model.counts().open).toBe(1);

    model.remove('t1');
    expect(model.all).toEqual([]);
  });

  it('решённые своего файла убираются, чужие и открытые остаются', async () => {
    const client = rpc(async () => [
      thread({ id: 'a', path: 'src/a.ts', resolved: true }),
      thread({ id: 'b', path: 'src/a.ts', resolved: false }),
      thread({ id: 'c', path: 'src/b.ts', resolved: true }),
    ]);
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();

    model.clearResolved('src/a.ts');

    expect(model.all.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('ошибка сохранения не теряет замечание', async () => {
    // Человек написал текст; если диск недоступен, потерять его на глазах нельзя.
    const client = rpc(async () => []);
    client.request = vi.fn(async (method: string) => {
      if (method === 'review.save') throw new Error('диск недоступен');
      return [];
    }) as never;
    const model = new ReviewModel(client as never, workspace() as never);
    await settled();

    model.add('src/a.ts', 'modified', 1, 'x', 'замечание');
    await settled();

    expect(model.all).toHaveLength(1);
  });
});
