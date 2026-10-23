import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';

/**
 * Успешные пути клиента площадки (`forge*`).
 *
 * `git-service.test.ts` держит отказы: клиента нет, площадка не узнана. А сборка
 * аргументов, разбор ответа и перечитывание списка после действия не исполнялись
 * ни разу. Клиент здесь — скрипт, который, как настоящий `gh`, смотрит на аргументы
 * и печатает JSON: тогда проверяется и то, ЧТО мы просим, и то, как понимаем ответ.
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

/**
 * Клиент `gh` как скрипт: пишет свои аргументы в `calls`, затем выполняет `body`.
 * Так видно не только ответ, но и запрос (какие флаги реально ушли).
 */
async function withGhScript(body: string): Promise<{ restore: () => void; calls: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-forge-stub-'));
  roots.push(dir);
  const calls = path.join(dir, 'calls.txt');
  const file = path.join(dir, 'gh');
  await fs.writeFile(file, `#!/bin/sh\necho "$@" >> "${calls}"\n${body}\n`, 'utf8');
  await fs.chmod(file, 0o755);
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
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-forge-repo-')));
  roots.push(base);
  const work = path.join(base, 'work');
  await fs.mkdir(work);
  await git(work, ['init', '-q']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  // Windows по умолчанию держит autocrlf=true: без этой строки файлы из
  // рабочей папки приходят с \r\n, и тест сравнивает их с чистым \n.
  await git(work, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(work, 'a.txt'), 'one\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'init']);
  await git(work, ['remote', 'add', 'origin', 'git@github.com:acme/web.git']);
  return work;
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

const LIST_JSON = JSON.stringify([
  {
    number: 7,
    title: 'Починить сборку',
    author: { login: 'octocat' },
    state: 'OPEN',
    headRefName: 'fix-build',
    baseRefName: 'main',
    url: 'https://github.com/acme/web/pull/7',
    isDraft: false,
    updatedAt: '2026-01-02T03:04:05Z',
    labels: [{ name: 'bug' }],
  },
]);

describe('площадка: успешные пути', () => {
  it('forgeInfo(): список запросов разобран, а не просто «клиент есть»', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(`printf '%s' '${LIST_JSON}'`);
    try {
      const info = await serviceFor(work).forgeInfo();
      expect(info.requests).toHaveLength(1);
      expect(info.requests[0]).toMatchObject({ number: 7, title: 'Починить сборку', author: 'octocat' });
      expect(info.note ?? '').toBe('');
    } finally {
      stub.restore();
    }
  });

  it('forgeCreate(): заголовок обрезан, тело ушло в --body, список перечитан', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `case "$1 $2" in\n  "pr create") exit 0;;\n  "pr list") printf '%s' '${LIST_JSON}';;\n  *) exit 0;;\nesac`,
    );
    try {
      const info = await serviceFor(work).forgeCreate({ title: '  Новая  ', body: 'текст' });
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('pr create --title Новая --body текст');
      expect(calls).not.toContain('--title   Новая');
      expect(info.requests).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('forgeCreate(): пустой заголовок — отказ ДО запуска клиента', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      await expect(serviceFor(work).forgeCreate({ title: '   ' })).rejects.toThrow(/заголовок/i);
      // Клиент до сбора запроса не доходит: проверка стоит до него.
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('pr create');
    } finally {
      stub.restore();
    }
  });

  it('forgeCheckout(): неверный номер — отказ без запуска', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      await expect(serviceFor(work).forgeCheckout(0)).rejects.toThrow(/номер/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('pr checkout');
    } finally {
      stub.restore();
    }
  });

  it('forgeCheckout(): зовёт pr checkout и обновляет состояние', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      const status = await serviceFor(work).forgeCheckout(7);
      expect(status).toBeTruthy();
      expect(await fs.readFile(stub.calls, 'utf8')).toContain('pr checkout 7');
    } finally {
      stub.restore();
    }
  });

  it('forgeComments(): читает обсуждение запроса', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `printf '%s' '{"comments":[{"author":{"login":"ann"},"body":"гляну","createdAt":"2026-01-01T00:00:00Z"}]}'`,
    );
    try {
      const comments = await serviceFor(work).forgeComments(7);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ author: 'ann', body: 'гляну' });
    } finally {
      stub.restore();
    }
  });

  it('forgeComment(): пустой текст — отказ до запуска клиента', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      await expect(serviceFor(work).forgeComment(7, '  ')).rejects.toThrow(/комментарий/i);
    } finally {
      stub.restore();
    }
  });

  it('forgeComment(): отправляет текст и ПЕРЕЧИТЫВАЕТ список, а не эхо', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `case "$1 $2" in\n  "pr comment") exit 0;;\n  *) printf '%s' '{"comments":[{"author":{"login":"ann"},"body":"готово"}]}';;\nesac`,
    );
    try {
      const comments = await serviceFor(work).forgeComment(7, 'готово');
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('pr comment 7 --body готово');
      expect(calls).toContain('pr view 7 --json comments');
      expect(comments).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('forgeIssues(): список задач разбирается', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `printf '%s' '[{"number":3,"title":"Течь","author":{"login":"ann"},"state":"OPEN","labels":[],"url":"https://github.com/acme/web/issues/3"}]'`,
    );
    try {
      const issues = await serviceFor(work).forgeIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ number: 3, title: 'Течь' });
    } finally {
      stub.restore();
    }
  });

  it('forgeIssueCreate(): заголовок задачи обрезан, --body пуст без тела', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `case "$1 $2 $3" in\n  "issue create --title") exit 0;;\n  "issue list --limit") printf '[]';;\n  *) printf '[]';;\nesac`,
    );
    try {
      const issues = await serviceFor(work).forgeIssueCreate({ title: '  Течь  ' });
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('issue create --title Течь --body');
      // Без тела тело всё равно передаётся пустой строкой: иначе клиент спросит интерактивно.
      expect(calls).toContain('--body');
      expect(issues).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('forgeIssueCreate(): пустой заголовок — отказ после узнавания площадки, но до создания', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      await expect(serviceFor(work).forgeIssueCreate({ title: ' ' })).rejects.toThrow(/заголовок задачи/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('issue create');
    } finally {
      stub.restore();
    }
  });

  it('forgeIssueClose(): номер проверен до запуска, затем список перечитан', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript("printf '[]'");
    try {
      await expect(serviceFor(work).forgeIssueClose(0)).rejects.toThrow(/номер/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('issue close');
      await serviceFor(work).forgeIssueClose(3);
      expect(await fs.readFile(stub.calls, 'utf8')).toContain('issue close 3');
    } finally {
      stub.restore();
    }
  });

  it('forgeIssueComments(): пустой комментарий не отправляется', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript('exit 0');
    try {
      await expect(serviceFor(work).forgeIssueComment(3, '   ')).rejects.toThrow(/пустой комментарий/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('issue comment');
    } finally {
      stub.restore();
    }
  });

  it('forgeIssueComment(): отправляет и перечитывает обсуждение', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `case "$1 $2" in\n  "issue comment") exit 0;;\n  *) printf '%s' '{"comments":[{"author":{"login":"ann"},"body":"да"}]}';;\nesac`,
    );
    try {
      const comments = await serviceFor(work).forgeIssueComment(3, 'да');
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('issue comment 3 --body да');
      expect(calls).toContain('issue view 3 --json comments');
      expect(comments).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('forgePipelines(): прогоны CI разобраны', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript(
      `printf '%s' '[{"databaseId":42,"displayTitle":"CI","status":"completed","conclusion":"success","headBranch":"main","event":"push","createdAt":"2026-01-01T00:00:00Z","url":"https://x"}]'`,
    );
    try {
      const runs = await serviceFor(work).forgePipelines();
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('run list --limit 20');
      expect(runs).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('forgePipelineRerun(): номер проверен до запуска', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript("printf '[]'");
    try {
      await expect(serviceFor(work).forgePipelineRerun(0)).rejects.toThrow(/номер/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('run rerun');
      await serviceFor(work).forgePipelineRerun(42);
      expect(await fs.readFile(stub.calls, 'utf8')).toContain('run rerun 42');
    } finally {
      stub.restore();
    }
  });

  it('forgeNotifications(): идёт в api своего репозитория и отдаёт пустой список без падения', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript("printf '[]'");
    try {
      const list = await serviceFor(work).forgeNotifications();
      const calls = await fs.readFile(stub.calls, 'utf8');
      expect(calls).toContain('api repos/acme/web/notifications?per_page=50');
      expect(list).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('forgeNotificationRead(): пустой id отвергнут до запроса', async () => {
    if (!gitAvailable || !stubSupported) return;
    const work = await makeRepo();
    const stub = await withGhScript("printf '[]'");
    try {
      await expect(serviceFor(work).forgeNotificationRead('   ')).rejects.toThrow(/уведомлен/i);
      expect(await fs.readFile(stub.calls, 'utf8')).not.toContain('PATCH');
    } finally {
      stub.restore();
    }
  });
});
