/**
 * Проверка GitService на настоящем репозитории во временной папке: init, статус,
 * индексация, коммит, diff, откат, ветки.
 *
 *   npm run smoke:git
 *
 * Требует собранный main (npm run build:main) и git в PATH. Коммиты делаются
 * через переменные окружения — тест не зависит от настроек git на машине.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitService } = require('../dist/main/git/git.js');

const AUTHOR = 'Chui Smoke';
const EMAIL = 'chui@localhost';

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const write = (file, text) => fs.writeFile(file, text, 'utf8');

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-'));

  // Идентичность автора — через окружение: сервис наследует process.env.
  process.env.GIT_AUTHOR_NAME = AUTHOR;
  process.env.GIT_AUTHOR_EMAIL = EMAIL;
  process.env.GIT_COMMITTER_NAME = AUTHOR;
  process.env.GIT_COMMITTER_EMAIL = EMAIL;

  let root = dir;
  const published = [];
  const git = new GitService(
    () => root,
    (topic, payload) => {
      if (topic === 'git:changed') published.push(payload);
    },
  );

  const file = path.join(dir, 'notes.txt');

  try {
    const before = await git.status();
    check('папка вне репозитория распознана', before.repository === null && before.files.length === 0);

    const initialised = await git.init();
    check('init создаёт репозиторий', initialised.repository?.root === dir, initialised.repository?.branch);

    await write(file, 'первая строка\n');
    const untracked = await git.status();
    check(
      'новый файл помечен untracked',
      untracked.files.length === 1 && untracked.files[0].change === 'untracked',
      untracked.files[0]?.change,
    );

    const staged = await git.stage([file]);
    check(
      'stage переводит файл в индекс',
      staged.files[0]?.staged === true && staged.files[0]?.change === 'added',
      staged.files[0],
    );

    const commit = await git.commit('первый коммит');
    check('коммит возвращает хеш и заголовок', commit.hash.length >= 7 && commit.summary === 'первый коммит', commit);
    const clean = await git.status();
    check('после коммита правок нет', clean.files.length === 0 && clean.repository?.head === commit.hash);

    await write(file, 'первая строка\nвторая строка\n');
    const modified = await git.status();
    check(
      'правка в рабочем дереве помечена modified',
      modified.files[0]?.change === 'modified' &&
        modified.files[0]?.unstaged === true &&
        modified.files[0]?.staged === false,
      modified.files[0],
    );

    const worktreeDiff = await git.diff(file);
    check(
      'diff рабочего дерева сравнивает с коммитом',
      worktreeDiff.original === 'первая строка\n' && worktreeDiff.modified.includes('вторая строка'),
      { original: worktreeDiff.original.length, modified: worktreeDiff.modified.length },
    );

    // Индексируем вторую версию и правим файл ещё раз: теперь индекс и HEAD
    // различаются, и проверка понимает, с чем именно сравнивает diff.
    await git.stage([file]);
    await write(file, 'первая строка\nвторая строка\nтретья строка\n');

    const againstIndex = await git.diff(file);
    check(
      'diff рабочего дерева сравнивает с индексом, а не с HEAD',
      againstIndex.original.includes('вторая строка') &&
        !againstIndex.original.includes('третья') &&
        againstIndex.modified.includes('третья'),
      { original: JSON.stringify(againstIndex.original) },
    );

    const stagedDiff = await git.diff(file, true);
    check(
      'diff индекса сравнивает с HEAD',
      stagedDiff.original === 'первая строка\n' && stagedDiff.modified === 'первая строка\nвторая строка\n',
      { original: JSON.stringify(stagedDiff.original), modified: JSON.stringify(stagedDiff.modified) },
    );

    const afterDiscard = await git.discard([file]);
    check(
      'discard возвращает файл к HEAD',
      afterDiscard.files.length === 0,
      afterDiscard.files.map((f) => f.change),
    );
    const text = await fs.readFile(file, 'utf8');
    check('содержимое файла откатилось', text === 'первая строка\n', JSON.stringify(text));

    const branches = await git.branches();
    check(
      'список веток содержит текущую',
      branches.some((branch) => branch.current && !branch.remote),
      branches,
    );

    const created = await git.checkout('feature/smoke', true);
    check(
      'создание ветки переключает на неё',
      created.repository?.branch === 'feature/smoke',
      created.repository?.branch,
    );

    check('push-события отправляются', published.length >= 4, published.length);
  } catch (error) {
    failed = true;
    console.error('[chui] ошибка проверки:', error.message, error.details ?? '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    console.log(failed ? '[chui] GitService: есть расхождения' : '[chui] GitService работает');
    app.exit(failed ? 1 : 0);
  }
});
