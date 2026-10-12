/**
 * Dev-режим: поднимаем Vite как программу, отдаём URL в Electron и ждём закрытия окна.
 * Без concurrently/wait-on: один процесс, один сигнал выключения, никаких гонок за порт.
 *
 * Аргументы после `--` уходят в Electron: `npm run dev -- --user-data-dir=/tmp/chui-dev`.
 * Это нужно, когда уже запущена установленная IDE: она держит `SingletonLock` в общем
 * профиле (`~/.config/chui-ide`), и dev-экземпляр молча выходит на
 * `requestSingleInstanceLock()`. Отдельный профиль даёт им жить рядом.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.mts', mode: 'development' });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('[chui] не удалось определить адрес dev-сервера');
  await server.close();
  process.exit(1);
}

console.log(`[chui] renderer: ${url}`);

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CHUI_DEV_SERVER_URL: url, ELECTRON_ENABLE_LOGGING: '1' },
});

let closing = false;
const shutdown = async (code) => {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  process.exit(code ?? 0);
};

child.on('exit', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
