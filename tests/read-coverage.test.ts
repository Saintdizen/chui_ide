import { describe, expect, it } from 'vitest';
import {
  confirmFile,
  coveredRequest,
  forgetChangedFiles,
  isCovered,
  MAX_COVERAGE_FILES,
  needsConfirm,
  readStamp,
  rememberRead,
  restoreReads,
  snapshotReads,
  touchedPaths,
  uncoverFiles,
  uncoveredRequest,
  type ReadRange,
} from '../src/shared/read-coverage';

/**
 * Учёт уже прочитанных диапазонов в агентном цикле.
 *
 * Агент не должен читать одно и то же место дважды: текст уже есть выше в ветке.
 * Проверяем границы — что именно считается покрытым и в каких случаях повтор
 * всё же разрешён (`force`, отсутствие диапазона, незакрытая верхняя граница).
 */

describe('частичное покрытие пачки (`read { paths }`)', () => {
  it('сужает начало до самого раннего непрочитанного хвоста', () => {
    const reads = new Map<string, ReadRange[]>([
      ['a.ts', [{ from: 1, to: 120 }]],
      ['b.ts', [{ from: 1, to: 60 }]],
    ]);
    const args = JSON.stringify({ paths: ['a.ts', 'b.ts', 'c.ts'], startLine: 1, endLine: 400 });
    const narrowed = uncoverFiles(args, reads);
    expect(narrowed?.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(narrowed?.args.startLine).toBe(61);
    expect(narrowed?.args.endLine).toBe(400);
  });

  it('не сужает, если прочитан самый запрос, а не его начало', () => {
    // Порог считается от начала запроса (`startLine`), а не от хвоста: `390–400` —
    // нет смысла резать, текст всё равно не перекрыт.
    const reads = new Map<string, ReadRange[]>([['a.ts', [{ from: 400, to: 500 }]]]);
    const args = JSON.stringify({ paths: ['a.ts'], startLine: 1, endLine: 400 });
    expect(uncoverFiles(args, reads)).toBeUndefined();
  });

  it('не сужает, когда прочитано почти всё без остатка', () => {
    const reads = new Map<string, ReadRange[]>([['a.ts', [{ from: 1, to: 10 }]]]);
    const args = JSON.stringify({ paths: ['a.ts'], startLine: 1, endLine: 400 });
    expect(uncoverFiles(args, reads)).toBeUndefined();
  });

  it('сомнительный кусок не сужает: версия могла разойтись', () => {
    const reads = new Map<string, ReadRange[]>([['a.ts', [{ from: 1, to: 300, suspect: true }]]]);
    const args = JSON.stringify({ paths: ['a.ts'], startLine: 1, endLine: 400 });
    expect(uncoverFiles(args, reads)).toBeUndefined();
  });

  it('не та форма — `undefined`', () => {
    const reads = new Map<string, ReadRange[]>();
    expect(uncoverFiles(JSON.stringify({ path: 'a.ts' }), reads)).toBeUndefined();
    expect(uncoverFiles(JSON.stringify({ paths: [] }), reads)).toBeUndefined();
  });
});

describe('частичное покрытие после непрозрачного изменения', () => {
  it('не скрывает сомнительное начало до сверки версии', () => {
    const reads = new Map<string, ReadRange[]>([['a.ts', [{ from: 1, to: 120, stamp: 'v1', suspect: true }]]]);
    const args = JSON.stringify({ path: 'a.ts', startLine: 1, endLine: 250 });
    expect(uncoveredRequest('read', args, reads)).toBeUndefined();
    expect(confirmFile(reads, 'a.ts', 'v1')).toBe(true);
    expect(uncoveredRequest('read', args, reads)?.from).toBe(121);
    reads.get('a.ts')![0]!.suspect = true;
    expect(confirmFile(reads, 'a.ts', 'v2')).toBe(false);
    expect(uncoveredRequest('read', args, reads)).toBeUndefined();
  });
});

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
    expect(coveredRequest('read', '{не json', reads)).toBeUndefined();
  });

  it('без endLine верхняя граница неизвестна — повтор разрешён', () => {
    expect(coveredRequest('read', '{"path":"/proj/a.ts","startLine":1}', reads)).toBeUndefined();
  });

  it('endLine не целое — не считаем диапазоном', () => {
    expect(coveredRequest('read', '{"path":"/proj/a.ts","endLine":5.5}', reads)).toBeUndefined();
  });

  it('force явно просит перечитать', () => {
    expect(coveredRequest('read', '{"path":"/proj/a.ts","endLine":5,"force":true}', reads)).toBeUndefined();
  });

  it('диапазон уже прочитан — возвращаем его', () => {
    const hit = coveredRequest('read', '{"path":"/proj/a.ts","startLine":10,"endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 10, to: 20 });
  });

  it('без startLine начало считается с первой строки', () => {
    const hit = coveredRequest('read', '{"path":"/proj/a.ts","endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 1, to: 20 });
  });

  it('диапазон вне прочитанного — не покрыт', () => {
    expect(coveredRequest('read', '{"path":"/proj/a.ts","startLine":1,"endLine":200}', reads)).toBeUndefined();
  });

  it('неизвестный файл — не покрыт', () => {
    expect(coveredRequest('read', '{"path":"/proj/b.ts","startLine":1,"endLine":5}', reads)).toBeUndefined();
  });

  it('перевёрнутый диапазон не покрыт: отказ объяснит инструмент, а не «уже прочитано»', () => {
    expect(coveredRequest('read', '{"path":"/proj/a.ts","startLine":50,"endLine":10}', reads)).toBeUndefined();
  });

  it('границы, пришедшие строками, читаются так же, как числа', () => {
    // Модель шлёт «10»/«20» — диапазон от этого не перестаёт быть прочитанным.
    const hit = coveredRequest('read', '{"path":"/proj/a.ts","startLine":"10","endLine":"20"}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 10, to: 20 });
  });

  it('force строкой «true» тоже просит перечитать', () => {
    // Иначе флаг терялся бы, и вместо текста модель получила бы «уже прочитано».
    expect(coveredRequest('read', '{"path":"/proj/a.ts","endLine":5,"force":"true"}', reads)).toBeUndefined();
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
      edits: [
        {
          path,
          edits: [
            {
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 2,
              newText: 'x',
            },
          ],
        },
      ],
    });

  it('путь правки берётся из аргументов edit', () => {
    expect([...(touchedPaths('edit', edit('/proj/a.ts')) ?? [])]).toEqual(['/proj/a.ts']);
  });

  it('одиночный файл без обёртки в массив — тоже путь', () => {
    const args = JSON.stringify({
      path: '/proj/b.ts',
      edits: [
        {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 2,
          newText: 'x',
        },
      ],
    });
    expect([...(touchedPaths('edit', args) ?? [])]).toEqual(['/proj/b.ts']);
  });

  it('пути из патчей по якорю', () => {
    const args = JSON.stringify({
      patches: [{ path: '/proj/c.ts', patches: [{ oldText: 'a', newText: 'b' }] }],
    });
    expect([...(touchedPaths('edit', args) ?? [])]).toEqual(['/proj/c.ts']);
  });

  it('создание, удаление и перенос', () => {
    expect([
      ...(touchedPaths('file', JSON.stringify({ action: 'create', path: '/proj/n.ts', contents: '' })) ?? []),
    ]).toEqual(['/proj/n.ts']);
    expect([...(touchedPaths('file', JSON.stringify({ action: 'delete', path: '/proj/d.ts' })) ?? [])]).toEqual([
      '/proj/d.ts',
    ]);
    const moved =
      touchedPaths(
        'file',
        JSON.stringify({
          action: 'move',
          from: '/proj/old.ts',
          to: '/proj/new.ts',
        }),
      ) ?? new Set();
    expect([...moved].sort()).toEqual(['/proj/new.ts', '/proj/old.ts']);
  });

  it('пути из результата тоже считаются (создание и перенос)', () => {
    const touched =
      touchedPaths('file', '{"action":"move"}', [{ path: '/proj/new.ts', from: '/proj/old.ts' }]) ?? new Set();
    expect([...touched].sort()).toEqual(['/proj/new.ts', '/proj/old.ts']);
  });

  it('разделители пути не мешают совпадению', () => {
    const args = JSON.stringify({
      action: 'create',
      path: 'C:\\proj\\a.ts',
      contents: '',
    });
    expect([...(touchedPaths('file', args) ?? [])]).toEqual(['C:/proj/a.ts']);
  });

  it('команда и массовая замена: задетое назвать нельзя — null', () => {
    expect(touchedPaths('terminal', JSON.stringify({ action: 'run', command: 'rm -rf build' }))).toBeNull();
    expect(touchedPaths('replace_in_files', JSON.stringify({ query: 'a', replacement: 'b' }))).toBeNull();
    expect(touchedPaths('edit', '{битый json')).toBeNull();
  });
});

describe('forgetChangedFiles', () => {
  /** Кеши как в агентном цикле: что исполнялось и какие диапазоны прочитаны. */
  const caches = () => ({
    executed: new Map<string, { ok: boolean }>([
      ['read:{"path":"/proj/a.ts"}', { ok: true }],
      ['read:{"path":"/proj/b.ts","endLine":9}', { ok: true }],
    ]),
    coveredReads: new Map<string, ReadRange[]>([
      ['/proj/a.ts', [{ from: 1, to: 100 }]],
      ['/proj/b.ts', [{ from: 1, to: 9 }]],
    ]),
  });

  it('правка одного файла не стирает память о других', () => {
    const state = caches();
    forgetChangedFiles(state, 'file', JSON.stringify({ action: 'create', path: '/proj/a.ts', contents: 'x' }));
    // Забыт только a.ts — и в обоих кешах.
    expect(state.coveredReads.has('/proj/a.ts')).toBe(false);
    expect(state.executed.has('read:{"path":"/proj/a.ts"}')).toBe(false);
    // b.ts не трогали: модель не перечитывает его заново.
    expect(state.coveredReads.has('/proj/b.ts')).toBe(true);
    expect(state.executed.has('read:{"path":"/proj/b.ts","endLine":9}')).toBe(true);
  });

  it('команда в терминале не стирает память, а помечает её сомнительной', () => {
    const state = caches();
    forgetChangedFiles(state, 'terminal', JSON.stringify({ action: 'run', command: 'npm install' }));
    // Точный кеш исполненного сбрасывается: текст в нём мог разойтись с диском.…
    // Слишком дорого было выбрасывать всё: один `terminal` заставлял модель
    // перечитывать каждый файл ветки. Поэтому память остаётся, но с пометкой:
    // версию сверим с диском перед следующим повтором (`confirmFile`).
    expect(state.executed.size).toBe(0);
    expect(state.coveredReads.size).toBe(2);
    for (const ranges of state.coveredReads.values()) {
      expect(ranges.every((range) => range.suspect === true)).toBe(true);
    }
  });

  it('обратный слэш в пути не мешает забыть нужный файл', () => {
    // На Windows main отдаёт пути через `\\`. Сравниваем по единому виду, иначе
    // правка не забыла бы ничего и модель читала бы изменённый файл из кеша.
    const state = {
      executed: new Map<string, { ok: boolean }>([['read:{"path":"C:/proj/x.ts"}', { ok: true }]]),
      coveredReads: new Map([['C:/proj/x.ts', [{ from: 1, to: 5 }]]]),
    };
    forgetChangedFiles(
      state,
      'file',
      JSON.stringify({
        action: 'create',
        path: 'C:\\proj\\x.ts',
        contents: 'x',
      }),
    );
    expect(state.coveredReads.size).toBe(0);
    expect(state.executed.size).toBe(0);
  });

  it('чужой путь кеш не задевает', () => {
    const state = caches();
    forgetChangedFiles(state, 'file', JSON.stringify({ action: 'create', path: '/other/c.ts', contents: 'x' }));
    expect(state.coveredReads.size).toBe(2);
    expect(state.executed.size).toBe(2);
  });
});

describe('uncoveredRequest', () => {
  const reads = new Map([['/proj/a.ts', [{ from: 1, to: 120 }]]]);

  it('хвост после прочитанного — только он и читается', () => {
    const narrowed = uncoveredRequest(
      'read',
      JSON.stringify({ path: '/proj/a.ts', startLine: 1, endLine: 250 }),
      reads,
    );
    expect(narrowed?.from).toBe(121);
    expect(narrowed?.to).toBe(250);
    expect(JSON.parse(narrowed!.arguments)).toEqual({
      path: '/proj/a.ts',
      startLine: 121,
      endLine: 250,
    });
  });

  it('куски, стоящие встык, складываются в одно покрытие', () => {
    const chained = new Map([
      [
        '/proj/a.ts',
        [
          { from: 1, to: 60 },
          { from: 40, to: 120 },
        ],
      ],
    ]);
    const narrowed = uncoveredRequest(
      'read',
      JSON.stringify({ path: '/proj/a.ts', startLine: 1, endLine: 300 }),
      chained,
    );
    expect(narrowed?.from).toBe(121);
  });

  it('выгадывать меньше двадцати строк — не стоит объяснения', () => {
    const near = new Map([['/proj/a.ts', [{ from: 1, to: 10 }]]]);
    expect(uncoveredRequest('read', JSON.stringify({ path: '/proj/a.ts', endLine: 20 }), near)).toBeUndefined();
  });

  it('просили уже прочитанное или чужое — не наш случай', () => {
    expect(uncoveredRequest('read', JSON.stringify({ path: '/proj/a.ts', endLine: 100 }), reads)).toBeUndefined();
    expect(uncoveredRequest('search', JSON.stringify({ path: '/proj/a.ts', endLine: 300 }), reads)).toBeUndefined();
    expect(uncoveredRequest('read', JSON.stringify({ path: '/proj/b.ts', endLine: 300 }), reads)).toBeUndefined();
  });

  it('файл целиком после прочитанного начала — тоже хвост', () => {
    // Прочитали 1–120, потом просят весь файл: начало уже в ветке, и платить
    // за него второй раз незачем. `to: 0` — конец файла, `endLine` ведь нет.
    const narrowed = uncoveredRequest('read', JSON.stringify({ path: '/proj/a.ts' }), reads);
    expect(narrowed?.from).toBe(121);
    expect(narrowed?.to).toBe(0);
    expect(JSON.parse(narrowed!.arguments)).toEqual({ path: '/proj/a.ts', startLine: 121 });
  });

  it('файл целиком: короткое покрытие и force переписывания не стоят', () => {
    const near = new Map([['/proj/a.ts', [{ from: 1, to: 10 }]]]);
    expect(uncoveredRequest('read', JSON.stringify({ path: '/proj/a.ts' }), near)).toBeUndefined();
    // `force` — явная просьба перечитать: текст мог выпасть из контекста.
    expect(uncoveredRequest('read', JSON.stringify({ path: '/proj/a.ts', force: true }), reads)).toBeUndefined();
  });
});

describe('версии файла вместо тотальной чистки', () => {
  it('readStamp отличает версии', () => {
    expect(readStamp({ mtimeMs: 1, size: 2 })).toBe('1:2');
    expect(readStamp({ mtimeMs: 1, size: 2 })).not.toBe(readStamp({ mtimeMs: 1, size: 3 }));
  });

  it('непрозрачный вызов только помечает покрытие сомнительным', () => {
    const state = {
      executed: new Map(),
      coveredReads: new Map([['/p/a.ts', [{ from: 1, to: 9, stamp: '1:2' }]]]),
    };
    forgetChangedFiles(state, 'terminal', JSON.stringify({ action: 'run', command: 'ls' }));
    expect(state.coveredReads.size).toBe(1);
    expect(needsConfirm(state.coveredReads, '/p/a.ts')).toBe(true);
  });

  it('версия совпала — покрытие снова надёжно', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 9, stamp: '1:2', suspect: true }]]]);
    expect(confirmFile(reads, '/p/a.ts', '1:2')).toBe(true);
    expect(needsConfirm(reads, '/p/a.ts')).toBe(false);
  });

  it('файл изменился — покрытие забыто', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 9, stamp: '1:2', suspect: true }]]]);
    expect(confirmFile(reads, '/p/a.ts', '1:5')).toBe(false);
    expect(reads.size).toBe(0);
  });

  it('нечем сверить — тоже забываем', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 9, stamp: '1:2', suspect: true }]]]);
    expect(confirmFile(reads, '/p/a.ts', undefined)).toBe(false);
    expect(reads.size).toBe(0);
  });

  it('перечитывание снимает старые куски другой версии', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 9, stamp: '1:2' }]]]);
    rememberRead(reads, { path: '/p/a.ts', from: 10, to: 20, stamp: '1:5' });
    expect(reads.get('/p/a.ts')).toEqual([{ from: 10, to: 20, stamp: '1:5', eof: undefined }]);
  });
});

describe('coveredRequest без endLine', () => {
  it('«с этой строки до конца» покрыто, если чтение дошло до конца', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 120, stamp: '1:2', eof: true }]]]);
    expect(coveredRequest('read', JSON.stringify({ path: '/p/a.ts', startLine: 1 }), reads)).toEqual({
      path: '/p/a.ts',
      from: 1,
      to: 120,
    });
  });

  it('конец файла неизвестен — читаем заново', () => {
    const reads = new Map([['/p/a.ts', [{ from: 1, to: 120, stamp: '1:2' }]]]);
    expect(coveredRequest('read', JSON.stringify({ path: '/p/a.ts' }), reads)).toBeUndefined();
  });
});

describe('память чтений переживает границу хода', () => {
  it('снимок и восстановление сохраняют диапазоны, штампы и флаги', () => {
    const reads = new Map([
      ['/p/a.ts', [{ from: 1, to: 40, stamp: '10:200', eof: true }]],
      ['/p/b.ts', [{ from: 5, to: 9, stamp: '11:100', suspect: true }]],
    ]);
    const restored = restoreReads(snapshotReads(reads));
    expect(restored.get('/p/a.ts')).toEqual([{ from: 1, to: 40, stamp: '10:200', eof: true }]);
    expect(restored.get('/p/b.ts')).toEqual([{ from: 5, to: 9, stamp: '11:100', suspect: true }]);
  });

  it('прочитанное в прошлом ходе не читается заново в новом', () => {
    // Ход 1: прочитали 1–100 файла и запомнили.
    const first = new Map<string, ReadRange[]>();
    rememberRead(first, { path: '/p/a.ts', from: 1, to: 100, stamp: '10:200' });
    // Конец хода: карта уехала в беседу снимком и вернулась в следующем ходе.
    const second = restoreReads(snapshotReads(first));
    const covered = coveredRequest('read', JSON.stringify({ path: '/p/a.ts', startLine: 10, endLine: 20 }), second);
    expect(covered).toEqual({ path: '/p/a.ts', from: 10, to: 20 });
  });

  it('пустой снимок не пишется, а мусор из файла не ломает чтение', () => {
    expect(snapshotReads(new Map([['/p/a.ts', []]]))).toEqual({ files: [] });
    const broken = { files: [null, { path: 5 }, { path: '/p/a.ts', ranges: [{ from: 'x' }] }] } as never;
    expect(restoreReads(broken).size).toBe(0);
  });

  it('файлов больше потолка — давние выбрасываются, свежие остаются', () => {
    const many = new Map<string, ReadRange[]>();
    for (let index = 0; index < MAX_COVERAGE_FILES + 10; index += 1) {
      many.set(`/p/f${index}.ts`, [{ from: 1, to: 2, stamp: '1:1' }]);
    }
    const restored = restoreReads(snapshotReads(many));
    expect(restored.size).toBe(MAX_COVERAGE_FILES);
    expect(restored.has('/p/f0.ts')).toBe(false);
    expect(restored.has(`/p/f${MAX_COVERAGE_FILES + 9}.ts`)).toBe(true);
  });
});
