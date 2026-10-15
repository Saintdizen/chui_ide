#!/usr/bin/env node
/**
 * Фейковый клиент площадки: `gh` и `glab` в одном лице.
 *
 * Нужен пробам (`npm run probe:forge`): настоящее `gh`/`glab` требует входа,
 * сети и установки, а проверить надо связку IDE с клиентом — какие аргументы
 * уходят и как разбирается ответ. Тот же приём, что у `fake-lsp.cjs` и
 * `fake-mcp.cjs`: проверяем свою половину, чужую подменяем.
 *
 * Кем быть — решает имя, которым его позвали (шим `gh` или `glab` ставит проба).
 * Общий «файл состояния» (`FORGE_STATE`) копит отправленные комментарии, а лог
 * вызовов (`FORGE_LOG`) — сами аргументы: по ним проба и сверяет команды.
 */
const fs = require('node:fs');
const path = require('node:path');

const cli = path.basename(process.argv[1] || '');
const args = process.argv.slice(2);
const stateFile = process.env.FORGE_STATE ? `${process.env.FORGE_STATE}.${cli}` : '';
const logFile = process.env.FORGE_LOG || '';

if (logFile) fs.appendFileSync(logFile, `${cli} ${args.join(' ')}\n`);

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Комментарии, накопленные в этом прогоне (то, что «человек уже написал»). */
const sentComments = () => {
  if (!stateFile || !fs.existsSync(stateFile)) return [];
  return fs
    .readFileSync(stateFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).body);
};

if (args[0] === '--version') {
  print(cli === 'glab' ? 'glab version 1.36.0' : 'gh version 2.40.0');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`Logged in to ${cli === 'glab' ? 'gitlab.com' : 'github.com'}\n`);
  process.exit(0);
}

const GH_REQUESTS = [
  {
    number: 12,
    title: 'Добавить поиск',
    author: { login: 'ivan' },
    state: 'OPEN',
    headRefName: 'feat/search',
    baseRefName: 'main',
    url: 'https://github.com/acme/web/pull/12',
    isDraft: false,
    updatedAt: '2024-05-01T10:00:00Z',
    labels: [{ name: 'enhancement' }],
  },
];

const GLAB_REQUESTS = [
  {
    iid: 7,
    title: 'Поправить сборку',
    author: { username: 'petr' },
    state: 'opened',
    source_branch: 'fix/build',
    target_branch: 'main',
    web_url: 'https://gitlab.com/team/api/-/merge_requests/7',
    draft: false,
    updated_at: '2024-05-02T09:00:00Z',
    labels: ['ci'],
  },
];

if (cli === 'gh') {
  if (args[0] === 'pr' && args[1] === 'list') {
    print(GH_REQUESTS);
    process.exit(0);
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    // Форма ответа `gh pr view --json comments`: объект с полем `comments`.
    print({
      comments: [
        { author: { login: 'ivan' }, body: 'Посмотрите тесты.', createdAt: '2024-05-01T11:00:00Z', url: '' },
        ...sentComments().map((body) => ({
          author: { login: 'you' },
          body,
          createdAt: '2024-05-01T12:00:00Z',
          url: '',
        })),
      ],
    });
    process.exit(0);
  }
  if (args[0] === 'pr' && args[1] === 'comment') {
    const body = flag('--body') ?? '';
    if (stateFile) fs.appendFileSync(stateFile, `${JSON.stringify({ body })}\n`);
    process.exit(0);
  }
  process.stderr.write(`fake gh: неизвестная команда: ${args.join(' ')}\n`);
  process.exit(1);
}

if (args[0] === 'mr' && args[1] === 'list') {
  print(GLAB_REQUESTS);
  process.exit(0);
}
if (args[0] === 'api') {
  // Форма ответа `glab api …/notes`: массив заметок плюс системное событие.
  print([
    { author: { username: 'petr' }, body: 'Готово.', created_at: '2024-05-02T09:00:00Z' },
    { author: { username: 'ci' }, body: 'Ветка обновлена', system: true },
    ...sentComments().map((body) => ({
      author: { username: 'you' },
      body,
      created_at: '2024-05-02T10:00:00Z',
    })),
  ]);
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'note') {
  const body = flag('-m') ?? '';
  if (stateFile) fs.appendFileSync(stateFile, `${JSON.stringify({ body })}\n`);
  process.exit(0);
}

process.stderr.write(`fake glab: неизвестная команда: ${args.join(' ')}\n`);
process.exit(1);
