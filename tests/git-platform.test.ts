import { describe, expect, it } from 'vitest';
import {
  branchesLabel,
  cliFor,
  forgeRepo,
  newRequestWebUrl,
  openRequestCount,
  parseGhRequests,
  parseGlabRequests,
  parseRemoteUrl,
  platformLabel,
  platformOf,
  requestForBranch,
  requestLabel,
  requestWebUrl,
  requestWord,
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
