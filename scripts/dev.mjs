/**
 * Dev-режим: поднимаем Vite как программу, отдаём URL в Electron и ждём закрытия окна.
 * Без concurrently/wait-on: один процесс, один сигнал выключения, никаких гонок за порт.
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

const child = spawn(electronPath, ['.'], {
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
