import { describe, expect, it } from 'vitest';
import {
  activePipelineCount,
  branchesLabel,
  cliFor,
  failedPipelineCount,
  forgeRepo,
  issueLabel,
  issueWebUrl,
  newIssueWebUrl,
  newRequestWebUrl,
  openIssueCount,
  openRequestCount,
  parseGhComments,
  parseGhIssues,
  parseGhNotifications,
  parseGhRequests,
  parseGhRuns,
  parseGlabComments,
  parseGlabIssues,
  parseGlabPipelines,
  parseGlabRequests,
  parseGlabTodos,
  parseRemoteUrl,
  pipelineActive,
  platformLabel,
  platformOf,
  requestForBranch,
  requestLabel,
  requestWebUrl,
  requestWord,
  unreadNotificationCount,
} from '../src/shared/git-platform';

/**
 * Площадка и запросы на слияние. Разбор адресов — самая частая причина ошибок:
 * один и тот же репозиторий задают и https, и ssh, и ssh-с-протоколом, а у GitLab
 * пространство имён бывает вложенным. Проверяем все виды.
 */
describe('parseRemoteUrl', () => {
  it('https-адрес', () => {
    expect(parseRemoteUrl('https://github.com/acme/web.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'web',
    });
  });

  it('https без .git и с хвостовым слэшем', () => {
    expect(parseRemoteUrl('https://github.com/acme/web/')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' });
  });

  it('ssh-вид с двоеточием', () => {
    expect(parseRemoteUrl('git@github.com:acme/web.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' });
  });

  it('ssh:// с портом', () => {
    expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/project.git')).toEqual({
      host: 'gitlab.example.com',
      owner: 'group/sub',
      repo: 'project',
    });
  });

  it('у GitLab пространство имён вложенное', () => {
    expect(parseRemoteUrl('https://gitlab.com/team/backend/api.git')?.owner).toBe('team/backend');
  });

  it('хост приводится к нижнему регистру', () => {
    expect(parseRemoteUrl('https://GitHub.com/Acme/Web.git')?.host).toBe('github.com');
  });

  it('пустое и мусор — null', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('просто строка')).toBeNull();
    expect(parseRemoteUrl('https://github.com/acme')).toBeNull();
  });
});

describe('platformOf', () => {
  it('известные площадки', () => {
    expect(platformOf('github.com')).toBe('github');
    expect(platformOf('gitlab.com')).toBe('gitlab');
    expect(platformOf('bitbucket.org')).toBe('bitbucket');
  });

  it('свой GitLab узнаётся по имени', () => {
    expect(platformOf('gitlab.example.com')).toBe('gitlab');
    expect(platformOf('code.gitlab.internal')).toBe('gitlab');
  });

  it('незнакомый хост — other, а не отказ', () => {
    expect(platformOf('gitea.example.com')).toBe('other');
  });
});

describe('forgeRepo', () => {
  it('даёт и площадку, и адрес', () => {
    expect(forgeRepo('git@gitlab.com:team/api.git')).toEqual({
      platform: 'gitlab',
      host: 'gitlab.com',
      owner: 'team',
      repo: 'api',
    });
  });

  it('неразобранный адрес — null', () => {
    expect(forgeRepo('не url')).toBeNull();
  });
});

describe('подписи и клиенты', () => {
  it('названия площадок и запросов', () => {
    expect(platformLabel('github')).toBe('GitHub');
    expect(platformLabel('other')).toBe('репозиторий');
    expect(requestWord('github')).toBe('pull request');
    expect(requestWord('gitlab')).toBe('merge request');
  });

  it('клиент есть только у GitHub и GitLab', () => {
    expect(cliFor('github')).toBe('gh');
    expect(cliFor('gitlab')).toBe('glab');
    expect(cliFor('bitbucket')).toBeNull();
    expect(cliFor('other')).toBeNull();
  });
});

describe('адреса веб-страниц', () => {
  const github = { platform: 'github' as const, host: 'github.com', owner: 'acme', repo: 'web' };
  const gitlab = { platform: 'gitlab' as const, host: 'gitlab.com', owner: 'team/api', repo: 'web' };

  it('страница запроса', () => {
    expect(requestWebUrl(github, 12)).toBe('https://github.com/acme/web/pull/12');
    expect(requestWebUrl(gitlab, 12)).toBe('https://gitlab.com/team/api/web/-/merge_requests/12');
  });

  it('страница создания: у GitHub это compare', () => {
    expect(newRequestWebUrl(github, 'feat/x', 'main')).toBe(
      'https://github.com/acme/web/compare/main...feat%2Fx?expand=1',
    );
  });

  it('страница создания: у GitLab отдельная с параметрами', () => {
    const url = newRequestWebUrl(gitlab, 'feat', 'main');
    expect(url).toContain('/-/merge_requests/new');
    expect(url).toContain('source_branch%5D=feat');
    expect(url).toContain('target_branch%5D=main');
  });
});

describe('parseGhRequests', () => {
  const json = JSON.stringify([
    {
      number: 12,
      title: 'Добавить поиск',
      author: { login: 'ivan' },
      state: 'OPEN',
      headRefName: 'feat/search',
      baseRefName: 'main',
      url: 'https://github.com/acme/web/pull/12',
      isDraft: true,
      updatedAt: '2024-05-01T10:00:00Z',
      labels: [{ name: 'enhancement' }, { name: 'ui' }],
    },
  ]);

  it('читает запрос со всеми полями', () => {
    const [request] = parseGhRequests(json);
    expect(request).toMatchObject({
      number: 12,
      title: 'Добавить поиск',
      author: 'ivan',
      sourceBranch: 'feat/search',
      targetBranch: 'main',
      url: 'https://github.com/acme/web/pull/12',
      updatedAt: '2024-05-01T10:00:00Z',
      labels: ['enhancement', 'ui'],
    });
  });

  it('черновик помечается состоянием draft', () => {
    expect(parseGhRequests(json)[0]?.state).toBe('draft');
  });

  it('слитая и закрытая берутся из состояния', () => {
    const merged = JSON.stringify([{ number: 1, state: 'MERGED' }]);
    expect(parseGhRequests(merged)[0]?.state).toBe('merged');
    const closed = JSON.stringify([{ number: 2, state: 'CLOSED' }]);
    expect(parseGhRequests(closed)[0]?.state).toBe('closed');
  });

  it('запись без номера пропускается', () => {
    expect(parseGhRequests(JSON.stringify([{ title: 'без номера' }, { number: 0 }]))).toEqual([]);
  });

  it('битый json даёт пустой список', () => {
    expect(parseGhRequests('не json')).toEqual([]);
    expect(parseGhRequests('{}')).toEqual([]);
  });
});

describe('parseGlabRequests', () => {
  const json = JSON.stringify([
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
  ]);

  it('читает merge request со всеми полями', () => {
    const [request] = parseGlabRequests(json);
    expect(request).toMatchObject({
      number: 7,
      title: 'Поправить сборку',
      author: 'petr',
      state: 'open',
      sourceBranch: 'fix/build',
      targetBranch: 'main',
      labels: ['ci'],
    });
  });

  it('черновик помечается state draft', () => {
    expect(parseGlabRequests(JSON.stringify([{ iid: 1, draft: true }]))[0]?.state).toBe('draft');
  });

  it('закрытый по state', () => {
    expect(parseGlabRequests(JSON.stringify([{ iid: 1, state: 'closed' }]))[0]?.state).toBe('closed');
  });

  it('без номера — пропуск, битый json — пусто', () => {
    expect(parseGlabRequests(JSON.stringify([{ title: 'x' }]))).toEqual([]);
    expect(parseGlabRequests('[]')).toEqual([]);
  });
});

describe('подписи запроса', () => {
  const request = {
    number: 12,
    title: 'Добавить поиск',
    author: 'ivan',
    state: 'open' as const,
    sourceBranch: 'feat',
    targetBranch: 'main',
    url: '',
    updatedAt: '',
    labels: [],
  };

  it('подпись запроса и ветвей', () => {
    expect(requestLabel(request)).toBe('#12 Добавить поиск');
    expect(branchesLabel(request)).toBe('feat → main');
  });

  it('черновик помечен словом', () => {
    expect(requestLabel({ ...request, state: 'draft' })).toBe('черновик · #12 Добавить поиск');
  });

  it('открытых считаем вместе с черновиками', () => {
    const requests = [
      { ...request, number: 1, state: 'open' as const },
      { ...request, number: 2, state: 'draft' as const },
      { ...request, number: 3, state: 'merged' as const },
      { ...request, number: 4, state: 'closed' as const },
    ];
    expect(openRequestCount(requests)).toBe(2);
  });

  it('запрос для ветки ищется среди незакрытых', () => {
    const requests = [
      { ...request, number: 1, sourceBranch: 'feat', state: 'merged' as const },
      { ...request, number: 2, sourceBranch: 'feat', state: 'open' as const },
    ];
    expect(requestForBranch(requests, 'feat')?.number).toBe(2);
    expect(requestForBranch(requests, 'нет-такой')).toBeNull();
  });
});

describe('parseGhComments', () => {
  const json = JSON.stringify({
    comments: [
      {
        author: { login: 'ivan' },
        body: 'Поправьте тесты, пожалуйста.',
        createdAt: '2024-05-01T11:00:00Z',
        url: 'https://github.com/acme/web/pull/12#issuecomment-1',
      },
      { author: { login: 'petr' }, body: '', createdAt: '2024-05-01T12:00:00Z' },
    ],
  });

  it('читает комментарии и пропускает пустые', () => {
    const comments = parseGhComments(json);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      author: 'ivan',
      body: 'Поправьте тесты, пожалуйста.',
      createdAt: '2024-05-01T11:00:00Z',
      url: 'https://github.com/acme/web/pull/12#issuecomment-1',
    });
  });

  it('принимает и голый массив — версии печатают по-разному', () => {
    const comments = parseGhComments(JSON.stringify([{ author: { login: 'x' }, body: 'привет' }]));
    expect(comments[0]).toMatchObject({ author: 'x', body: 'привет' });
  });

  it('битый json и чужой формат дают пусто', () => {
    expect(parseGhComments('не json')).toEqual([]);
    expect(parseGhComments('{"comments": 5}')).toEqual([]);
    expect(parseGhComments('[]')).toEqual([]);
  });

  it('автор без login не роняет разбор', () => {
    expect(parseGhComments(JSON.stringify([{ author: {}, body: 'текст' }]))[0]?.author).toBe('');
  });
});

describe('parseGlabComments', () => {
  const json = JSON.stringify([
    { author: { username: 'petr' }, body: 'Готово.', created_at: '2024-05-02T09:00:00Z' },
    { author: { username: 'ci' }, body: 'Ветка обновлена', system: true },
    { author: { username: 'ivan' }, note: 'Через поле note тоже бывает.' },
  ]);

  it('читает заметки, а системные события пропускает', () => {
    const comments = parseGlabComments(json);
    expect(comments.map((comment) => comment.author)).toEqual(['petr', 'ivan']);
    expect(comments[0]).toEqual({
      author: 'petr',
      body: 'Готово.',
      createdAt: '2024-05-02T09:00:00Z',
      url: '',
    });
  });

  it('текст берётся и из поля note', () => {
    expect(parseGlabComments(json)[1]?.body).toBe('Через поле note тоже бывает.');
  });

  it('без текста запись пропускается, битый json даёт пусто', () => {
    expect(parseGlabComments(JSON.stringify([{ author: { username: 'x' } }]))).toEqual([]);
    expect(parseGlabComments('мусор')).toEqual([]);
  });
});

describe('parseGhIssues', () => {
  const json = JSON.stringify([
    {
      number: 3,
      title: 'Импорт',
      author: { login: 'ivan' },
      state: 'OPEN',
      url: 'https://github.com/acme/web/issues/3',
      labels: [{ name: 'bug' }],
    },
  ]);

  it('читает задачу', () => {
    expect(parseGhIssues(json)[0]).toMatchObject({
      number: 3,
      title: 'Импорт',
      author: 'ivan',
      state: 'open',
      labels: ['bug'],
    });
  });

  it('битый json даёт пусто', () => {
    expect(parseGhIssues('не json')).toEqual([]);
  });
});

describe('parseGlabIssues', () => {
  const json = JSON.stringify([
    {
      iid: 9,
      title: 'Старт',
      author: { username: 'petr' },
      state: 'opened',
      web_url: 'https://gitlab.com/t/a/-/issues/9',
      labels: ['perf'],
    },
  ]);

  it('читает задачу', () => {
    expect(parseGlabIssues(json)[0]).toMatchObject({
      number: 9,
      title: 'Старт',
      author: 'petr',
      state: 'open',
      labels: ['perf'],
    });
  });

  it('битый json даёт пусто', () => {
    expect(parseGlabIssues('мусор')).toEqual([]);
  });
});

describe('адреса и подписи задач', () => {
  const github = { platform: 'github' as const, host: 'github.com', owner: 'acme', repo: 'web' };
  const gitlab = { platform: 'gitlab' as const, host: 'gitlab.com', owner: 'team/api', repo: 'web' };

  it('страница задачи', () => {
    expect(issueWebUrl(github, 3)).toBe('https://github.com/acme/web/issues/3');
    expect(issueWebUrl(gitlab, 3)).toBe('https://gitlab.com/team/api/web/-/issues/3');
  });

  it('страница создания: у GitLab отдельная', () => {
    expect(newIssueWebUrl(github)).toBe('https://github.com/acme/web/issues/new');
    expect(newIssueWebUrl(gitlab)).toBe('https://gitlab.com/team/api/web/-/issues/new');
  });

  it('подпись задачи и число открытых', () => {
    const issues = [
      { number: 1, title: 'Первая', author: '', state: 'open' as const, url: '', updatedAt: '', labels: [] },
      { number: 2, title: 'Вторая', author: '', state: 'closed' as const, url: '', updatedAt: '', labels: [] },
    ];
    expect(issueLabel(issues[0]!)).toBe('#1 Первая');
    expect(openIssueCount(issues)).toBe(1);
  });
});

describe('parseGhRuns', () => {
  const json = JSON.stringify([
    {
      databaseId: 42,
      displayTitle: 'CI',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      event: 'push',
      createdAt: '2024-05-01T10:00:00Z',
      url: 'https://github.com/acme/web/actions/runs/42',
    },
    { databaseId: 43, status: 'in_progress', conclusion: '', headBranch: 'feat', event: 'pull_request' },
  ]);

  it('завершённый берёт состояние из conclusion', () => {
    expect(parseGhRuns(json)[0]).toMatchObject({
      id: 42,
      title: 'CI',
      branch: 'main',
      event: 'push',
      state: 'success',
      url: 'https://github.com/acme/web/actions/runs/42',
    });
  });

  it('незавершённый берёт состояние из status', () => {
    expect(parseGhRuns(json)[1]?.state).toBe('running');
  });

  it('провал из conclusion', () => {
    const failed = JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure' }]);
    expect(parseGhRuns(failed)[0]?.state).toBe('failed');
  });

  it('без id — пропуск, битый json — пусто', () => {
    expect(parseGhRuns(JSON.stringify([{ displayTitle: 'x' }]))).toEqual([]);
    expect(parseGhRuns('не json')).toEqual([]);
  });
});

describe('parseGlabPipelines', () => {
  const json = JSON.stringify([
    { id: 100, status: 'success', source: 'push', ref: 'main' },
    { id: 101, status: 'failed', source: 'merge_request_event', ref: 'fix/build' },
    { id: 102, status: 'running', ref: '', name: 'Сборка' },
  ]);

  it('читает прогон из status и ref', () => {
    expect(parseGlabPipelines(json)[0]).toMatchObject({
      id: 100,
      title: 'main',
      branch: 'main',
      event: 'push',
      state: 'success',
    });
  });

  it('провал и ветка из ref', () => {
    expect(parseGlabPipelines(json)[1]).toMatchObject({ state: 'failed', branch: 'fix/build' });
  });

  it('имя идёт в заголовок', () => {
    expect(parseGlabPipelines(json)[2]).toMatchObject({ title: 'Сборка', state: 'running' });
  });

  it('запись без id и не-объект пропускаются, пустые поля не роняют разбор', () => {
    expect(parseGlabPipelines(JSON.stringify([{ status: 'success' }, 5, null]))).toEqual([]);
    // Есть только id и status: остальное пустое, но прогон читается.
    expect(parseGlabPipelines(JSON.stringify([{ id: 3, status: 'success' }]))[0]).toMatchObject({
      id: 3,
      title: '',
      branch: '',
      url: '',
      createdAt: '',
    });
  });
});

describe('состояние и счётчики прогонов', () => {
  const run = (
    state: 'running' | 'success' | 'failed' | 'pending' | 'canceled' | 'skipped' | 'unknown',
  ): Parameters<typeof pipelineActive>[0] => ({
    id: 1,
    title: '',
    branch: '',
    event: '',
    state,
    url: '',
    createdAt: '',
  });

  it('активны только идущие и в очереди', () => {
    expect(pipelineActive(run('running'))).toBe(true);
    expect(pipelineActive(run('pending'))).toBe(true);
    expect(pipelineActive(run('success'))).toBe(false);
    expect(pipelineActive(run('failed'))).toBe(false);
  });

  it('счётчики активных и проваленных', () => {
    const runs = [run('running'), run('pending'), run('failed'), run('failed'), run('success')];
    expect(activePipelineCount(runs)).toBe(2);
    expect(failedPipelineCount(runs)).toBe(2);
  });

  it('словари площадок сведены к одному состоянию', () => {
    // `pipelineStateOf` не экспортирован — проверяем через разбор ответов.
    const glab = (status: string): string | undefined =>
      parseGlabPipelines(JSON.stringify([{ id: 1, status, ref: 'main' }]))[0]?.state;
    expect(glab('success')).toBe('success');
    expect(glab('failed')).toBe('failed');
    expect(glab('canceled')).toBe('canceled');
    expect(glab('skipped')).toBe('skipped');
    expect(glab('running')).toBe('running');
    // Очередь у GitLab называется по-разному: все эти слова — «в очереди».
    for (const status of ['pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled']) {
      expect(glab(status), status).toBe('pending');
    }
    // Незнакомое слово не выдумываем: «неизвестно», а не «открыт».
    expect(glab('нет-такого')).toBe('unknown');
  });

  it('слова GitHub узнаются и в conclusion, и в status', () => {
    const state = (value: Record<string, unknown>): string | undefined =>
      parseGhRuns(JSON.stringify([{ databaseId: 1, ...value }]))[0]?.state;
    // `timed_out` и `action_required` — это провал, а не «что-то своё».
    expect(state({ status: 'completed', conclusion: 'timed_out' })).toBe('failed');
    expect(state({ status: 'completed', conclusion: 'action_required' })).toBe('failed');
    // Ещё не завершён: смотрим сам status, в том числе очередь и отмену.
    expect(state({ status: 'queued', conclusion: '' })).toBe('pending');
    expect(state({ status: 'requested', conclusion: '' })).toBe('pending');
    expect(state({ status: 'waiting', conclusion: '' })).toBe('pending');
    expect(state({ status: 'cancelled', conclusion: '' })).toBe('canceled');
    expect(state({ status: 'skipped', conclusion: '' })).toBe('skipped');
  });
});

describe('parseGhNotifications', () => {
  const json = JSON.stringify([
    {
      id: '9001',
      unread: true,
      reason: 'review_requested',
      updated_at: '2024-05-05T08:00:00Z',
      subject: {
        title: 'Добавить поиск',
        type: 'PullRequest',
        url: 'https://api.github.com/repos/acme/web/pulls/12',
      },
    },
    { id: '9002', unread: false, reason: 'subscribed', subject: { title: 'Падает импорт', type: 'Issue' } },
  ]);

  it('читает уведомление и переводит адрес в страницу', () => {
    expect(parseGhNotifications(json)[0]).toEqual({
      id: '9001',
      title: 'Добавить поиск',
      kind: 'pull request',
      reason: 'review_requested',
      unread: true,
      updatedAt: '2024-05-05T08:00:00Z',
      url: 'https://github.com/acme/web/pulls/12',
    });
  });

  it('прочитанное отмечено как прочитанное', () => {
    expect(parseGhNotifications(json)[1]?.unread).toBe(false);
  });

  it('без id — пропуск, битый json — пусто', () => {
    expect(parseGhNotifications(JSON.stringify([{ unread: true }]))).toEqual([]);
    expect(parseGhNotifications('не json')).toEqual([]);
    // Не-объект в массиве тоже пропускаем.
    expect(parseGhNotifications(JSON.stringify([5, null, 'строка']))).toEqual([]);
  });

  it('пропавшие поля не роняют разбор', () => {
    // Есть id, но нет ни subject, ни reason: заголовок и вид пустые, ссылки нет.
    const sparse = parseGhNotifications(JSON.stringify([{ id: 7 }]));
    expect(sparse[0]).toMatchObject({ id: '7', title: '', kind: '', reason: '', url: '', unread: false });
  });
});

describe('parseGlabTodos', () => {
  const json = JSON.stringify([
    {
      id: 7001,
      action_name: 'mentioned',
      target_type: 'Issue',
      state: 'pending',
      created_at: '2024-05-06T08:00:00Z',
      target: { title: 'Медленный старт', web_url: 'https://gitlab.com/team/api/-/issues/9' },
      project: { path_with_namespace: 'team/api' },
    },
    {
      id: 7002,
      action_name: 'assigned',
      target_type: 'MergeRequest',
      state: 'done',
      target: { title: 'Чужая', web_url: '' },
      project: { path_with_namespace: 'other/proj' },
    },
  ]);

  it('дела своего проекта, чужой отброшен', () => {
    const todos = parseGlabTodos(json, 'team/api');
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ id: '7001', title: 'Медленный старт', kind: 'issue', unread: true });
  });

  it('без пути проекта ничего не отбрасываем', () => {
    expect(parseGlabTodos(json)).toHaveLength(2);
  });

  it('закрытое дело — не ждёт внимания', () => {
    expect(parseGlabTodos(json)[1]?.unread).toBe(false);
  });

  it('запись без id и не-объект пропускаются', () => {
    expect(parseGlabTodos(JSON.stringify([{ project: { path_with_namespace: 'team/api' } }, 5, null]))).toEqual([]);
  });

  it('дело без проекта не отбрасывается даже при заданном пути', () => {
    // Путь проекта может не прийти — тогда лучше показать лишнее, чем промолчать.
    const noProject = JSON.stringify([{ id: 1, target: { title: 'Без проекта' } }]);
    expect(parseGlabTodos(noProject, 'team/api')).toHaveLength(1);
  });

  it('пропавшие поля не роняют разбор', () => {
    // Нет `target` (не объект) и нет `web_url` — заголовок и адрес пустые, дело читается.
    const sparse = JSON.stringify([{ id: 5, project: { path_with_namespace: 'team/api' } }]);
    expect(parseGlabTodos(sparse, 'team/api')[0]).toMatchObject({ id: '5', title: '', url: '', unread: true });
  });
});

describe('unreadNotificationCount', () => {
  it('считает только ждущие внимания', () => {
    const note = (unread) => ({ id: '1', title: '', kind: '', reason: '', unread, updatedAt: '', url: '' });
    expect(unreadNotificationCount([note(true), note(false), note(true)])).toBe(2);
  });
});
