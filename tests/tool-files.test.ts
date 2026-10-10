import { describe, expect, it } from 'vitest';
import type { ToolFileChange } from '../src/shared/api';
import { changeKindLabel, fileName, touchedFiles } from '../src/shared/tool-files';

/**
 * Файлы вызова агента для ряда чипов в ленте чата.
 *
 * Проверяем два источника, потому что они разные по природе: файловые операции
 * приходят списком в результате инструмента, а правки документов (`apply_edit`)
 * в результате не значатся — их берём из аргументов. Второй путь особенно важно
 * проверить на истории: после перезапуска результата в беседе уже нет, и если
 * файлы не вычитать из аргументов, ряд чипов пропадёт.
 */

const CHANGES: ToolFileChange[] = [
  { path: '/proj/src/a.ts', kind: 'created', lines: 12 },
  { path: '/proj/src/b.ts', kind: 'modified', replaced: 3 },
];

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

    expect(touchedFiles('apply_edit', args)).toEqual([
      { path: '/proj/src/a.ts', kind: 'edited' },
      { path: '/proj/src/b.ts', kind: 'edited' },
    ]);
  });

  it('один файл в пачке правок попадает в ряд один раз', () => {
    // Модель правит файл несколькими правками в одном вызове — это один файл.
    const args = JSON.stringify({
      edits: [{ path: '/proj/src/a.ts' }, { path: '/proj/src/a.ts' }],
    });

    expect(touchedFiles('apply_edit', args)).toEqual([{ path: '/proj/src/a.ts', kind: 'edited' }]);
  });

  it('создание, удаление и перенос подписаны своим видом', () => {
    expect(touchedFiles('create_file', '{"path":"/p/new.ts"}')).toEqual([{ path: '/p/new.ts', kind: 'created' }]);
    expect(touchedFiles('delete_file', '{"path":"/p/old.ts"}')).toEqual([{ path: '/p/old.ts', kind: 'deleted' }]);
    expect(touchedFiles('move_file', '{"from":"/p/a.ts","to":"/p/b.ts"}')).toEqual([
      { path: '/p/b.ts', kind: 'moved' },
    ]);
  });

  it('битые аргументы — пустой ряд, а не исключение', () => {
    // Лента чата не должна падать из-за того, что модель не собрала JSON.
    expect(touchedFiles('apply_edit', 'не json')).toEqual([]);
    expect(touchedFiles('create_file', '{"path":42}')).toEqual([]);
    expect(touchedFiles('apply_edit', '{"edits":[]}')).toEqual([]);
  });

  it('инструмент без файлов файлов не приносит', () => {
    expect(touchedFiles('read_file', '{"path":"/p/a.ts"}')).toEqual([]);
    expect(touchedFiles('run_terminal', '{"command":"ls"}')).toEqual([]);
  });

  it('аргумент без пути игнорируется, остальные остаются', () => {
    const args = JSON.stringify({ edits: [{ path: '/p/a.ts' }, {}, { path: '' }] });

    expect(touchedFiles('apply_edit', args)).toEqual([{ path: '/p/a.ts', kind: 'edited' }]);
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
