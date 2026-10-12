/**
 * Проба: чужой коммит гасит пометки git в дереве.
 *
 * Коммит из терминала или агента переписывает `.git`, но не файлы дерева — раньше
 * пометки оставались старыми до ручного «Обновить». Здесь GitService поднимается над
 * временным репозиторием, коммит делается «мимо IDE», и проба смотрит, что статус
 * пересчитался сам: публикация ушла, а правок в статусе не осталось.
 *
 * Печатает состояние, а не ok/FAIL — как остальные «пробники».
 *
 *   ./node_modules/.bin/electron scripts/git-watch-probe.cjs
 */
const { app } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitService } = require('../dist/main/git/git.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, args) =>
  new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true }, (error) => resolve(!error)));

app.whenReady().then(async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chui-gitwatch-')));
  fs.writeFileSync(path.join(base, 'a.txt'), 'one\n');
  await git(base, ['init', '-q']);
  await git(base, ['config', 'user.email', 'probe@example.com']);
  await git(base, ['config', 'user.name', 'Проверка']);
  await git(base, ['add', '-A']);
  await git(base, ['commit', '-q', '-m', 'init']);

  // Колбэк наблюдателя делает то же, что main: пересчитывает статус.
  const published = [];
  const service = new GitService(
    () => base,
    (topic, payload) => published.push({ topic, files: payload?.files?.length ?? null }),
    async () => {
      await service.refresh();
    },
  );

  // Первый статус заводит наблюдение за `.git`.
  console.log('[старт] правок в статусе:', (await service.status()).files.length);

  // Правка на диске: git видит изменение, пометка в дереве — одна.
  fs.writeFileSync(path.join(base, 'a.txt'), 'two\n');
  console.log('[до коммита] правок в статусе:', (await service.status()).files.length);

  // Коммит «мимо IDE»: без наблюдения за `.git` пометка осталась бы старой.
  await git(base, ['add', '-A']);
  await git(base, ['commit', '-q', '-m', 'second']);
  await wait(1500);

  console.log('[после чужого коммита] публикаций статуса:', published.length, JSON.stringify(published));
  console.log('[итог] правок в статусе:', (await service.status()).files.length);

  service.dispose();
  fs.rmSync(base, { recursive: true, force: true });
  app.exit(0);
});
