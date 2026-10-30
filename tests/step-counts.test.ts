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

  it('старые записи v1 в отчёт не едут: там код «other» без формы', () => {
    // Иначе в разделе «other по тексту» вечно висел бы «(форма не записана)»:
    // живые 415 записей v1 ушли в v2, и старые прогоны не должны с ними мешаться.
    const line = formatCountsLine(buildCountsRecord(run()));
    const old = line.replace(/"version":2/u, '"version":1');
    expect(parseCounts(old)).toEqual([]);
    expect(parseCounts(line)).toHaveLength(1);
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
    // Код-заглушку `command` в записи не держим: вид назван, причины нет.
    // Отказ всё равно виден — по `ok` и по форме.
    expect(calls[0]).toMatchObject({ ok: false });
    expect(calls[0]!.reason).toBeUndefined();
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
      undefined,
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
      // Команда провалилась без внятного текста: причина = форма, кода нет.
      undefined,
      undefined,
      'unavailable',
    ]);
    expect(callFailureReason({ ok: true, summary: 'ok' })).toBe('other');
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
    // Код `command` — заглушка: причина не в нём, а в тексте, и текст едет формой.
    expect(second.steps[0]!.calls[0]!.reason).toBeUndefined();
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
    // Код-заглушку не держим — она не причина, а его место занимает форма.
    expect(call.reason).toBeUndefined();
    expect(call.unknown).toBe('1 тест упал: ждали 2, получили 3');
  });

  // Дыры, найденные `npm run census` в живых беседах: оба текста оседали в «other».
  // Команда длиннее лимита чинится аргументом (положить в файл кусками), а путь вне
  // рабочей папки — не «не найдено» и не «неизвестно что»: это граница прав.
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
});
