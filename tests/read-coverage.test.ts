import { describe, expect, it } from 'vitest';
import { coveredRequest, forgetChangedFiles, isCovered, rememberRead, touchedPaths } from '../src/shared/read-coverage';

/**
 * Учёт уже прочитанных диапазонов в агентном цикле.
 *
 * Агент не должен читать одно и то же место дважды: текст уже есть выше в ветке.
 * Проверяем границы — что именно считается покрытым и в каких случаях повтор
 * всё же разрешён (`force`, отсутствие диапазона, незакрытая верхняя граница).
 */

describe('isCovered', () => {
  it('диапазон внутри прочитанного — покрыт', () => {
    expect(isCovered([{ from: 1, to: 10 }], 3, 5)).toBe(true);
    expect(isCovered([{ from: 1, to: 10 }], 1, 10)).toBe(true);
  });

  it('запрос шире прочитанного — не покрыт', () => {
    expect(isCovered([{ from: 2, to: 10 }], 1, 5)).toBe(false);
    expect(isCovered([{ from: 1, to: 9 }], 5, 10)).toBe(false);
  });

  it('диапазоны не складываются: нужен один, покрывающий запрос целиком', () => {
    expect(
      isCovered(
        [
          { from: 1, to: 3 },
          { from: 5, to: 8 },
        ],
        2,
        7,
      ),
    ).toBe(false);
    expect(
      isCovered(
        [
          { from: 1, to: 5 },
          { from: 5, to: 9 },
        ],
        3,
        9,
      ),
    ).toBe(false);
    expect(isCovered([{ from: 1, to: 9 }], 3, 9)).toBe(true);
  });
});

describe('coveredRequest', () => {
  const reads = new Map([['/proj/a.ts', [{ from: 1, to: 100 }]]]);

  it('чужой инструмент — не наш случай', () => {
    expect(coveredRequest('search', '{"path":"/proj/a.ts","endLine":5}', reads)).toBeUndefined();
  });

  it('битый JSON — не разбираем', () => {
    expect(coveredRequest('read_file', '{не json', reads)).toBeUndefined();
  });

  it('без endLine верхняя граница неизвестна — повтор разрешён', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":1}', reads)).toBeUndefined();
  });

  it('endLine не целое — не считаем диапазоном', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":5.5}', reads)).toBeUndefined();
  });

  it('force явно просит перечитать', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":5,"force":true}', reads)).toBeUndefined();
  });

  it('диапазон уже прочитан — возвращаем его', () => {
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":10,"endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 10, to: 20 });
  });

  it('без startLine начало считается с первой строки', () => {
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 1, to: 20 });
  });

  it('диапазон вне прочитанного — не покрыт', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":1,"endLine":200}', reads)).toBeUndefined();
  });

  it('неизвестный файл — не покрыт', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/b.ts","startLine":1,"endLine":5}', reads)).toBeUndefined();
  });

  it('перевёрнутый диапазон не покрыт: отказ объяснит инструмент, а не «уже прочитано»', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":50,"endLine":10}', reads)).toBeUndefined();
  });

  it('границы, пришедшие строками, читаются так же, как числа', () => {
    // Модель шлёт «10»/«20» — диапазон от этого не перестаёт быть прочитанным.
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":"10","endLine":"20"}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 10, to: 20 });
  });

  it('force строкой «true» тоже просит перечитать', () => {
    // Иначе флаг терялся бы, и вместо текста модель получила бы «уже прочитано».
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":5,"force":"true"}', reads)).toBeUndefined();
  });
});

describe('rememberRead', () => {
  it('копит диапазоны по одному файлу', () => {
    const reads = new Map<string, Array<{ from: number; to: number }>>();
    rememberRead(reads, { path: '/a.ts', from: 1, to: 5 });
    rememberRead(reads, { path: '/a.ts', from: 10, to: 20 });
    rememberRead(reads, { path: '/b.ts', from: 1, to: 3 });

    expect(reads.get('/a.ts')).toEqual([
      { from: 1, to: 5 },
      { from: 10, to: 20 },
    ]);
    expect(reads.get('/b.ts')).toEqual([{ from: 1, to: 3 }]);
  });
});

describe('touchedPaths', () => {
  const edit = (path: string) =>
    JSON.stringify({
      edits: [{ path, edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'x' }] }],
    });

  it('путь правки берётся из аргументов apply_edit', () => {
    expect([...(touchedPaths('apply_edit', edit('/proj/a.ts')) ?? [])]).toEqual(['/proj/a.ts']);
  });

  it('одиночный файл без обёртки в массив — тоже путь', () => {
    const args = JSON.stringify({
      path: '/proj/b.ts',
      edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'x' }],
    });
    expect([...(touchedPaths('apply_edit', args) ?? [])]).toEqual(['/proj/b.ts']);
  });

  it('пути из патчей по якорю', () => {
    const args = JSON.stringify({ patches: [{ path: '/proj/c.ts', patches: [{ oldText: 'a', newText: 'b' }] }] });
    expect([...(touchedPaths('apply_patch', args) ?? [])]).toEqual(['/proj/c.ts']);
  });

  it('создание, удаление и перенос', () => {
    expect([...(touchedPaths('create_file', JSON.stringify({ path: '/proj/n.ts', contents: '' })) ?? [])]).toEqual([
      '/proj/n.ts',
    ]);
    expect([...(touchedPaths('delete_file', JSON.stringify({ path: '/proj/d.ts' })) ?? [])]).toEqual(['/proj/d.ts']);
    const moved = touchedPaths('move_file', JSON.stringify({ from: '/proj/old.ts', to: '/proj/new.ts' })) ?? new Set();
    expect([...moved].sort()).toEqual(['/proj/new.ts', '/proj/old.ts']);
  });

  it('пути из результата тоже считаются (создание и перенос)', () => {
    const touched = touchedPaths('move_file', '{}', [{ path: '/proj/new.ts', from: '/proj/old.ts' }]) ?? new Set();
    expect([...touched].sort()).toEqual(['/proj/new.ts', '/proj/old.ts']);
  });

  it('разделители пути не мешают совпадению', () => {
    const args = JSON.stringify({ path: 'C:\\proj\\a.ts', contents: '' });
    expect([...(touchedPaths('create_file', args) ?? [])]).toEqual(['C:/proj/a.ts']);
  });

  it('команда и массовая замена: задетое назвать нельзя — null', () => {
    expect(touchedPaths('run_terminal', JSON.stringify({ command: 'rm -rf build' }))).toBeNull();
    expect(touchedPaths('replace_in_files', JSON.stringify({ query: 'a', replacement: 'b' }))).toBeNull();
    expect(touchedPaths('apply_edit', '{битый json')).toBeNull();
  });
});

describe('forgetChangedFiles', () => {
  /** Кеши как в агентном цикле: что исполнялось и какие диапазоны прочитаны. */
  const caches = () => ({
    executed: new Map<string, { ok: boolean }>([
      ['read_file:{"path":"/proj/a.ts"}', { ok: true }],
      ['read_file:{"path":"/proj/b.ts","endLine":9}', { ok: true }],
    ]),
    coveredReads: new Map([
      ['/proj/a.ts', [{ from: 1, to: 100 }]],
      ['/proj/b.ts', [{ from: 1, to: 9 }]],
    ]),
  });

  it('правка одного файла не стирает память о других', () => {
    const state = caches();
    forgetChangedFiles(state, 'create_file', JSON.stringify({ path: '/proj/a.ts', contents: 'x' }));
    // Забыт только a.ts — и в обоих кешах.
    expect(state.coveredReads.has('/proj/a.ts')).toBe(false);
    expect(state.executed.has('read_file:{"path":"/proj/a.ts"}')).toBe(false);
    // b.ts не трогали: модель не перечитывает его заново.
    expect(state.coveredReads.has('/proj/b.ts')).toBe(true);
    expect(state.executed.has('read_file:{"path":"/proj/b.ts","endLine":9}')).toBe(true);
  });

  it('команда в терминале по-прежнему забывает всё', () => {
    const state = caches();
    forgetChangedFiles(state, 'run_terminal', JSON.stringify({ command: 'npm install' }));
    expect(state.executed.size).toBe(0);
    expect(state.coveredReads.size).toBe(0);
  });

  it('обратный слэш в пути не мешает забыть нужный файл', () => {
    // На Windows main отдаёт пути через `\\`. Сравниваем по единому виду, иначе
    // правка не забыла бы ничего и модель читала бы изменённый файл из кеша.
    const state = {
      executed: new Map<string, { ok: boolean }>([['read_file:{"path":"C:/proj/x.ts"}', { ok: true }]]),
      coveredReads: new Map([['C:/proj/x.ts', [{ from: 1, to: 5 }]]]),
    };
    forgetChangedFiles(state, 'create_file', JSON.stringify({ path: 'C:\\proj\\x.ts', contents: 'x' }));
    expect(state.coveredReads.size).toBe(0);
    expect(state.executed.size).toBe(0);
  });

  it('чужой путь кеш не задевает', () => {
    const state = caches();
    forgetChangedFiles(state, 'create_file', JSON.stringify({ path: '/other/c.ts', contents: 'x' }));
    expect(state.coveredReads.size).toBe(2);
    expect(state.executed.size).toBe(2);
  });
});
