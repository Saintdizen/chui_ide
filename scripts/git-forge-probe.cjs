/**
 * Проба площадок: запросы на слияние и их обсуждение.
 *
 *   npm run probe:forge
 *
 * Юнит-тесты проверяют разбор (`tests/git-platform.test.ts`). Здесь — связка
 * целиком: настоящий `GitService` на настоящем репозитории зовёт клиента площадки
 * и разбирает его ответ. Клиент подменён (`scripts/fake-forge.cjs`): настоящее
 * `gh`/`glab` требует входа и сети, а проверяем мы свою половину — какие команды
 * уходят и что мы показываем. Тот же приём, что у `fake-lsp.cjs`.
 *
 * Проверяются обе площадки: GitHub (`gh`) и GitLab (`glab`) — у них разные команды
 * и разные формы ответа.
 *
 * Нужен собранный main (`npm run build:main`).
 */
const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitService } = require('../dist/main/git/git.js');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Запустить git и дождаться выхода: ошибку отдаём, а не бросаем. */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Шим клиента: притворяется `gh` или `glab`, а работу отдаёт общему фейку. */
async function makeShim(binDir, name, fakePath) {
  const file = path.join(binDir, name);
  await fs.writeFile(file, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakePath)});\n`);
  await fs.chmod(file, 0o755);
}

/** Репозиторий с удалённым адресом нужной площадки. */
async function makeRepo(root, url) {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'probe@example.com']);
  await git(root, ['config', 'user.name', 'Проба']);
  await fs.writeFile(path.join(root, 'README.md'), '# демо\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'первый коммит']);
  await git(root, ['remote', 'add', 'origin', url]);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-forge-'));
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fake = path.join(__dirname, 'fake-forge.cjs');
  await makeShim(binDir, 'gh', fake);
  await makeShim(binDir, 'glab', fake);

  const stateFile = path.join(dir, 'comments.log');
  const logFile = path.join(dir, 'calls.log');
  // Клиента зовём по имени — он должен находиться в PATH; так и делают настоящие
  // `gh`/`glab`. Лог и состояние фейк читает из окружения.
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.FORGE_STATE = stateFile;
  process.env.FORGE_LOG = logFile;

  const github = path.join(dir, 'github');
  const gitlab = path.join(dir, 'gitlab');
  await makeRepo(github, 'git@github.com:acme/web.git');
  await makeRepo(gitlab, 'git@gitlab.com:team/api.git');

  const service = new GitService(
    () => github,
    () => undefined,
  );
  const glService = new GitService(
    () => gitlab,
    () => undefined,
  );

  /* ── GitHub ────────────────────────────────────────────────────────────── */

  const info = await service.forgeInfo();
  check('площадка узнана по адресу', info.repo?.platform === 'github', info.repo);
  check('клиент — gh', info.cli === 'gh', info.cli);
  check('клиент найден', info.cliAvailable === true);
  check('вход выполнен', info.authenticated === true);
  check('список запросов разобран', info.requests.length === 1, info.requests.length);
  check('поля запроса на месте', info.requests[0]?.title === 'Добавить поиск', info.requests[0]);

  const comments = await service.forgeComments(12);
  check('комментарии прочитаны', comments.length === 1, comments);
  check(
    'автор и текст комментария',
    comments[0]?.author === 'ivan' && comments[0]?.body === 'Посмотрите тесты.',
    comments[0],
  );

  const after = await service.forgeComment(12, 'Смотрите тесты внимательнее.');
  check('отправка комментария прошла', after.length === 2, after.length);
  check('отправленный комментарий виден в списке', after[1]?.body === 'Смотрите тесты внимательнее.', after[1]);
  const saved = await fs.readFile(`${stateFile}.gh`, 'utf8');
  check('комментарий ушёл клиенту с текстом', saved.includes('Смотрите тесты внимательнее.'), saved.trim());

  /* ── GitLab ────────────────────────────────────────────────────────────── */

  const glInfo = await glService.forgeInfo();
  check('GitLab: площадка узнана', glInfo.repo?.platform === 'gitlab', glInfo.repo);
  check('GitLab: клиент — glab', glInfo.cli === 'glab', glInfo.cli);
  check('GitLab: список запросов разобран', glInfo.requests.length === 1, glInfo.requests.length);

  const glComments = await glService.forgeComments(7);
  // Системную заметку («Ветка обновлена») показывать не должны — это событие, не слова.
  check('GitLab: заметки прочитаны без системных', glComments.length === 1, glComments);
  check('GitLab: текст заметки', glComments[0]?.body === 'Готово.', glComments[0]);

  const glAfter = await glService.forgeComment(7, 'Спасибо, заберу.');
  check('GitLab: отправка заметки прошла', glAfter.length === 2, glAfter.length);

  /* ── задачи (issues) ───────────────────────────────────── */

  const issues = await service.forgeIssues();
  check('GitHub: задачи прочитаны', issues.length === 1, issues);
  check('GitHub: заголовок задачи', issues[0]?.title === 'Падает импорт', issues[0]);
  check('GitHub: состояние задачи', issues[0]?.state === 'open', issues[0]);

  const issueComments = await service.forgeIssueComments(3);
  check('GitHub: комментарии задачи прочитаны', issueComments.length === 1, issueComments);
  check('GitHub: текст комментария задачи', issueComments[0]?.body === 'Воспроизводится у меня.', issueComments[0]);

  const afterIssueComment = await service.forgeIssueComment(3, 'Проверяю на свежем коде.');
  check('GitHub: комментарий к задаче отправлен', afterIssueComment.length === 2, afterIssueComment.length);

  const created = await service.forgeIssueCreate({ title: 'Новая задача', body: 'Описание' });
  check('GitHub: создание задачи не уронило список', created.length === 1, created.length);

  const closed = await service.forgeIssueClose(3);
  check('GitHub: закрытие задачи вернуло список', closed.length === 1, closed.length);

  const glIssues = await glService.forgeIssues();
  check('GitLab: задачи прочитаны', glIssues.length === 1, glIssues);
  check('GitLab: заголовок задачи', glIssues[0]?.title === 'Медленный старт', glIssues[0]);

  /* ── какие команды ушли клиенту ────────────────────────────────────────── */

  const calls = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean);
  const has = (needle) => calls.some((line) => line.includes(needle));
  check('gh звали за списком', has('gh pr list'));
  check('gh звали за комментариями', has('gh pr view 12 --json comments'));
  check('gh отправил комментарий через --body', has('gh pr comment 12 --body'));
  check('glab читал заметки через api', has('glab api projects/:id/merge_requests/7/notes'));
  check('glab отправил заметку через mr note -m', has('glab mr note 7 -m'));
  check('gh звали за задачами', has('gh issue list'));
  check('gh звали за комментариями задачи', has('gh issue view 3 --json comments'));
  check('gh отправил комментарий задачи через --body', has('gh issue comment 3 --body'));
  check('gh создавал задачу', has('gh issue create'));
  check('gh закрывал задачу', has('gh issue close 3'));
  check('glab читал задачи', has('glab issue list'));

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] площадки: есть расхождения' : '[проба] запросы и комментарии работают');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[проба] сбой:', error);
  process.exit(1);
});
