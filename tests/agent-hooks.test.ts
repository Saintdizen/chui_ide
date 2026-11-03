/**
 * Хуки агента: скрипт проекта решает, пускать ли вызов, и дописывает строку.
 *
 * Проверяем то, на чём хук можно испортить: код выхода — главный голос, отказ
 * уезжает модели вместо результата, ошибка и таймаут — это «мнения нет», а не
 * запрет, и `note` режется по длине, чтобы не съесть промпт.
 *
 * Скрипты настоящие, но короткие: `node -e` через оболочку, как и у человека.
 */
import { describe, expect, it } from 'vitest';
import { createAgentHooks, type AgentHookCall } from '../src/main/ai/agent-hooks';
import { hookMatchesTool, normalizeAgentHooks } from '../src/shared/agent-hooks';

const node = process.execPath;

function call(tool = 'terminal'): AgentHookCall {
  return { tool, args: { command: 'echo привет' } };
}

function make(
  command: string,
  extra: { event?: 'before-tool' | 'after-tool'; match?: string[]; timeoutMs?: number } = {},
) {
  return createAgentHooks({
    cwd: process.cwd(),
    hooks: [
      {
        name: 'проверка',
        event: extra.event ?? 'before-tool',
        ...(extra.match ? { match: extra.match } : {}),
        ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
        command,
      },
    ],
  });
}

describe('разбор настроек', () => {
  it('мусор отбрасывается, умолчания на месте', () => {
    const hooks = normalizeAgentHooks([
      { name: 'пускаем', event: 'before-tool', command: 'true' },
      { name: '', event: 'before-tool', command: 'true' },
      { event: 'before-tool', command: '  ' },
      { name: 'чужое', event: 'после', command: 'true' },
      null,
      'строка',
    ]);

    expect(hooks).toHaveLength(2);
    // Имя необязательно: безымянный хук получает номер, чтобы отказ было на что списать.
    expect(hooks.map((hook) => hook.name)).toEqual(['пускаем', 'hook-2']);
    expect(hooks[0]?.enabled).toBeUndefined();
    expect(hooks[0]?.timeoutMs).toBeUndefined();
  });

  it('совпадение по имени инструмента: пусто — все, звёздочка работает', () => {
    const hook = { name: 'х', event: 'before-tool' as const, command: 'true', enabled: true };
    expect(hookMatchesTool(hook, 'terminal')).toBe(true);
    expect(hookMatchesTool({ ...hook, match: ['edit'] }, 'edit')).toBe(true);
    expect(hookMatchesTool({ ...hook, match: ['edit'] }, 'terminal')).toBe(false);
    expect(hookMatchesTool({ ...hook, match: ['git_*'] }, 'git_push')).toBe(true);
  });
});

describe('проверка до вызова', () => {
  it('ненулевой код выхода — отказ, причина из stdout', async () => {
    const hooks = make(`${node} -e "console.log('в release не пускаем'); process.exit(3)"`);
    const verdict = await hooks.before(call());
    expect(verdict.deny).toContain('в release не пускаем');
    expect(verdict.deny).toContain('проверка');
  });

  it('JSON с решением: отказ не требует ненулевого кода', async () => {
    const hooks = make(`${node} -e "console.log(JSON.stringify({decision:'deny',reason:'нельзя'}))"`);
    const verdict = await hooks.before(call());
    expect(verdict.deny).toContain('нельзя');
  });

  it('молчание — пускать: пустой ответ и код 0', async () => {
    const hooks = make(`${node} -e "process.stdin.resume()"`);
    const verdict = await hooks.before(call());
    expect(verdict.deny).toBeUndefined();
    expect(verdict.notes).toHaveLength(0);
  });

  it('приписка до вызова уходит отдельной строкой', async () => {
    const hooks = make(`${node} -e "console.log(JSON.stringify({note:'миграции рядом'}))"`);
    const verdict = await hooks.before(call());
    expect(verdict.deny).toBeUndefined();
    expect(verdict.notes[0]?.text).toBe('миграции рядом');
  });
});

describe('проверка после вызова', () => {
  it('приписка попадает в результат, а не в отказ', async () => {
    const hooks = make(`${node} -e "console.log(JSON.stringify({note:'диф не проверен'}))"`, {
      event: 'after-tool',
    });
    const notes = await hooks.after(call('edit'), { ok: true, summary: 'правка' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ hook: 'проверка', text: 'диф не проверен' });
  });

  it('упавший хук после вызова не отменяет результат', async () => {
    const hooks = make(`${node} -e "process.exit(1)"`, { event: 'after-tool' });
    const notes = await hooks.after(call('edit'), { ok: true, summary: 'правка' });
    expect(notes).toHaveLength(0);
  });
});

describe('исправность скрипта', () => {
  it('зависший хук — не запрет: таймаут считается «мнения нет»', async () => {
    const hooks = make(`${node} -e "setTimeout(() => {}, 5000)"`, { timeoutMs: 200 });
    const started = Date.now();
    const verdict = await hooks.before(call());
    expect(verdict.deny).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('скрипт видит рабочий каталог проекта, а не каталог IDE', async () => {
    const hooks = make(`${node} -e "process.stdout.write(JSON.stringify({note: process.cwd()}))"`);
    const verdict = await hooks.before(call());
    expect(verdict.notes[0]?.text).toBe(process.cwd());
  });

  it('вызов чужого инструмента хук не трогает', async () => {
    const hooks = make(`${node} -e "process.exit(1)"`, { match: ['edit'] });
    const verdict = await hooks.before(call('terminal'));
    expect(verdict.deny).toBeUndefined();
  });

  it('длинная приписка режется: ответ хука не должен съесть промпт', async () => {
    const hooks = make(`${node} -e "console.log(JSON.stringify({note: 'я'.repeat(5000)}))"`, { event: 'after-tool' });
    const notes = await hooks.after(call('edit'), { ok: true, summary: 'правка' });
    expect(notes[0]?.text.length).toBeLessThanOrEqual(1_001);
  });

  it('хук получает вызов JSON-ом на stdin', async () => {
    const script =
      "let d='';process.stdin.on('data',(c)=>d+=c);" +
      "process.stdin.on('end',()=>{const p=JSON.parse(d);" +
      "console.log(JSON.stringify({note:p.tool+':'+p.args.command}))});";
    const hooks = make(`${node} -e "${script}"`);
    const verdict = await hooks.before(call());
    expect(verdict.notes[0]?.text).toBe('terminal:echo привет');
  });
});
