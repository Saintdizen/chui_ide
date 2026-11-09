import { describe, expect, it } from 'vitest';
import {
  buildCountsRecord,
  callFailureReason,
  callFlags,
  refusalShape,
  formatCountsLine,
  parseCounts,
} from '../src/shared/step-counts';
import type { ChatRunLog } from '../src/shared/run-log';

function run(overrides: Partial<ChatRunLog> = {}): ChatRunLog {
  return {
    startedAt: 1_700_000_000_000,
    ms: 12_000,
    finished: 'answer',
    system: {
      provider: 'anthropic',
      model: 'claude',
      mode: 'agent',
      permission: 'full',
      tools: 17,
    },
    trace: { steps: 2, toolCalls: 3, usage: { promptTokens: 100, cachedTokens: 96, completionTokens: 40 } },
    steps: [
      {
        index: 1,
        ms: 5_000,
        usage: { promptTokens: 50, cachedTokens: 48, completionTokens: 20 },
        outputTokens: 300,
        calls: [
          { id: 'a', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: 'x'.repeat(88) },
          {
            id: 'b',
            name: 'terminal',
            args: '{"command":"cd /home/x && grep foo src/a.ts"}',
            ok: false,
            summary: 'код выхода 1',
            note: 'отказ',
            ms: 120,
          },
        ],
      },
      {
        index: 2,
        ms: 7_000,
        outputTokens: 120,
        hiddenCalls: 3,
        calls: [{ id: 'c', name: 'edit', args: '{"action":"write"}', ok: true, summary: 'ok', detail: 'done' }],
      },
    ],
    ...overrides,
  };
}

describe('счётчик шагов', () => {
  it('не несёт текстов переписки: только имена, числа и пометки', () => {
    const record = buildCountsRecord(run(), { conversation: 'uid' });
    const text = formatCountsLine(record);
    // Ни инструкций, ни контекста проекта, ни ответа шага — их в записи нет вовсе.
    expect(text).not.toContain('xxxx');
    expect(text).not.toContain('done');
    expect(record.conversation).toBe('uid');
    expect(record.steps.map((step) => step.i)).toEqual([1, 2]);
    expect(record.steps[1]!.hiddenCalls).toBe(3);
  });

  it('кладёт сводку экономии в запись — без неё регресс не виден тому, кто считает', () => {
    const bare = buildCountsRecord(run());
    expect(bare.savings).toBeUndefined();

    const record = buildCountsRecord(run(), {
      savings: { chars: 4_000, tokens: 1_000, parts: [{ name: 'search-cache', chars: 4_000, times: 2 }] },
    });
    expect(record.savings).toEqual({ chars: 4_000, tokens: 1_000, parts: [{ name: 'search-cache', chars: 4_000, times: 2 }] });
    // Запись остаётся без содержания: только имя механизма и числа.
    expect(formatCountsLine(record)).not.toContain('xxxx');
  });

  it('целые чтения считаются за прогон: подсказка доходит, даже если между ними другие вызовы', () => {
    // Замер 09.11: целые чтения шли 65 раз в 47 прогонах и почти никогда подряд.
    // Счётчик «подряд» обнулялся на первом жe выводе инструмента — подсказка молчала.
    const whole = '{"path":"src/a.ts"}';
    const range = '{"path":"src/a.ts","startLine":1,"endLine":5}';
    const flags = [whole, range, whole, whole, range].map((args) => callFlags('read', args));
    const ever = flags.filter((f) => f.includes('whole-read')).length;
    expect(ever).toBe(3);
    // Подряд — только пара на концах, после диапазона счёт сбрасывается.
    let streak = 0;
    const streaks: number[] = [];
    for (const f of flags) {
      streak = f.includes('whole-read') ? streak + 1 : 0;
      streaks.push(streak);
    }
    expect(streaks).toEqual([1, 0, 1, 2, 0]);
  });

  it('считает цену вызова в символах, а шага — в токенах провайдера', () => {
    const record = buildCountsRecord(run());
    const [first, second] = record.steps;
    const [read, terminal] = first!.calls;
    expect(read!.chars).toBe(88);
    expect(terminal!.ok).toBe(false);
    expect(terminal!.ms).toBe(120);
    expect(second!.out).toBe(120);
    expect(record.trace).toEqual({
      steps: 2,
      toolCalls: 3,
      prompt: 100,
      cached: 96,
      output: 40,
      cacheCreation: 0,
    });
  });

  it('подписывает форму вызова: cd, шелл вместо read, целое чтение, пачка', () => {
    expect(callFlags('terminal', '{"command":"cd /abs && ls"}')).toEqual(['cd']);
    expect(callFlags('terminal', '{"command":"grep -n foo src/a.ts"}')).toEqual(['shell-read']);
    expect(callFlags('read', '{"path":"src/a.ts"}')).toEqual(['whole-read']);
    expect(callFlags('read', '{"path":"src/a.ts","startLine":10,"endLine":20}')).toEqual([]);
    // Замер 09.11: read целиком — 59 000 тк на 65 ответов. Флаг есть с самого
    // начала, но им никто не пользовался: теперь на нём подсказка про диапазон.
    expect(callFlags('read', '{"path":"a.ts"}')).toContain('whole-read');
    expect(callFlags('read', '{"paths":["a","b"]}')).toEqual(['paths']);
    // Испорченные аргументы — тоже данные: пометок у них нет, но и падения тоже.
    expect(callFlags('read', '{"path":')).toEqual([]);
  });

  it('переживает обрыв записи в журнале', () => {
    const line = formatCountsLine(buildCountsRecord(run()));
    const records = parseCounts(`${line}\n{"version":2,"steps":[\n`);
    expect(records).toHaveLength(1);
    expect(parseCounts('')).toEqual([]);
  });

  it('повтор по прогону ловится даже в разных шагах и получает тот же хэш', () => {
    // Раньше поток видимости был один на шаг, и один и тот же `read` на 5-м и
    // 40-м шаге считался уникальным. Повторы прогона — главная догадка п.0.
    const log = run({
      steps: [
        {
          index: 1,
          ms: 1,
          outputTokens: 10,
          calls: [{ id: 'a', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: 'x'.repeat(88) }],
        },
        {
          index: 2,
          ms: 1,
          outputTokens: 10,
          calls: [
            { id: 'b', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: 'x'.repeat(88) },
            { id: 'c', name: 'read', args: '{"path":"src/b.ts"}', ok: true, summary: 'x'.repeat(88) },
          ],
        },
      ],
    });
    const steps = buildCountsRecord(log).steps;
    const first = steps[0]!.calls[0]!;
    const again = steps[1]!.calls[0]!;
    const fresh = steps[1]!.calls[1]!;
    expect(first.flags ?? []).not.toContain('repeat-run');
    expect(again.flags).toContain('repeat-run');
    expect(fresh.flags ?? []).not.toContain('repeat-run');
    // Хэш — то, по чему повтор и виден; без него замер не воспроизвести.
    expect(again.h).toBe(first.h);
    expect(fresh.h).not.toBe(first.h);
    expect(first.h).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('старые записи v1 и v2 в отчёт не едут, а новая строка читается', () => {
    // v3 добавила флаг `repeat-run` и хэш аргументов: считая по старым записям,
    // отчёт показал бы нуль повторов там, где их просто не записывали.
    const line = formatCountsLine(buildCountsRecord(run()));
    expect(parseCounts(line)).toHaveLength(1);
    expect(parseCounts(line.replace(/"version":3/u, '"version":2'))).toEqual([]);
    expect(parseCounts(line.replace(/"version":3/u, '"version":1'))).toEqual([]);
    // Новое поле — не повод терять запись: вызовы на месте, chars на месте.
    expect(parseCounts(line)[0]!.steps[0]!.calls[0]!).toHaveProperty('chars');
  });

  it('считает отказом вызов с ok: true, но failed: true', () => {
    // Разделение 30.10: `failed` — работа сделана, итог отрицательный (упавший тест,
    // код выхода). Раньше такие вызовы уходили в отчёт как успешные, и число отказов
    // на бумаге падало ровно на столько, на сколько выросло реальное.
    const log = run();
    log.steps[0]!.calls = [
      {
        id: 'a',
        name: 'run_tests',
        args: '{}',
        ok: true,
        failed: true,
        summary: 'Провалено 2 из 10',
        detail: 'код выхода 1',
      },
      { id: 'b', name: 'read', args: '{}', ok: true, summary: 'x' },
    ];
    const calls = buildCountsRecord(log).steps[0]!.calls;
    // Код `exit`: команда отработала и ответила «нет» — это ответ, а не
    // поломка, и он в записи есть.
    expect(calls[0]!.reason).toBe('exit');
    expect(calls[0]!.unknown).toBeTruthy();
    expect(calls[1]).toMatchObject({ ok: true });
    expect(calls[1]!.reason).toBeUndefined();
  });

  it('кодирует причину отказа без текста ошибки', () => {
    const log = run();
    log.steps[0]!.calls = [
      { id: 'a', name: 'mind', args: '{"action":""}', ok: false, summary: 'Неизвестное действие: ' },
      { id: 'b', name: 'edit', args: '{}', ok: false, summary: 'Не хватает аргумента', detail: 'Передай oldText' },
      { id: 'c', name: 'terminal', args: '{}', ok: false, summary: 'код выхода 1' },
      { id: 'd', name: 'read', args: '{}', ok: false, summary: 'Файл не найден: a.ts' },
      // Замер сжатия: аргумент подменился пометкой и до инструмента не дошёл.
      // 24 отказа `edit` из 266 сидели в «other» именно этим текстом (30.10).
      {
        id: 'd2',
        name: 'edit',
        args: '{}',
        ok: false,
        summary: 'Аргумент edits пришёл пометкой сжатия вместо текста — в файл он не попал',
      },
      // Якорь — до `not-found`: отказ правки тоже говорит «не найден», но чинится
      // он другим якорем, а не перечитыванием пути.
      {
        id: 'e',
        name: 'edit',
        args: '{}',
        ok: false,
        summary: 'ошибка правки',
        detail: 'текст «return 1» в файле не найден.',
      },
      { id: 'f', name: 'edit', args: '{}', ok: false, summary: 'Правки не применены', detail: 'правка не применена' },
      {
        id: 'g',
        name: 'ask',
        args: '{}',
        ok: false,
        summary: 'Ответа нет',
        detail: 'Человек не ответил: вопрос отклонили',
      },
      { id: 'h', name: 'edit', args: '{}', ok: false, summary: 'Не задан аргумент «contents»' },
      // Наши собственные формы отказов — со строчной буквы. До 29.10 они оседали
      // в «other», и причина 76% отказов `edit` была неведома.
      { id: 'i', name: 'edit', args: '{}', ok: false, summary: 'edits[0].edits[0].newText: нужна строка' },
      { id: 'j', name: 'edit', args: '{}', ok: false, summary: 'edits[0]: не задан path.' },
      { id: 'k', name: 'edit', args: '{}', ok: false, summary: 'edits[0].edits: нужен непустой массив правок.' },
      // Формы без подлежащего мужского рода: «недоступен» ловил только их,
      // а отказы инструментов пишутся «недоступна/недоступны».
      { id: 'l', name: 'mind', args: '{"action":"notes"}', ok: false, summary: 'Память недоступна' },
      { id: 'm', name: 'terminal', args: '{}', ok: false, summary: 'Задания недоступны' },
      // Мужской род: «Веб-поиск недоступен». Его не ловила НИ ОДНА форма, пока
      // регулярка держала само слово, а не корень, — оба отказа `web` из двух
      // уходили в «other» (call-census, 30.10).
      { id: 'o', name: 'web', args: '{}', ok: false, summary: 'Ошибка: Веб-поиск недоступен: Поиск ответил кодом 404' },
      // Код неизвестен, но команда провалилась — это тоже `command`, а не «other».
      { id: 'p', name: 'terminal', args: '{}', ok: false, summary: 'Ошибка: код выхода —' },
      { id: 'q', name: 'terminal', args: '{}', ok: false, summary: 'Ошибка: код выхода 1' },
      {
        id: 'n',
        name: 'checks',
        args: '{}',
        ok: false,
        summary: 'Диагностика недоступна: окно редактора не подключено',
      },
    ];
    const record = buildCountsRecord(log);
    expect(record.steps[0]!.calls.map((item) => item.reason)).toEqual([
      'action',
      'arg',
      // Провал без своего кода теперь зовётся `exit`: команда ответила «нет».
      'exit',
      'not-found',
      'arg',
      'anchor',
      'anchor',
      'rejected',
      'arg',
      'arg',
      'arg',
      'arg',
      'unavailable',
      'unavailable',
      'unavailable',
      // Две команды провалились (`p` и `q`): у обоих код `exit`.
      'exit',
      'exit',
      'unavailable',
    ]);
    expect(callFailureReason({ ok: true, summary: 'ok' })).toBe('other');
  });

  it('код `arg` сохраняет текст: в нём и жива догадка модели о длине файла', () => {
    // Замер 30.10: «файл описывают как 386 строк, читают с 590-й» — верный
    // признак, и его держит только текст. С номером строки в начале его же
    // не узнать: у всех таких отказов начало одинаковое.
    const log = run();
    log.steps[0]!.calls = [
      {
        id: 'a',
        name: 'read',
        args: '{"startLine":590}',
        ok: false,
        summary: 'src/a/agent-read.ts: начало диапазона 590 за концом файла (в файле строк: 386)',
      },
    ];
    const call = buildCountsRecord(log).steps[0]!.calls[0]!;
    expect(call.reason).toBe('arg');
    expect(call.unknown).toContain('за концом файла');
    expect(call.unknown).not.toContain('/');
  });

  it('нечитаемый отказ остаётся с формой: без путей, якорей и команд модели', () => {
    // Смысл: `other` — не тупик. Код молчит, но форма говорит, что чинить.
    expect(
      refusalShape({ ok: false, summary: 'Ошибка: Не хватает аргумента: path — открыть src/a/very-long-name.ts' }),
    ).toBe('Ошибка: Не хватает аргумента: path — открыть …');
    // Якорь и путь модели в отчёт не идут: там текст, а не наши пометки.
    const anchored = refusalShape({
      ok: false,
      summary: '',
      detail: 'якорь «oldText» не найден в /home/u/proj/x.ts, строка 12',
    });
    expect(anchored).not.toContain('/home/u/proj');
    expect(anchored).not.toContain('oldText');
    // Отказ без текста — тоже сигнал, а не пустота.
    expect(refusalShape({ ok: false, summary: '' })).toBe('(отказ без текста)');
    // Форма есть у каждого отказа: и там, где код молчит (`other`), и там, где
    // код — заглушка `command` (упавший тест тоже отказ, но ЧЕМ он упал, код не
    // говорит). Оба едут в запись формой вместо кода.
    const second = buildCountsRecord(
      run({
        steps: [
          {
            index: 1,
            ms: 1_000,
            calls: [
              { id: 'x', name: 'terminal', args: '{"command":"npm test"}', ok: false, summary: 'код выхода 1' },
              { id: 'y', name: 'web', args: '{}', ok: false, summary: 'Неизвестный поставщик «acme»' },
            ],
          },
        ],
      }),
    );
    // Упавшая команда теперь называет себя кодом `exit`: это ответ, а не
    // поломка инструмента, и в таблице отказов он стоит отдельно (47 из 94).
    // Код при этом не заглушка — форма едет вместе с ним, и отчёт видит оба.
    expect(second.steps[0]!.calls[0]!.reason).toBe('exit');
    expect(second.steps[0]!.calls[0]!.unknown).toBe('код выхода 1');
    // Код молчит — отказ всё равно назван формой, по ней и стоит новая форма.
    expect(second.steps[0]!.calls[1]!.reason).toBeUndefined();
    // Аргумент модели (имя поставщика в кавычках) в отчёт не едет — только форма.
    expect(second.steps[0]!.calls[1]!.unknown).toBe('Неизвестный поставщик …');
  });

  it('проваленный вызов без кода причины тоже пишет форму', () => {
    // Замер 30.10: 201 отказ из 326 лежали с кодом-заглушкой и без формы — то
    // есть в записи не было ни причины, ни текста, и чинить было нечего.
    const record = buildCountsRecord(
      run({
        steps: [
          {
            index: 1,
            ms: 500,
            calls: [
              {
                id: 'z',
                name: 'run_tests',
                args: '{}',
                ok: true,
                failed: true,
                summary: '1 тест упал: ждали 2, получили 3',
              },
            ],
          },
        ],
      }),
    );
    const call = record.steps[0]!.calls[0]!;
    expect(call.ok).toBe(false);
    // Провал без отдельного кода называет себя `exit`: это ответ вызова, а не
    // разбор аргументов, — а форму рядом держим, по ней и чинят.
    expect(call.reason).toBe('exit');
    expect(call.unknown).toBe('1 тест упал: ждали 2, получили 3');
  });

  // Дыры, найденные `npm run census` в живых беседах: оба текста оседали в «other».
  // Команда длиннее лимита чинится аргументом (положить в файл кусками), а путь вне
  // рабочей папки — не «не найдено» и не «неизвестно что»: это граница прав.
  // Перепись 02.11: форма отказа сама называет причину, а уходила в `other`:
  // `{patches: [{oldText, newText}]}` без пути — `arg` с индексом впреди; файл,
  // который уже есть — состояние, а не форма; битый JSON — повторить вызов.
  it('текст называет причину — код от неё, а не `other`', () => {
    const code = (summary: string) => callFailureReason({ ok: false, summary });
    expect(code('Ошибка: patches[0]: не задан path. В элементе лежат сами замены')).toBe('arg');
    expect(code('Ошибка: Не задан аргумент «contents» (содержимое нового файла)')).toBe('arg');
    expect(code('Ошибка: Уже существует: _edit-dl.cjs')).toBe('not-found');
    expect(code("Ошибка: Не удалось разобрать аргументы: Expected ',' or ']' at position 593")).toBe('arg');
  });

  it('узнаёт длинную команду и путь вне рабочей папки', () => {
    const code = (summary: string) => callFailureReason({ ok: false, summary });
    expect(code('Ошибка: Команда длиннее 4000 символов (7896): такое не проходит через терминал')).toBe('arg');
    expect(code('Ошибка: Путь вне рабочей папки')).toBe('permission');
  });

  it('размечает повторы и смысловые пересечения в одном шаге', () => {
    const log = run();
    log.steps[0]!.calls = [
      { id: 'a', name: 'search', args: '{"action":"code","query":"User"}', ok: true, summary: '1' },
      { id: 'b', name: 'lsp', args: '{"action":"definition","symbol":"User"}', ok: true, summary: '2' },
      { id: 'c', name: 'read', args: '{"path":"src/a.ts"}', ok: true, summary: '3' },
      { id: 'd', name: 'search', args: '{"query":"User","action":"code"}', ok: true, summary: '4' },
    ];
    const record = buildCountsRecord(log);
    expect(record.steps[0]!.overlaps).toEqual([{ a: 0, b: 1, kind: 'search-lsp' }]);
    expect(record.steps[0]!.calls[3]!.flags).toContain('repeat');
    expect(record.steps[0]!.calls[0]!.flags ?? []).not.toContain('repeat');
  });

  it('carried едет из шага в запись, а carriedTotal суммирует прогон', () => {
    const base = run();
    const log: ChatRunLog = {
      ...base,
      steps: [
        { ...base.steps[0]!, carried: 9_000 },
        { ...base.steps[1]!, carried: 14_000 },
      ],
    };
    const record = buildCountsRecord(log, { conversation: 'uid' });
    //цена контекста этого шага
    expect(record.steps[0]!.carried).toBe(9_000);
    expect(record.steps[1]!.carried).toBe(14_000);
    //сумма, иначе 40-шаговый прогон выглядит как один шаг
    expect(record.trace.carriedTotal).toBe(23_000);
  });

  it('шаг без carried не выдумывает ноль и не ломает сумму', () => {
    const base = run();
    const log: ChatRunLog = {
      ...base,
      steps: [{ ...base.steps[0]!, carried: 5_000 }, base.steps[1]!],
    };
    const record = buildCountsRecord(log, { conversation: 'uid' });
    expect(record.steps[1]!.carried).toBeUndefined();
    expect(record.trace.carriedTotal).toBe(5_000);
  });
});
