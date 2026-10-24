import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';

/**
 * Заметки и список запросов на GitLab — вторая ветка тех же `forge*`.
 *
 * Код там не копия `gh`: у GitLab другой клиент (`glab`), другой JSON (`iid`,
 * `source_branch`, `work_in_progress`) и заметки берутся через `glab api`,
 * потому что своего `--json` у `glab mr view` нет. Без этих тестов вся ветка
 * была мёртвой для проверок: ошибка в ней видна только живьём, на чужой машине.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

let gitAvailable = true;

beforeAll(async () => {
  gitAvailable = await new Promise<boolean>((resolve) => {
    execFile('git', ['--version'], { cwd: os.tmpdir() }, (error) => resolve(!error));
  });
});

const stubSupported = process.platform !== 'win32';

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, () => resolve());
  });
}

async function withGlabScript(body: string): Promise<{ restore: () => void; calls: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-glab-stub-'));
  roots.push(dir);
  const calls = path.join(dir, 'calls.txt');
  await fs.writeFile(path.join(dir, 'glab'), `#!/bin/sh\necho "$@" >> "${calls}"\n${body}\n`, 'utf8');
  await fs.chmod(path.join(dir, 'glab'), 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  return {
    restore: () => {
      process.env.PATH = previous;
    },
    calls,
  };
}

async function makeRepo(): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-glab-repo-')));
  roots.push(base);
  const work = path.join(base, 'work');
  await fs.mkdir(work);
  await git(work, ['init', '-q', '--template=']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  // Windows по умолчанию держит autocrlf=true: без этой строки файлы из
  // рабочей папки приходят с \r\n, и тест сравнивает их с чистым \n.
  await git(work, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(work, 'a.txt'), 'x\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'init']);
  await git(work, ['remote', 'add', 'origin', 'git@gitlab.com:acme/web.git']);
  return work;
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

const MR_JSON = JSON.stringify([
  {
    iid: 9,
    title: 'Добавить фильтр',
    author: { username: 'ivan' },
    state: 'opened',
    source_branch: 'filter',
    target_branch: 'main',
    web_url: 'https://gitlab.com/acme/web/-/merge_requests/9',
    work_in_progress: true,
    updated_at: '2026-01-03T00:00:00Z',
  },
]);

describe('GitLab: ветка glab', () => {
  it('forgeInfo(): mr list разобран — iid, ветки, черновик', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGlabScript(`printf '%s' '${MR_JSON}'`);
    try {
      const info = await serviceFor(work).forgeInfo();
      expect(info.cli).toBe('glab');
      // Площадка — в repo.platform, а не в отдельном поле: я его сперва выдумал.
      expect(info.repo?.platform).toBe('gitlab');
      expect(info.requests).toHaveLength(1);
      expect(info.requests[0]).toMatchObject({
        number: 9,
        title: 'Добавить фильтр',
        author: 'ivan',
        state: 'draft',
        sourceBranch: 'filter',
      });
      expect(await fs.readFile(stub.calls, 'utf8')).toContain('mr list --output json');
    } finally {
      stub.restore();
    }
  });

  it('forgeComments(): заметки идут через glab api, а не mr view', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGlabScript(
      `case "$1" in\n  "mr") printf '%s' '${MR_JSON}';;\n  "api") printf '%s' '[{"author":{"username":"ivan"},"body":"беру","created_at":"2026-01-01T00:00:00Z"}]';;\n  *) exit 0;;\nesac`,
    );
    try {
      const comments = await serviceFor(work).forgeComments(9);
      const calls = await fs.readFile(stub.calls, 'utf8');
      // Своё `--json` у `glab mr view` отсутствует — идём через api.
      expect(calls).toContain('api projects/:id/merge_requests/9/notes?per_page=100');
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ author: 'ivan', body: 'беру' });
    } finally {
      stub.restore();
    }
  });

  it('forgeIssues(): задачи GitLab читаются своим разбором', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGlabScript(
      `case "$1" in\n  "mr") printf '%s' '${MR_JSON}';;\n  *) printf '%s' '[{"iid":4,"title":"Течь","author":{"username":"ivan"},"state":"opened","labels":["bug"],"web_url":"https://gitlab.com/acme/web/-/issues/4"}]';;\nesac`,
    );
    try {
      const issues = await serviceFor(work).forgeIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ number: 4, title: 'Течь' });
    } finally {
      stub.restore();
    }
  });
});
