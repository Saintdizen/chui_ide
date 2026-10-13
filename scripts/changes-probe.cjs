/**
 * Проба отображения изменений в проводнике: git-пометки в дереве.
 *
 *   npm run probe:changes
 *
 * Репозиторий настоящий: файлы коммитятся, потом правятся так, чтобы у каждого
 * вида изменения был свой случай. Дальше проба смотрит то, что видит человек:
 * букву у файла (`M`, `A`, `D`, `U`), точку у папки с правками, подсказку и
 * приглушение игнорируемого. Проверяется именно отображение — что значки в DOM
 * совпадают со статусом, который IDE получила от git.
 */
const { app } = require('electron');
const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-changes-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'keep.ts'), 'const keep = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'gone.ts'), 'const gone = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(project, '.gitignore'), 'build/\n', 'utf8');

  await git(project, ['init', '-q']);
  await git(project, ['config', 'user.email', 'test@example.com']);
  await git(project, ['config', 'user.name', 'Test']);
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'init']);

  // Состояние на диске: изменённый, удалённый, добавленный в индекс, новый
  // (не отслеживается) и игнорируемый — по одному случаю на каждый значок.
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n\nправка\n', 'utf8');
  await fs.rm(path.join(project, 'src', 'gone.ts'));
  await fs.writeFile(path.join(project, 'src', 'fresh.ts'), 'export const fresh = 1;\n', 'utf8');
  await git(project, ['add', 'src/fresh.ts']);
  await fs.writeFile(path.join(project, 'untracked.txt'), 'новый\n', 'utf8');
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.writeFile(path.join(project, 'build', 'out.js'), '// сборка\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  // Третий аргумент — реакция на правку метаданных репозитория: так же, как в
  // main, чужой коммит (тут — команда git из пробы) пересчитывает статус и
  // рассылает его в renderer. Без него пометки в дереве застыли бы.
  let gitService;
  gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
    () => void gitService.refresh(),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Раскрываем `src`: правки есть и внутри неё — значит у папки должна быть точка.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'src',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  // Пометки git приходят push-событием и отложенным пересчётом — даём время.
  await wait(3000);

  /** Что нарисовано у строки с таким именем: классы, буква значка и подсказка. */
  const rowState = (name) =>
    ask(
      ide,
      `(() => {
        const row = [...document.querySelectorAll('.explorer .tree-rows .tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return null;
        const badge = row.querySelector('.tree-badge');
        const dot = row.querySelector('.tree-dot');
        return {
          классы: [...row.classList].filter((item) => item !== 'tree-row'),
          значок: badge ? badge.textContent : null,
          знакКласс: badge ? [...badge.classList] : null,
          точка: dot ? [...dot.classList] : null,
          подсказка: badge ? badge.title : (dot ? dot.title : null),
        };
      })()`,
    );

  console.log('[changes] статус git:');
  const status = await git(project, ['status', '--porcelain']);
  console.log(status.stdout.trimEnd());

  const readme = await rowState('README.md');
  check('изменённый файл помечен M', readme?.значок === 'M', readme);

  // Удалённый файл с диска исчез, но git о нём знает — строка с пометкой `D`
  // должна остаться (зачёркнутая), иначе об удалении в дереве не догадаться.
  const gone = await rowState('gone.ts');
  check('удалённый файл помечен D и зачёркнут', gone?.значок === 'D' && gone?.классы.includes('is-deleted'), gone);

  const fresh = await rowState('fresh.ts');
  check('добавленный в индекс помечен A', fresh?.значок === 'A', fresh);

  const untracked = await rowState('untracked.txt');
  check('новый файл помечен U', untracked?.значок === 'U', untracked);

  const src = await rowState('src');
  check(
    'у папки с правками есть точка и класс изменения',
    src?.точка !== null &&
      src?.точка !== undefined &&
      src.классы.some((item) => item.startsWith('is-') && item !== 'is-ignored' && item !== 'is-submodule'),
    src,
  );

  // Игнорируемое приглушается: файл виден, но помечен классом `is-ignored`.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'build',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(2500);
  const build = await rowState('build');
  check('игнорируемая папка приглушена', build?.классы.includes('is-ignored') === true, build);

  // Значок гаснет сам после коммита: правок больше нет.
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'все правки']);
  // Ждём наблюдатель за .git: он и пересчитывает статус после чужого коммита.
  await wait(3500);
  const afterCommit = await rowState('README.md');
  check(
    'после коммита пометка снята',
    afterCommit !== null && afterCommit.значок === null && !afterCommit.классы.includes('is-modified'),
    afterCommit,
  );

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[changes] ЕСТЬ ПАДЕНИЯ' : '[changes] всё сошлось');
  app.exit(failed ? 1 : 0);
});
