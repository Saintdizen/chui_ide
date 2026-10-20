import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProgram, type RunCodeRunOptions } from '../src/main/ai/run-code';

/**
 * `run_code`: настоящий запуск программы в отдельном процессе.
 *
 * Здесь проверяется то, чего не видно по чистым функциям: программа правда
 * исполняется, зовёт инструменты по каналу к main, получает ответы и умирает по
 * времени. Отдельно — то, ради чего модель прав Node и включена: программа НЕ
 * читает чужие файлы и НЕ пишет в проект; иначе «вызов инструмента» превратился
 * бы в обход ревью и песочницы.
 *
 * Инструменты подменены: `onCall` считает вызовы и отдаёт текст. Никакой сети и
 * никакого окна — только процесс, программа и канал.
 */

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-run-code-root-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'первый\nвторой\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Хост инструментов: `read` отдаёт что-то похожее на настоящее чтение. */
const tools = (seen: Array<{ name: string; args: unknown }>): RunCodeRunOptions['onCall'] => {
  return async (name, args) => {
    seen.push({ name, args });
    if (name === 'fail_me') return { ok: false, summary: 'нет такого', text: 'нет такого' };
    return { ok: true, summary: `${name}: ок`, text: `текст от ${name}` };
  };
};

describe('программа исполняется', () => {
  it('зовёт инструменты, печатает и возвращает значение', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const outcome = await runProgram(
      [
        "const first = await tools.read({ path: 'a.txt' });",
        "const second = await tools.read({ path: 'b.txt' });",
        "console.log('прочитано', first.ok, second.ok);",
        'return { count: 2, first: first.text };',
      ].join('\n'),
      { root, onCall: tools(seen) },
    );

    expect(outcome.error).toBeUndefined();
    expect(seen).toEqual([
      { name: 'read', args: { path: 'a.txt' } },
      { name: 'read', args: { path: 'b.txt' } },
    ]);
    expect(outcome.calls.map((call) => call.name)).toEqual(['read', 'read']);
    expect(outcome.logs).toBe('прочитано true true');
    expect(outcome.value).toContain('"count":2');
    expect(outcome.value).toContain('текст от read');
    expect(outcome.timedOut).toBe(false);
  });

  it('вызов без аргументов не падает', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const outcome = await runProgram("await tools.project_map();\nreturn 'ok';", { root, onCall: tools(seen) });
    expect(outcome.error).toBeUndefined();
    expect(seen).toEqual([{ name: 'project_map', args: {} }]);
  });

  it('ошибка инструмента видна программе, а не роняет её', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const outcome = await runProgram(
      ['const bad = await tools.fail_me({});', 'return { ok: bad.ok, text: bad.text };'].join('\n'),
      { root, onCall: tools(seen) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toContain('"ok":false');
    expect(outcome.calls[0]?.ok).toBe(false);
  });

  it('падение программы — причина и стек, а не пустой ответ', async () => {
    const outcome = await runProgram('const x = undefined;\nreturn x.length;', {
      root,
      onCall: tools([]),
    });
    expect(outcome.error).toBeTruthy();
    expect(outcome.error).toMatch(/undefined|Cannot read/i);
    expect(outcome.stack ?? '').toContain('program.mjs');
  });

  it('синтаксическая ошибка названа', async () => {
    const outcome = await runProgram('return (((;', { root, onCall: tools([]) });
    expect(outcome.error).toBeTruthy();
  });
});

describe('пределы', () => {
  it('программа останавливается по времени', async () => {
    const outcome = await runProgram('await new Promise((resolve) => setTimeout(resolve, 30000));\nreturn 1;', {
      root,
      onCall: tools([]),
      timeoutMs: 1_000,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toContain('не уложилась');
    expect(outcome.ms).toBeLessThan(10_000);
  });

  it('вызовов больше предела — остальные получают отказ', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const outcome = await runProgram(
      [
        'const results = [];',
        'for (let i = 0; i < 5; i += 1) results.push(await tools.read({ path: String(i) }));',
        'return results.map((item) => item.ok);',
      ].join('\n'),
      { root, onCall: tools(seen), maxCalls: 2 },
    );
    expect(seen.length).toBe(2);
    expect(outcome.callsExceeded).toBe(true);
    expect(outcome.value).toContain('false');
  });

  it('вызов уходит хосту по имени: запрет решает main, а не обвязка', async () => {
    // `runCodeToolAllowed` живёт в main — здесь важно, что имя инструмента
    // доходит до хоста как есть: значит решение о запрете принимается в одном
    // месте, а не размазано по процессу программы.
    const seen: Array<{ name: string; args: unknown }> = [];
    const outcome = await runProgram("await tools.run_code({ code: 'return 1' });\nreturn 1;", {
      root,
      onCall: tools(seen),
    });
    expect(outcome.error).toBeUndefined();
    expect(seen.map((call) => call.name)).toEqual(['run_code']);
  });
});

describe('права на файловую систему', () => {
  it('читать файлы проекта можно', async () => {
    const file = path.join(root, 'a.txt');
    const outcome = await runProgram(
      [
        'const { readFileSync } = await import("node:fs");',
        `return readFileSync(${JSON.stringify(file)}, "utf8").trim();`,
      ].join('\n'),
      { root, onCall: tools([]) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe('первый\nвторой');
  });

  it('читать чужой файл нельзя: модель прав Node не даёт', async () => {
    const outside = path.join(os.homedir(), '.chui-run-code-should-not-exist');
    const outcome = await runProgram(
      [
        'const { readFileSync } = await import("node:fs");',
        `try { readFileSync(${JSON.stringify(outside)}, "utf8"); return "прочитал"; }`,
        'catch (error) { return "отказ: " + error.message; }',
      ].join('\n'),
      { root, onCall: tools([]) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toMatch(/отказ: .*(restricted|permission)/i);
  });

  it('писать в проект нельзя: правки идут через инструменты', async () => {
    const target = path.join(root, 'written.txt');
    const outcome = await runProgram(
      [
        'const { writeFileSync } = await import("node:fs");',
        `try { writeFileSync(${JSON.stringify(target)}, "x"); return "записал"; }`,
        'catch (error) { return "отказ: " + error.message; }',
      ].join('\n'),
      { root, onCall: tools([]) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toMatch(/отказ: .*(restricted|permission)/i);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('запустить потомка нельзя: для команд есть инструменты', async () => {
    const outcome = await runProgram(
      [
        'const { spawnSync } = await import("node:child_process");',
        'try { const run = spawnSync("echo", ["привет"]); return "потомок: " + String(run.status); }',
        'catch (error) { return "отказ: " + error.message; }',
      ].join('\n'),
      { root, onCall: tools([]) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toMatch(/отказ: /);
  });
});
