/**
 * Проверка нативного модуля: запускается в Electron (но как Node, без окна)
 * и убеждается, что node-pty собран под ABI Electron, а не под обычный Node.
 *
 *   npm run smoke:pty
 *
 * Если здесь SIGSEGV или ошибка загрузки — нужен `npm run rebuild`.
 */
const pty = require('node-pty');

const shell = process.env.SHELL || '/bin/bash';
const child = pty.spawn(shell, ['-lc', 'echo pty-ok; printf "TERM=%s\\n" "$TERM"; exit'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

let output = '';
child.onData((data) => {
  output += data;
  process.stdout.write(data);
});

child.onExit(({ exitCode }) => {
  const passed = output.includes('pty-ok') && output.includes('TERM=xterm-256color');
  console.log(passed ? '\n[chui] PTY работает' : '\n[chui] PTY ответил не тем, что ожидалось');
  process.exit(passed && exitCode === 0 ? 0 : 1);
});
