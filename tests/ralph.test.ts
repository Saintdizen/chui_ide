import { describe, expect, it } from 'vitest';
import {
  RALPH_DEFAULT_ROUNDS,
  RALPH_DIGEST_CHARS,
  RALPH_DONE_MARKER,
  RALPH_MAX_ROUNDS,
  RALPH_ROUND_CHARS,
  clipRoundReport,
  formatRalphReport,
  isRalphDone,
  parseRalphRequest,
  ralphDigest,
  ralphRoundPrompt,
  runRalphRounds,
  type RalphRound,
} from '../src/shared/ralph';

describe('ralph: разбор вызова', () => {
  it('без задания отказывает словами, а не молча', () => {
    const request = parseRalphRequest({});
    expect(request.error).toContain('goal');
    expect(request.goal).toBe('');
  });

  it('задание берётся из goal, а если его нет — из prompt', () => {
    expect(parseRalphRequest({ goal: 'починить тесты' }).goal).toBe('починить тесты');
    expect(parseRalphRequest({ prompt: 'починить тесты' }).goal).toBe('починить тесты');
    expect(parseRalphRequest({ goal: '  ', prompt: 'из prompt' }).goal).toBe('из prompt');
  });

  it('предел раундов по умолчанию человеческий', () => {
    expect(parseRalphRequest({ goal: 'x' }).rounds).toBe(RALPH_DEFAULT_ROUNDS);
    expect(parseRalphRequest({ goal: 'x', rounds: '4' }).rounds).toBe(4);
  });

  it('предел подрезается по максимуму, а не принимается на слово', () => {
    expect(parseRalphRequest({ goal: 'x', rounds: 99 }).rounds).toBe(RALPH_MAX_ROUNDS);
    expect(parseRalphRequest({ goal: 'x', rounds: 0 }).rounds).toBe(1);
    expect(parseRalphRequest({ goal: 'x', rounds: -3 }).rounds).toBe(1);
  });

  it('мусор в rounds — умолчание, а не отказ', () => {
    expect(parseRalphRequest({ goal: 'x', rounds: 'сколько надо' }).rounds).toBe(RALPH_DEFAULT_ROUNDS);
    expect(parseRalphRequest({ goal: 'x', rounds: null }).rounds).toBe(RALPH_DEFAULT_ROUNDS);
  });
});

describe('ralph: признак готовности', () => {
  it('маркер в начале отчёта — готово', () => {
    expect(isRalphDone(`${RALPH_DONE_MARKER}: всё сходится`)).toBe(true);
    expect(isRalphDone('готово')).toBe(true);
  });

  it('выделение и нумерация маркер не прячут', () => {
    expect(isRalphDone(`**${RALPH_DONE_MARKER}** — тесты зелёные`)).toBe(true);
    expect(isRalphDone(`1. ${RALPH_DONE_MARKER}`)).toBe(true);
    expect(isRalphDone(`> ${RALPH_DONE_MARKER}: проверено`)).toBe(true);
  });

  it('маркер в середине или в конце — это ещё не готово', () => {
    // Иначе отчёт «осталось три пункта, потом напишем ГОТОВО» закрывал бы цикл.
    expect(isRalphDone(`Осталось три пункта. ${RALPH_DONE_MARKER} скажем позже`)).toBe(false);
    expect(isRalphDone('Проверил, всё сходится')).toBe(false);
    expect(isRalphDone('')).toBe(false);
  });
});

describe('ralph: что видит следующий раунд', () => {
  it('длинный отчёт обрезается и говорит об этом', () => {
    const long = Array.from({ length: 200 }, (_, i) => `строка ${i}: подробности проверки`).join('\n');
    const clipped = clipRoundReport(long);
    expect(clipped.length).toBeLessThan(RALPH_ROUND_CHARS + 120);
    expect(clipped).toContain('обрезан');
    // Режем по целой строке: обрывок на середине слова читался бы как другая мысль.
    expect(clipped.split('\n').at(-2)).toMatch(/^строка \d+: подробности проверки$/);
  });

  it('короткий отчёт доезжает целиком', () => {
    expect(clipRoundReport('проверил, чисто')).toBe('проверил, чисто');
  });

  it('сводка подписана номерами раундов', () => {
    const rounds: RalphRound[] = [
      { index: 1, report: 'нашёл A' },
      { index: 2, report: 'нашёл B' },
    ];
    const digest = ralphDigest(rounds);
    expect(digest).toContain('Раунд 1:');
    expect(digest).toContain('нашёл A');
    expect(digest).toContain('Раунд 2:');
    expect(digest.indexOf('Раунд 1')).toBeLessThan(digest.indexOf('Раунд 2'));
  });

  it('сводка не растёт больше предела, даже на пяти раундах', () => {
    const rounds: RalphRound[] = Array.from({ length: RALPH_MAX_ROUNDS }, (_, i) => ({
      index: i + 1,
      report: 'подробности '.repeat(200),
    }));
    expect(ralphDigest(rounds).length).toBeLessThan(RALPH_DIGEST_CHARS + 200);
  });
});

describe('ralph: сам цикл', () => {
  const request = parseRalphRequest({ goal: 'довести отчёт', rounds: 3 });

  it('каждый раунд — свой прогон, и задание в нём одно', async () => {
    const prompts: string[] = [];
    const result = await runRalphRounds({
      request,
      aborted: () => false,
      run: async (prompt, round) => {
        prompts.push(prompt);
        return { ok: true, report: `раунд ${round}: осталось ${4 - round} пунктов` };
      },
    });
    expect(prompts).toHaveLength(3);
    expect(result.stop).toBe('limit');
    expect(result.rounds.map((round) => round.index)).toEqual([1, 2, 3]);
    // Задание едет в каждый раунд, а прошлый отчёт — только сжатым итогом.
    for (const prompt of prompts) expect(prompt).toContain('довести отчёт');
    expect(prompts[1]).toContain('Раунд 1:');
    expect(prompts[2]).toContain('Раунд 2:');
    expect(prompts[0]).toContain('первый раунд');
  });

  it('слово «готово» обрывает цикл раньше предела', async () => {
    const result = await runRalphRounds({
      request,
      aborted: () => false,
      run: async (_prompt, round) => ({
        ok: true,
        report: round === 2 ? `${RALPH_DONE_MARKER}: делать нечего` : 'нашёл ещё',
      }),
    });
    expect(result.stop).toBe('done');
    expect(result.rounds).toHaveLength(2);
  });

  it('предел раундов не превышается, сколько бы раунд ни просил', async () => {
    let calls = 0;
    const result = await runRalphRounds({
      request: parseRalphRequest({ goal: 'крутить', rounds: 99 }),
      aborted: () => false,
      run: async () => {
        calls += 1;
        return { ok: true, report: 'ещё не всё' };
      },
    });
    expect(calls).toBe(RALPH_MAX_ROUNDS);
    expect(result.rounds).toHaveLength(RALPH_MAX_ROUNDS);
    expect(result.stop).toBe('limit');
  });
});

describe('ralph: обрыв и отказ', () => {
  const request = parseRalphRequest({ goal: 'довести', rounds: 4 });

  it('стоп до первого раунда — ни одного прогона', async () => {
    let calls = 0;
    const result = await runRalphRounds({
      request,
      aborted: () => true,
      run: async () => {
        calls += 1;
        return { ok: true, report: 'x' };
      },
    });
    expect(calls).toBe(0);
    expect(result.stop).toBe('interrupted');
    expect(result.rounds).toEqual([]);
  });

  it('стоп во время раунда не даёт запустить остаток', async () => {
    // Человек нажал стоп, пока раунд думал: остальные раунды стоят денег и не нужны.
    let stopped = false;
    let calls = 0;
    const result = await runRalphRounds({
      request,
      aborted: () => stopped,
      run: async (_prompt, round) => {
        calls += 1;
        if (round === 2) stopped = true;
        return { ok: true, report: 'ещё не всё' };
      },
    });
    expect(calls).toBe(2);
    expect(result.stop).toBe('interrupted');
    expect(result.rounds).toHaveLength(2);
  });
});

describe('ralph: отчёт агенту', () => {
  const rounds: RalphRound[] = [
    { index: 1, report: 'раунд 1: нашёл A' },
    { index: 2, report: 'раунд 2: нашёл B' },
  ];

  it('считает раунды и говорит, почему встали', () => {
    expect(formatRalphReport(rounds, 'done', 5)).toContain('раундов: 2 из 5');
    expect(formatRalphReport(rounds, 'limit', 5)).toContain('предел раундов');
    expect(formatRalphReport(rounds, 'interrupted', 5)).toContain('остановлено человеком');
    expect(formatRalphReport(rounds, 'failed', 5)).toContain('не справился');
  });

  it('отчёты раундов идут целиком, а не сжатыми', () => {
    // Обрезка нужна раунду; человек и основной агент должны видеть всё, что нашли.
    const long = 'подробности '.repeat(300);
    const report = formatRalphReport([{ index: 1, report: long }], 'limit', 1);
    expect(report).toContain(long.trim());
    expect(report).not.toContain('обрезан');
  });

  it('пустой цикл объясняется словами, а не «раундов: 0»', () => {
    expect(formatRalphReport([], 'interrupted', 3)).toContain('цикл не начался');
  });

  it('правки остаются основному агенту: раунды только смотрели', () => {
    expect(formatRalphReport(rounds, 'limit', 5)).toContain('делаешь ты');
    expect(formatRalphReport(rounds, 'done', 5)).toContain('проверь сам');
  });
});

describe('ralph: текст запроса к раунду', () => {
  const request = parseRalphRequest({ goal: 'довести отчёт', rounds: 4 });

  it('раунд знает свой номер и предел', () => {
    expect(ralphRoundPrompt(request, 2, [])).toContain('раунд 2 из 4');
  });

  it('раунд не делает правок и просит отчёт о проверке', () => {
    const prompt = ralphRoundPrompt(request, 1, []);
    expect(prompt).toContain('только смотришь');
    expect(prompt).toContain('файл:строка');
  });

  it('маркер готовности назван явно, иначе цикл всегда упирается в предел', () => {
    expect(ralphRoundPrompt(request, 1, [])).toContain(RALPH_DONE_MARKER);
  });

  it('первый раунд не получает пустую сводку', () => {
    const first = ralphRoundPrompt(request, 1, []);
    expect(first).toContain('первый раунд');
    expect(first).not.toContain('Раунд 1:');
  });
});
