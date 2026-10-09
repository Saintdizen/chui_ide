/*
 * Инструменты терминала агента с фейковым pty: проверяем провод (id/offset/alive),
 * очистку ANSI, подтверждение ввода и остановку сессии. Настоящий pty покрыт
 * smoke:terminal, здесь важна логика самих инструментов.
 */
const assert = require('node:assert/strict');

const { runTool, isDangerousCommand } = require('../dist/main/ai/agent-tools.js');

let failures = 0;
function ok(name, condition, extra) {
  if (condition) console.log(`  ok   ${name}${extra ? `: ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`);
  }
}

/** Фейковый терминал: тот же контракт, что у TerminalService, но без node-pty. */
function fakeTerminals() {
  const sessions = new Map();
  let sequence = 0;
  return {
    list() {
      return [...sessions.values()].map((s) => ({ id: s.id, title: s.id, cwd: s.cwd, shell: 'bash', pid: 1 }));
    },
    create({ cwd }) {
      sequence += 1;
      const id = `t${sequence}`;
      sessions.set(id, { id, cwd: cwd ?? '/x', log: '', dropped: 0, alive: true });
      return { id, title: id, cwd: cwd ?? '/x', shell: 'bash', pid: 100 + sequence };
    },
    write(id, data) {
      const session = sessions.get(id);
      if (!session) throw new Error('нет сессии');
      // ANSI-цвет и возврат каретки — как у настоящего pty: инструмент обязан их вычистить.
      session.log += `\r\n\u001b[32m$ ${data.replace(/[\r\n]/g, '')}\u001b[0m\r\nhello world\r\n`;
    },
    read(id, from = 0) {
      const session = sessions.get(id);
      if (!session) throw new Error('нет сессии');
      const total = session.dropped + session.log.length;
      const start = Math.max(from, session.dropped);
      return { data: start >= total ? '' : session.log.slice(start - session.dropped), offset: total, alive: session.alive };
    },
    kill(id) {
      const session = sessions.get(id);
      if (session) session.alive = false;
    },
  };
}

async function main() {
  const confirmations = [];
  const ctx = {
    workspace: { rootPath: () => '/proj' },
    terminals: fakeTerminals(),
    confirmCommand: async (command) => {
      confirmations.push(command);
      return true;
    },
    autoApprove: false,
  };

  // 1. Старт сессии с командой: подтверждение + вывод без ANSI.
  const started = await runTool(ctx, 'terminal_start', JSON.stringify({ command: 'echo hi' }));
  ok('сессия запущена', started.ok && /сессия t1/.test(started.summary), started.summary);
  ok('команда подтверждена', confirmations[0] === 'echo hi', confirmations[0]);
  ok('ANSI вычищен из вывода', started.detail.includes('hello world') && !started.detail.includes('\u001b['));
  const offset = Number(/offset: (\d+)/.exec(started.detail)?.[1] ?? -1);
  ok('offset в ответе', offset > 0, String(offset));
  ok('alive: true', /alive: true/.test(started.detail));

  // 2. Чтение с того же офсета — нового вывода нет.
  const empty = await runTool(ctx, 'terminal_read', JSON.stringify({ id: 't1', from: offset }));
  ok('нет нового вывода', empty.ok && /нового вывода нет/.test(empty.summary), empty.summary);

  // 3. Ввод: подтверждается отдельно, затем виден в новом выводе.
  const wrote = await runTool(ctx, 'terminal_write', JSON.stringify({ id: 't1', data: 'ls\n' }));
  ok('ввод отправлен', wrote.ok && wrote.summary.includes('t1'), wrote.summary);
  ok('ввод подтверждён', confirmations[1]?.includes('ls'), confirmations[1]);
  const afterWrite = await runTool(ctx, 'terminal_read', JSON.stringify({ id: 't1', from: offset }));
  ok('новый вывод виден', /hello world/.test(afterWrite.detail));

  // 4. Полный доступ: рядовой ввод без подтверждения.
  const autoCtx = { ...ctx, autoApprove: true, allowAll: true, confirmCommand: undefined };
  const autoWrite = await runTool(autoCtx, 'terminal_write', JSON.stringify({ id: 't1', data: 'pwd\n' }));
  ok('полный доступ не спрашивает', autoWrite.ok, autoWrite.summary);

  // 4а. Страховка (confirmDangerous): при полном доступе опасное всё равно спрашивает.
  ok('опасная команда распознана', isDangerousCommand('sudo rm -rf /'));
  ok('рядовая команда не помечена', !isDangerousCommand('npm test'));
  const guardedLog = [];
  const guardedCtx = {
    ...ctx,
    autoApprove: true,
    allowAll: true,
    confirmDangerous: true,
    confirmCommand: async (command) => {
      guardedLog.push(command);
      return true;
    },
  };
  const guarded = await runTool(guardedCtx, 'terminal_write', JSON.stringify({ id: 't1', data: 'sudo rm -rf /\n' }));
  ok('страховка спросила при полном доступе', guarded.ok && guardedLog.some((c) => c.includes('sudo rm -rf /')), guardedLog.join('; '));
  const guardedPlain = await runTool(guardedCtx, 'terminal_write', JSON.stringify({ id: 't1', data: 'pwd\n' }));
  ok('рядовая команда прошла без вопроса', guardedPlain.ok && guardedLog.length === 1, `вопросов: ${guardedLog.length}`);

  // 5. Список и остановка.
  const list = await runTool(ctx, 'terminal_list', '{}');
  ok('список содержит сессию', list.ok && list.detail.includes('t1'), list.detail);

  const stopped = await runTool(ctx, 'terminal_stop', JSON.stringify({ id: 't1' }));
  ok('сессия остановлена', stopped.ok && ctx.terminals.read('t1').alive === false);

  // 6. Пустой id отвергается понятной ошибкой.
  const bad = await runTool(ctx, 'terminal_read', JSON.stringify({}));
  ok('без id — ошибка', !bad.ok && /«id»/.test(bad.summary), bad.summary);

  console.log(failures === 0 ? '\n[chui] терминальные инструменты агента работают' : `\n[chui] ошибок: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
