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

describe('edit — слитая запись', () => {
  it('плоская форма доходит до правки', async () => {
    const applyPatches = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 1, version: 2 }], failed: [] },
    });
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      '{"path":"/proj/a.ts","edits":[{"oldText":"a","newText":"b"}]}',
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  it('замена без файла называет create с contents', async () => {
    const r = await runTool(context(), 'edit', '{"edits":[{"edits":[{"newText":"a\\nb"}]}]}');
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('contents');
  });

  // Схема `edit` возит только форму `edits[]`, а плоская запись — привычка, которую
  // модель притащит из прошлых бесед. Она должна доходить до правки, а не в отказ.
  it('плоская запись не платит шагом за форму', async () => {
    const applyPatches = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 1, version: 2 }], failed: [] },
    });
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      '{"path":"/proj/a.ts","oldText":"a","newText":"b"}',
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const sent = applyPatches.mock.calls[0]?.[0] as { path?: string; patches?: { oldText?: string }[] }[];
    // Плоская запись упакована в элемент списка: якоря верхнего уровня больше нет.
    expect(sent[0]?.patches?.[0]?.oldText).toBe('a');
  });

  // Ростер (п.45) даёт имя и действие, но не поля формы. Отказ обязан их назвать,
  // иначе инструмент из строки недостижим: модель знает действие и не знает букв.
  it('отказ по аргументам возвращает форму инструмента', async () => {
    const r = await runTool(context(), 'mind', '{"action":"remember"}');
    expect(r.ok).toBe(false);
    const text = `${r.summary}\n${r.detail ?? ''}`;
    expect(text).toContain('text');
    // Форма — в `detail`: там поля с типами и `action` со списком значений.
    expect(r.detail).toMatch(/Аргументы mind: \{action:string=/);
  });

  it('action уходит в файловые операции, а не в правку', async () => {
    const outcome = await runTool(context(), 'edit', '{"action":"move","path":"/proj/a.ts","to":"/proj/b.ts"}');
    expect(outcome.detail ?? outcome.summary).not.toContain('Не хватает аргумента: from');
  });
});

describe('edit по позициям: записан ли файл на диск', () => {
  it('всё записано — о буфере не говорим', async () => {
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 2, version: 3 }], failed: [] },
    });
    const outcome = await runTool(context({ applyEdits }), 'edit', EDITS_ARGS);

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
    const outcome = await runTool(context({ applyEdits }), 'edit', EDITS_ARGS);

    expect(outcome.summary).toBe('применено файлов: 1, не записано на диск: 1');
    expect(outcome.detail).toContain('буфер a.ts');
    // Причины нет — значит запись и не пытались (нет полного доступа):
    // так и говорим, не выдумывая отказ.
    expect(outcome.detail).toContain('сохранит человек');
  });

  it('конфликт с диском — совет перечитать, а не переделать правку', async () => {
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 2, version: 3 }], failed: [] },
      unwritten: ['/proj/a.ts'],
      unwrittenReasons: { '/proj/a.ts': 'conflict' },
    });
    const outcome = await runTool(context({ applyEdits }), 'edit', EDITS_ARGS);

    expect(outcome.detail).toContain('буфер a.ts');
    expect(outcome.detail).toContain('перечитай');
    // Про человека — только когда причина неизвестна.
    expect(outcome.detail).not.toContain('сохранит человек');
  });

  it('ФС отказала — в итог едет текст ошибки', async () => {
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 2, version: 3 }], failed: [] },
      unwritten: ['/proj/a.ts'],
      unwrittenReasons: { '/proj/a.ts': 'EACCES: permission denied' },
    });
    const outcome = await runTool(context({ applyEdits }), 'edit', EDITS_ARGS);

    expect(outcome.detail).toContain('EACCES');
    expect(outcome.detail).toContain('старый текст');
  });

  it('отказ пользователя — про запись речи нет', async () => {
    const applyEdits = bridge({ rejected: true });
    const outcome = await runTool(context({ applyEdits }), 'edit', EDITS_ARGS);

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('отклонил');
  });
});

describe('edit по якорю: записан ли файл на диск', () => {
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
      'edit',
      '{"edits":[{"path":"/proj/a.ts","edits":[{"oldText":"x","newText":"y"}]}]}',
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
      'edit',
      '{"edits":[{"path":"/proj/a.ts","edits":[{"oldText":"x","newText":"y"}]},{"path":"/proj/b.ts","edits":[{"oldText":"x","newText":"y"}]}]}',
    );

    expect(outcome.summary).toBe('применено файлов: 2, не записано на диск: 1');
    expect(outcome.detail).toContain('буфер b.ts');
    expect(outcome.detail).not.toContain('буфер a.ts');
  });
});

describe('edit: две адресации в одном вызове', () => {
  it('якоря и позиции уходят каждый своим мостом, а отчёт один', async () => {
    // Правка одна, а путей два: якоря разрешает renderer по тексту документа,
    // позиции применяет документная модель. Вызов с обоими — два моста, но для
    // агента это один результат: считать «применено 1 из 2» он не должен.
    const applyPatches = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 1, version: 1 }], failed: [] },
    });
    const applyEdits = bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/b.ts', applied: 1, version: 1 }], failed: [] },
    });
    const outcome = await runTool(
      context({ applyPatches, applyEdits }),
      'edit',
      JSON.stringify({
        edits: [
          { path: '/proj/a.ts', edits: [{ oldText: 'x', newText: 'y' }] },
          { path: '/proj/b.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'y' }] },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe('применено файлов: 2');
    expect(applyPatches).toHaveBeenCalledTimes(1);
    expect(applyEdits).toHaveBeenCalledTimes(1);
  });

  it('отказ человека — решение, а не ошибка правки', async () => {
    const applyPatches = bridge({ rejected: true });
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      JSON.stringify({ edits: [{ path: '/proj/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }] }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('отклонил');
    expect(outcome.detail).toContain('Не повторяй');
  });
});

describe('edit — формы, которые модель шлёт на самом деле', () => {
  // По переписи отказов (TASKS.md, п.43) семь из двадцати четырёх — именно форма:
  // якорь без обёртки, замены без пути, запись без якоря. Каждый такой отказ стоит
  // целого шага, хотя смысл вызова читался однозначно. Здесь — то, что теперь
  // понимается без повтора.
  const applied = () =>
    bridge({
      rejected: false,
      result: { reports: [{ path: '/proj/a.ts', applied: 1, version: 2 }], failed: [] },
    });

  it('плоская правка без обёртки edits[]', async () => {
    const applyPatches = applied();
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      JSON.stringify({ path: '/proj/a.ts', oldText: 'a', newText: 'b' }),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(applyPatches).toHaveBeenCalledTimes(1);
  });

  it('запись файла прямо в edits[] — ровно так, как объявлено схемой', async () => {
    // Вторая по частоте форма отказа: модель кладёт в `edits` запись целиком —
    // путь и замена рядом, а не замена с вложенным `edits`. Смысл читался, а вызов
    // падал: до разбора доходил `path` как чужое поле замены.
    const applyPatches = applied();
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      JSON.stringify({ edits: [{ path: '/proj/a.ts', oldText: 'a', newText: 'b' }] }),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(applyPatches).toHaveBeenCalledTimes(1);
  });

  it('описанная схемой форма с верхним путём и без него в элементе', async () => {
    const applyPatches = applied();
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      JSON.stringify({
        path: '/proj/a.ts',
        edits: [{ path: '/proj/a.ts', oldText: 'a', newText: 'b' }],
      }),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(applyPatches).toHaveBeenCalledTimes(1);
  });

  it('замены со своими путями собираются по файлам', async () => {
    const applyPatches = applied();
    const outcome = await runTool(
      context({ applyPatches }),
      'edit',
      JSON.stringify({
        edits: [
          { path: '/proj/a.ts', oldText: 'a', newText: 'b' },
          { path: '/proj/a.ts', oldText: 'c', newText: 'd' },
        ],
      }),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    // Две замены одного файла — один вызов правки, а не два: путь у них общий.
    expect(applyPatches).toHaveBeenCalledTimes(1);
    const [anchors] = applyPatches.mock.calls[0] as unknown as [[{ path: string }]];
    // Правки одного файла лежат в одной записи — файл у них общий, а не две карточки.
    expect(anchors).toHaveLength(1);
    expect((anchors[0] as unknown as { path: string }).path).toBe('/proj/a.ts');
  });

  it('запись без якоря в несуществующий файл — это создание', async () => {
    const createFile = vi.fn(async (target: string) => target);
    const workspace = {
      rootPath: () => ROOT,
      stat: async () => {
        throw new Error('Файл не найден: /proj/new.ts');
      },
      createFile,
    } as unknown as WorkspaceService;

    const outcome = await runTool(
      { workspace },
      'edit',
      JSON.stringify({ edits: [{ path: '/proj/new.ts', edits: [{ newText: 'a\nb' }] }] }),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(createFile).toHaveBeenCalledWith('/proj/new.ts', 'a\nb');
    expect(outcome.summary).toContain('создан');
  });

  it('запись без якоря в существующий файл — отказ с подсказкой', async () => {
    const createFile = vi.fn(async (target: string) => target);
    const workspace = {
      rootPath: () => ROOT,
      stat: async () => ({ size: 10, mtimeMs: 1, isDirectory: false }),
      createFile,
    } as unknown as WorkspaceService;

    const outcome = await runTool(
      { workspace },
      'edit',
      JSON.stringify({ edits: [{ path: '/proj/a.ts', edits: [{ newText: 'a' }] }] }),
    );

    expect(outcome.ok).toBe(false);
    // Файл уже есть: угадывать «заменить целиком» или «дописать» нельзя.
    expect(outcome.summary).toContain('oldText');
    expect(createFile).not.toHaveBeenCalled();
  });
});
