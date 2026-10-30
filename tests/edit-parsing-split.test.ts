import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { combineOutcomes, parseEdits } from '../src/main/ai/edit-parsing';
import { normalizeWrite, wholeWrite } from '../src/main/ai/agent-edit';

/**
 * Граница `edit-parsing` — сторож на то, чего легко лишиться незаметно:
 * разбор правок должен понимать обе формы сразу, а `combineOutcomes` —
 * склеивать ответы нескольких файлов в один.
 */
describe('разбор правок отдельно от инструментов', () => {
  it('якорь: файл и замена в одном элементе', () => {
    const parsed = parseEdits([{ path: '/proj/a.ts', oldText: 'старое', newText: 'новое' }]);
    expect(parsed.positions).toHaveLength(0);
    expect(parsed.anchors).toHaveLength(1);
  });

  it('позиции: четыре границы без старого текста', () => {
    const parsed = parseEdits([
      {
        path: '/proj/a.ts',
        edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, newText: 'новое' }],
      },
    ]);
    expect(parsed.anchors).toHaveLength(0);
    expect(parsed.positions).toHaveLength(1);
  });

  it('адрес строками: startLine + endLine без столбцов — правка целыми строками', () => {
    // Столбцы модели пришлось бы считать на глаз — именно это и было промахом.
    // Номера строк даёт `read`, поэтому больше ничего не спрашиваем.
    const parsed = parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 12, endLine: 15, newText: 'новое' }] }]);
    const [edit] = parsed.positions[0]!.edits;
    expect(edit).toMatchObject({ startLine: 12, startColumn: 1, endLine: 15, newText: 'новое' });
    expect(edit!.endColumn).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('адрес строкой: одна startLine заменяет одну строку', () => {
    const parsed = parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 7, newText: 'x' }] }]);
    const [edit] = parsed.positions[0]!.edits;
    expect(edit).toMatchObject({ startLine: 7, endLine: 7, startColumn: 1 });
  });

  it('адрес наоборот — отказ словами, а не молчаливая правка не туда', () => {
    expect(() => parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 9, endLine: 3, newText: 'x' }] }])).toThrow(
      /наоборот/,
    );
  });

  it('не массив — ошибка с формой вызова, а не молчание', () => {
    expect(() => parseEdits({ path: '/proj/a.ts' })).toThrow(/массив/);
  });

  it('элемент без path называет форму — вызов чинится за один шаг', () => {
    expect(() => parseEdits([{ oldText: 'a', newText: 'b' }])).toThrow(/edits\[0\]/);
  });
  it('плоская запись целиком без `edits`: `{path, contents}` на верхнем уровне', () => {
    // Форма из живой беседы 30.10: `edit` прислал `path` и `contents` рядом, без
    // обёртки. Разбор ждал `edits[]` и падал на «edits[0].edits[0].newText:
    // нужна строка» — хотя файл назван и текст есть. Сторож на весь путь.
    const [item] = normalizeWrite({ path: '/proj/new.ts', contents: 'export const a = 1;\n' }) as Record<
      string,
      unknown
    >[];
    expect(wholeWrite(item as Record<string, unknown>)).toEqual({
      path: '/proj/new.ts',
      contents: 'export const a = 1;\n',
    });
  });

  it('запись файла целиком элементом массива: `{path, contents}` — это файл, а не замена', () => {
    // Формой `[{path, contents}]` инструмент `edit` ходил в отказ
    // «edits[0].edits[0].newText: нужна строка»: `contents` не знал `flatHunk`,
    // и запись доезжала до разбора замен без текста. Здесь сторож на весь путь.
    const [item] = normalizeWrite({
      edits: [{ path: '/proj/new.ts', contents: 'export const a = 1;\n' }],
    }) as Record<string, unknown>[];
    expect(wholeWrite(item as Record<string, unknown>)).toEqual({
      path: '/proj/new.ts',
      contents: 'export const a = 1;\n',
    });
  });

  it('отказ «не задан path» называет форму элемента и прошлый файл', () => {
    // Пять отказов из шести пришли правкой пачкой: первый элемент с `path`,
    // остальные без. По записи видно ключи, но не видно, куда путь класть —
    // теперь отказ это говорит: имена ключей элемента и путь предыдущего файла.
    let message = '';
    try {
      parseEdits([
        { path: '/proj/a.ts', oldText: 'a', newText: 'b' },
        { edits: [{ oldText: 'a', newText: 'b' }] },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('edits[1]: не задан path');
    expect(message).toContain('Элемент пришёл такой: {edits: [1x{oldText, newText}]}');
    expect(message).toContain('Прошлый файл в вызове: «/proj/a.ts»');
  });

  it('отказ «newText: нужна строка» называет чужое имя поля', () => {
    // Все шесть отказов 28.10 `edits[0].edits[0].newText: нужна строка` — это
    // запись целиком под именем из `create`: данные на месте, названы иначе.
    // Отказ называет имя вслух, чтобы второй вызов прошёл (а не подставляет).
    let message = '';
    try {
      parseEdits([{ path: '/proj/a.ts', edits: [{ contents: 'строка\nвторая' }] }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('edits[0].edits[0].newText: нужна строка');
    expect(message).toContain('лежит в `contents`');
    // Второй вызов без `create` — у нас нет инструмента с таким именем: пишем имя, по которому ищут.
    expect(message).toContain('у правки это поле зовётся `newText`');
  });

  it('замены в соседнем `edits` разбираются, а не отказывают', () => {
    // `{path, edits: [...]}` проходил раскладку: сторож ниже это утверждает.
    const parsed = parseEdits([{ path: '/proj/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }]);
    expect(parsed.anchors[0]!.path).toBe('/proj/a.ts');
  });

  it('запись целиком в чужом поле и без адреса: отказ называет и элемент, и адрес', () => {
    // Четыре из шести отказов 28.10 `edits[0].edits[0].newText: нужна строка` —
    // это файлы целиком, элементы без `path`. Сказать, как пришёл элемент, —
    // всё, что можно без угадывания.
    let message = '';
    try {
      parseEdits([{ edits: [{ path: '/proj/a.ts', contents: 'тело' }] }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('edits[0]: не задан path');
    expect(message).toContain('{edits: [1x{path, contents}]}');
  });
  it('файлы целиком в `contents` массива: отказ называет адрес, где им место', () => {
    // Четыре из шести отказов 28.10 `edits[0].edits[0].newText: нужна строка` —
    // запись целиком лежит в `contents`, а адреса — в самом `contents` массивом.
    // Подставлять адрес не угадываем — называем вслух.
    let message = '';
    try {
      parseEdits([{ contents: [{ path: '/proj/a.ts', contents: 'тело' }] }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Записи файлов лежат в `contents` вместе с адресами');
    expect(message).toContain('{contents: [1x{path, contents}]}');
  });

  it('combineOutcomes: единственный ответ отдаётся как есть', () => {
    const only = { ok: true, summary: 'одно' };
    expect(combineOutcomes([only])).toBe(only);
  });

  it('combineOutcomes: пустой список — не успех: ответов нет, значит и повода радоваться', () => {
    expect(combineOutcomes([]).ok).toBe(false);
  });

  it('модуль разбора не тянет за собой исполнение инструментов', () => {
    // Дешёвая, но честная проверка границы: если сюда вернётся вызов шелла или
    // хоста, файл снова станет «всем сразу».
    const source = readFileSync('src/main/ai/edit-parsing.ts', 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('runTool(');
  });
});
