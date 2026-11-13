import { describe, expect, it } from 'vitest';
import type { ToolFileChange } from '../src/shared/api';
import { changeKindLabel, fileName, readFiles, touchedFiles, usedReferences } from '../src/shared/tool-files';

/**
 * Файлы вызова агента для ряда чипов в ленте чата.
 *
 * Проверяем два источника, потому что они разные по природе: файловые операции
 * приходят списком в результате инструмента, а правки документов (`edit`)
 * в результате не значатся — их берём из аргументов. Второй путь особенно важно
 * проверить на истории: после перезапуска результата в беседе уже нет, и если
 * файлы не вычитать из аргументов, ряд чипов пропадёт.
 */

const CHANGES: ToolFileChange[] = [
  { path: '/proj/src/a.ts', kind: 'created', lines: 12 },
  { path: '/proj/src/b.ts', kind: 'modified', replaced: 3 },
];

describe('readFiles', () => {
  it('берёт путь и границы из аргументов read', () => {
    const args = JSON.stringify({ path: '/p/a.ts', startLine: 10, endLine: 40 });
    expect(readFiles('read', args)).toEqual([{ path: '/p/a.ts', from: 10, to: 40 }]);
  });

  it('читает пачку paths и не приклеивает к ней границы одного файла', () => {
    // Границы относятся к одиночному чтению: скопировать их на все пять
    // файлов значило бы соврать про источники.
    const args = JSON.stringify({ paths: ['/p/a.ts', '/p/b.ts'], startLine: 3, endLine: 9 });
    expect(readFiles('read', args)).toEqual([{ path: '/p/a.ts' }, { path: '/p/b.ts' }]);
  });

  it('на прочих инструментах и на битом JSON молчит', () => {
    expect(readFiles('edit', JSON.stringify({ path: '/p/a.ts' }))).toEqual([]);
    expect(readFiles('read', 'не json')).toEqual([]);
    expect(readFiles('read', JSON.stringify({}))).toEqual([]);
  });
});

describe('usedReferences', () => {
  it('собирает файлы из вызовов и не повторяет один файл дважды', () => {
    const messages = [
      { role: 'assistant', toolCalls: [{ name: 'read', arguments: '{"path":"/p/a.ts"}' }] },
      { role: 'assistant', toolCalls: [{ name: 'read', arguments: '{"path":"/p/a.ts"}' }] },
      { role: 'assistant', toolCalls: [{ name: 'read', arguments: '{"path":"/p/b.ts"}' }] },
    ];
    expect(usedReferences(messages).files.map((file) => file.path)).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('говорит числом, сколько не влезло, а не молчит', () => {
    const paths = ['a', 'b', 'c'].map((name) => ({ name: 'read', arguments: `{"path":"${name}"}` }));
    const refs = usedReferences([{ role: 'assistant', toolCalls: paths }], 2);
    expect(refs.files).toHaveLength(2);
    expect(refs.omitted).toBe(1);
  });

  it('пустая история — пустая справка', () => {
    expect(usedReferences([])).toEqual({ files: [], omitted: 0 });
  });
});

describe('touchedFiles', () => {
  it('список из результата инструмента важнее аргументов', () => {
    // replace_in_files знает все изменённые файлы, а в аргументах их нет вовсе.
    const files = touchedFiles('replace_in_files', '{"query":"foo"}', CHANGES);

    expect(files).toEqual([
      { path: '/proj/src/a.ts', kind: 'created' },
      { path: '/proj/src/b.ts', kind: 'modified' },
    ]);
  });

  it('правки документов берутся из аргументов', () => {
    const args = JSON.stringify({ edits: [{ path: '/proj/src/a.ts' }, { path: '/proj/src/b.ts' }] });

    expect(touchedFiles('edit', args)).toEqual([
      { path: '/proj/src/a.ts', kind: 'edited' },
      { path: '/proj/src/b.ts', kind: 'edited' },
    ]);
  });

  it('один файл в пачке правок попадает в ряд один раз', () => {
    // Модель правит файл несколькими правками в одном вызове — это один файл.
    const args = JSON.stringify({
      edits: [{ path: '/proj/src/a.ts' }, { path: '/proj/src/a.ts' }],
    });

    expect(touchedFiles('edit', args)).toEqual([{ path: '/proj/src/a.ts', kind: 'edited' }]);
  });

  it('создание, удаление и перенос подписаны своим видом', () => {
    expect(touchedFiles('file', '{"action":"create","path":"/p/new.ts"}')).toEqual([
      { path: '/p/new.ts', kind: 'created' },
    ]);
    expect(touchedFiles('file', '{"action":"delete","path":"/p/old.ts"}')).toEqual([
      { path: '/p/old.ts', kind: 'deleted' },
    ]);
    expect(touchedFiles('file', '{"action":"move","from":"/p/a.ts","to":"/p/b.ts"}')).toEqual([
      { path: '/p/b.ts', kind: 'moved' },
    ]);
  });

  it('битые аргументы — пустой ряд, а не исключение', () => {
    // Лента чата не должна падать из-за того, что модель не собрала JSON.
    expect(touchedFiles('edit', 'не json')).toEqual([]);
    expect(touchedFiles('file', '{"action":"create","path":42}')).toEqual([]);
    expect(touchedFiles('edit', '{"edits":[]}')).toEqual([]);
  });

  it('инструмент без файлов файлов не приносит', () => {
    expect(touchedFiles('read_file', '{"path":"/p/a.ts"}')).toEqual([]);
    expect(touchedFiles('terminal', '{"action":"run","command":"ls"}')).toEqual([]);
  });

  it('аргумент без пути игнорируется, остальные остаются', () => {
    const args = JSON.stringify({ edits: [{ path: '/p/a.ts' }, {}, { path: '' }] });

    expect(touchedFiles('edit', args)).toEqual([{ path: '/p/a.ts', kind: 'edited' }]);
  });
});

describe('changeKindLabel', () => {
  it('вид операции — человеческим словом', () => {
    expect(changeKindLabel('created')).toBe('создан');
    expect(changeKindLabel('deleted')).toBe('удалён');
    expect(changeKindLabel('moved')).toBe('перенос');
    expect(changeKindLabel('modified')).toBe('заменено');
    expect(changeKindLabel('edited')).toBe('правка');
  });
});

describe('fileName', () => {
  it('имя без пути — и для `/`, и для `\\`', () => {
    expect(fileName('/proj/src/a.ts')).toBe('a.ts');
    expect(fileName('C:\\proj\\src\\a.ts')).toBe('a.ts');
    expect(fileName('a.ts')).toBe('a.ts');
  });
});
