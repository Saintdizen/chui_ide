import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProgram } from '../src/main/ai/run-code';

/**
 * `workflow`: настоящий запуск сценария в отдельном процессе.
 *
 * Проверяется то, чего не видно по чистым функциям: сценарий правда исполняется,
 * зовёт агентов по каналу к main, получает их отчёты и ветвит по ним работу.
 * Агенты подменены: `onAgent` запоминает задания и отдаёт текст. Никакой сети и
 * никакого окна — только процесс, сценарий и канал.
 */

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-workflow-root-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

interface SeenAgent {
  description: string;
  prompt: string;
}

/** Хост агентов: запоминает задания и отдаёт отчёт, собранный из задания. */
const host = (seen: SeenAgent[]) => {
  return async (request: SeenAgent) => {
    seen.push(request);
    if (request.prompt.includes('упади')) throw new Error('агент не смог');
    return { ok: true, summary: `отчёт: ${request.prompt}`, text: `отчёт: ${request.prompt}` };
  };
};

describe('сценарий раздаёт работу', () => {
  it('запускает агента и возвращает его отчёт', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      [
        "const found = await agents.run({ prompt: 'где живёт настройка', description: 'настройка' });",
        'return found.text;',
      ].join('\n'),
      { root, program: 'workflow', onAgent: host(seen) },
    );

    expect(outcome.error).toBeUndefined();
    expect(seen).toEqual([{ description: 'настройка', prompt: 'где живёт настройка' }]);
    expect(outcome.value).toContain('отчёт: где живёт настройка');
    expect(outcome.agents?.length).toBe(1);
    expect(outcome.agents?.[0]?.ok).toBe(true);
  });

  it('ветвит работу по отчёту: второй агент получает то, что нашёл первый', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      [
        "const first = await agents.run({ prompt: 'вариант А', description: 'первый' });",
        "const second = await agents.run({ prompt: 'разбери: ' + first.text, description: 'второй' });",
        'return second.summary;',
      ].join('\n'),
      { root, program: 'workflow', onAgent: host(seen) },
    );

    expect(outcome.error).toBeUndefined();
    expect(seen.length).toBe(2);
    expect(seen[1]?.prompt).toContain('отчёт: вариант А');
  });

  it('пачка агентов возвращает отчёты в порядке заданий', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      [
        "const all = await agents.parallel([{ prompt: 'раз' }, { prompt: 'два' }, { prompt: 'три' }]);",
        'return all.map((item) => item.text).join(" | ");',
      ].join('\n'),
      { root, program: 'workflow', onAgent: host(seen) },
    );

    expect(outcome.error).toBeUndefined();
    expect(seen.length).toBe(3);
    expect(outcome.value).toBe('отчёт: раз | отчёт: два | отчёт: три');
  });

  it('задание без описания называется по своему тексту', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram("await agents.run({ prompt: 'найди все TODO' });\nreturn 1;", {
      root,
      program: 'workflow',
      onAgent: host(seen),
    });
    expect(outcome.error).toBeUndefined();
    expect(seen[0]?.description).toBe('найди все TODO');
  });
});

describe('пределы', () => {
  it('агентов больше предела — остальные получают отказ, сценарий живёт', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      [
        'const results = [];',
        'for (let i = 0; i < 4; i += 1) results.push(await agents.run({ prompt: "задание " + i }));',
        'return results.map((item) => item.ok);',
      ].join('\n'),
      { root, program: 'workflow', onAgent: host(seen), maxAgents: 2 },
    );

    expect(outcome.error).toBeUndefined();
    expect(seen.length).toBe(2);
    expect(outcome.agentsExceeded).toBe(true);
    expect(outcome.value).toContain('false');
  });

  it('пачка разом тоже упирается в предел, а не обходит его', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      [
        "const all = await agents.parallel([{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }]);",
        'return all.map((item) => item.ok);',
      ].join('\n'),
      { root, program: 'workflow', onAgent: host(seen), maxAgents: 2 },
    );

    expect(seen.length).toBe(2);
    expect(outcome.agentsExceeded).toBe(true);
  });

  it('пустое задание не тратит место: агент на него не запускается', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      ["const empty = await agents.run({ prompt: '   ' });", 'return empty.ok;'].join('\n'),
      { root, program: 'workflow', onAgent: host(seen) },
    );
    expect(outcome.error).toBeUndefined();
    expect(seen).toEqual([]);
    expect(outcome.value).toBe('false');
  });
});

describe('очередь и время', () => {
  it('одновременно работают не больше трёх агентов', async () => {
    let active = 0;
    let peak = 0;
    const slow = async (request: SeenAgent) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { ok: true, summary: request.prompt, text: request.prompt };
    };

    const outcome = await runProgram(
      [
        'const all = await agents.parallel([{ prompt: "1" }, { prompt: "2" }, { prompt: "3" }, { prompt: "4" }]);',
        'return all.length;',
      ].join('\n'),
      { root, program: 'workflow', onAgent: slow },
    );

    expect(outcome.error).toBeUndefined();
    expect(peak).toBeLessThanOrEqual(3);
    expect(outcome.value).toBe('4');
  });

  it('сценарий останавливается по времени', async () => {
    const outcome = await runProgram(
      [
        "await agents.run({ prompt: 'раз' });",
        'await new Promise((resolve) => setTimeout(resolve, 30000));',
        'return 1;',
      ].join('\n'),
      {
        root,
        program: 'workflow',
        onAgent: host([]),
        timeoutMs: 1_000,
      },
    );
    expect(outcome.timedOut).toBe(true);
  });
});

describe('чего в сценарии нет', () => {
  it('инструментов: tools в контексте сценария undefined', async () => {
    // Явный `tools.` отсекает проверка исходника, а здесь важно, что и в самом
    // процессе второго имени нет: `tools` не вдруг появился.
    const outcome = await runProgram(["await agents.run({ prompt: 'раз' });", 'return typeof tools;'].join('\n'), {
      root,
      program: 'workflow',
      onAgent: host([]),
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe('undefined');
  });

  it('пустой сценарий отвергается до запуска процесса', async () => {
    const outcome = await runProgram('   ', { root, program: 'workflow', onAgent: host([]) });
    expect(outcome.error).toContain('Сценарий пустой');
  });

  it('в сценарии нет агентов — отказ, а не пустой результат', async () => {
    const outcome = await runProgram('return 42;', { root, program: 'workflow', onAgent: host([]) });
    expect(outcome.error).toContain('ни одного вызова агента');
  });
});

describe('ошибки агентов', () => {
  it('упавший агент не роняет сценарий: он получает отказ, а сценарий ветвит дальше', async () => {
    const seen: SeenAgent[] = [];
    const outcome = await runProgram(
      ["const bad = await agents.run({ prompt: 'упади' });", "return bad.ok ? 'ok' : 'не вышло';"].join('\n'),
      { root, program: 'workflow', onAgent: host(seen) },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe('не вышло');
    expect(outcome.agents?.[0]?.ok).toBe(false);
  });

  it('падение сценария названо причиной и стеком', async () => {
    const outcome = await runProgram(
      ["await agents.run({ prompt: 'раз' });", 'const x = undefined;', 'return x.length;'].join('\n'),
      { root, program: 'workflow', onAgent: host([]) },
    );
    expect(outcome.error).toBeTruthy();
    expect(outcome.stack ?? '').toContain('program.mjs');
  });
});
