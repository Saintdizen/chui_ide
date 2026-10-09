/**
 * Интеграционная проверка терминала: поднимает настоящий main-процесс Electron,
 * создаёт сессию через TerminalService, отправляет команду и проверяет вывод.
 *
 *   npm run smoke:terminal
 *
 * Требует собранный main (npm run build:main) и пересобранный под Electron node-pty.
 */
const { app } = require('electron');
const { TerminalService } = require('../dist/main/terminal/terminal.js');

const MARKER = 'chui-terminal-ok';

app.whenReady().then(async () => {
  const chunks = [];
  const terminals = new TerminalService((topic, payload) => {
    if (topic === 'terminal:data') chunks.push(payload.data);
  });

  let session;
  try {
    session = await terminals.create({ cols: 80, rows: 24, cwd: process.cwd() });
  } catch (error) {
    console.error('[chui] не удалось создать сессию:', error.message);
    app.exit(1);
    return;
  }

  console.log(`[chui] сессия ${session.id} · ${session.shell} · pid ${session.pid} · cwd ${session.cwd}`);
  terminals.write(session.id, `echo ${MARKER}\r`);

  setTimeout(() => {
    const output = chunks.join('').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
    // Приглашение bash сокращает путь до «~», поэтому абсолютный cwd в выводе не ищем.
    const passed = output.includes(MARKER) && output.includes('$');
    console.log('--- вывод терминала ---');
    console.log(output.trim());
    console.log('-----------------------');
    console.log(passed ? '[chui] TerminalService работает' : '[chui] вывод не совпал с ожиданием');

    terminals.resize(session.id, 100, 30);
    terminals.kill(session.id);
    terminals.dispose();
    app.exit(passed ? 0 : 1);
  }, 1200);
});
