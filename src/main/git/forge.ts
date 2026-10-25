import type { ForgeComment, ForgeInfo, ForgeIssue, ForgeNotification, ForgePipeline } from '../../shared/git-platform';
import {
  cliFor,
  forgeRepo,
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
} from '../../shared/git-platform';
import { NETWORK_TIMEOUT_MS, runForge } from './exec';
import { RpcErrorCode, type GitRemote, type GitStatus } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Что модулю нужно от `GitService`: три готовых ответа и один корень. Больше ничего —
 * отсюда он и вынесен без параметров-структур на 15 полей.
 */
export interface ForgeContext {
  root(): string;
  repositoryRoot(explicit?: string): Promise<string | null>;
  remotes(): Promise<GitRemote[]>;
  refresh(): Promise<GitStatus>;
}

export async function forgeInfo(ctx: ForgeContext, remote?: string): Promise<ForgeInfo> {
  const empty: ForgeInfo = {
    repo: null,
    remote: '',
    cli: null,
    cliAvailable: false,
    authenticated: false,
    requests: [],
    note: '',
  };

  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return { ...empty, note: 'Это не репозиторий git' };

  const remotes = await ctx.remotes();
  if (remotes.length === 0) return { ...empty, note: 'У репозитория нет удалённых адресов' };
  const picked = remote ? remotes.find((item) => item.name === remote) : remotes.find((item) => item.name === 'origin');
  const chosen = picked ?? remotes[0]!;
  const repo = forgeRepo(chosen.pushUrl || chosen.fetchUrl);
  if (!repo) {
    return { ...empty, remote: chosen.name, note: `Не разобрал адрес удалённого репозитория: ${chosen.fetchUrl}` };
  }

  const cli = cliFor(repo.platform);
  const info: ForgeInfo = { ...empty, repo, remote: chosen.name, cli };
  if (!cli) {
    info.note = `Для площадки ${repo.host} консольного клиента нет — откройте запросы в браузере`;
    return info;
  }

  // Клиент есть? Спрашиваем версию: так проверка не зависит от того, куда он поставлен.
  const version = await runForge(cli, ['--version'], repoRoot);
  if (!version.ok) {
    info.note = `Клиент ${cli} не найден в системе — поставьте его, чтобы видеть ${'запросы на слияние'}`;
    return info;
  }
  info.cliAvailable = true;

  // Вход в аккаунт: без него клиент не покажет чужие приватные запросы, но публичные
  // иногда покажет. Если входа нет — так и скажем, а список оставим пустым.
  const auth = await runForge(cli, ['auth', 'status'], repoRoot);
  info.authenticated = auth.ok;

  const listing =
    cli === 'gh'
      ? await runForge(
          'gh',
          [
            'pr',
            'list',
            '--limit',
            '40',
            '--json',
            'number,title,author,state,headRefName,baseRefName,url,isDraft,updatedAt,labels',
          ],
          repoRoot,
        )
      : await runForge('glab', ['mr', 'list', '--output', 'json', '--per-page', '40'], repoRoot);

  if (!listing.ok) {
    info.note = listing.stderr.trim() || listing.stdout.trim() || `Клиент ${cli} не смог получить список`;
    return info;
  }
  info.requests = cli === 'gh' ? parseGhRequests(listing.stdout) : parseGlabRequests(listing.stdout);
  return info;
}

/**
 * Создать запрос на слияние из текущей (или названной) ветки. Черновик — флагом
 * клиента; тексты передаём как есть, а площадка сама дополнит шаблоном.
 */
export async function forgeCreate(
  ctx: ForgeContext,
  options: {
    title: string;
    body?: string;
    target?: string;
    draft?: boolean;
    source?: string;
  },
): Promise<ForgeInfo> {
  const repoRoot = await ctx.root();
  const info = await forgeInfo(ctx);
  if (!info.repo || !info.cli) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
  }
  if (!info.cliAvailable) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
  }
  const title = options.title.trim();
  if (title === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Нужен заголовок запроса');

  const args =
    info.cli === 'gh'
      ? ['pr', 'create', '--title', title, ...(options.body ? ['--body', options.body] : ['--body', ''])]
      : ['mr', 'create', '--title', title, ...(options.body ? ['--description', options.body] : []), '--yes'];
  if (options.target)
    args.push(...(info.cli === 'gh' ? ['--base', options.target] : ['--target-branch', options.target]));
  if (options.source)
    args.push(...(info.cli === 'gh' ? ['--head', options.source] : ['--source-branch', options.source]));
  if (options.draft) args.push('--draft');

  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент отказался создавать запрос',
    );
  }
  return forgeInfo(ctx, info.remote);
}

/**
 * Забрать ветку запроса в рабочий каталог: клиент сам делает fetch и переключает
 * ветку. После этого состояние репозитория изменилось — обновляем его.
 */
export async function forgeCheckout(ctx: ForgeContext, number: number): Promise<GitStatus> {
  const repoRoot = await ctx.root();
  const info = await forgeInfo(ctx);
  if (!info.repo || !info.cli) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
  }
  if (!info.cliAvailable) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
  }
  const n = Math.floor(number);
  if (!Number.isFinite(n) || n <= 0) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Неверный номер запроса');
  const args = info.cli === 'gh' ? ['pr', 'checkout', String(n)] : ['mr', 'checkout', String(n)];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Не удалось забрать ветку запроса',
    );
  }
  return ctx.refresh();
}

/**
 * Комментарии запроса: что люди написали в обсуждении.
 *
 * Читаем их тем же клиентом, что и список: он же знает и вход, и доступ к
 * приватному репозиторию. У GitHub это `gh pr view --json comments`, у GitLab —
 * заметки запроса через `glab api`. Свой разговор с API тут не заводим: он
 * потянул бы за собой токены и слой авторизации, а это осознанно оставлено
 * клиенту площадки.
 */
export async function forgeComments(ctx: ForgeContext, number: number): Promise<ForgeComment[]> {
  const repoRoot = await ctx.root();
  const info = await forgeInfo(ctx);
  if (!info.repo || !info.cli) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
  }
  if (!info.cliAvailable) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
  }
  const n = requireRequestNumber(number);

  // У GitLab заметки берём через `glab api`: своего `--json` у `glab mr view` нет.
  // `:id` клиент заменяет на идентификатор текущего проекта.
  const args =
    info.cli === 'gh'
      ? ['pr', 'view', String(n), '--json', 'comments']
      : ['api', `projects/:id/merge_requests/${n}/notes?per_page=100`];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент не смог получить комментарии',
    );
  }
  return info.cli === 'gh' ? parseGhComments(result.stdout) : parseGlabComments(result.stdout);
}

/**
 * Написать комментарий к запросу. Возвращаем обновлённый список, а не «ок»:
 * окно и так перерисовывает обсуждение, и второй запрос ему ни к чему.
 */
export async function forgeComment(ctx: ForgeContext, number: number, body: string): Promise<ForgeComment[]> {
  const repoRoot = await ctx.root();
  const info = await forgeInfo(ctx);
  if (!info.repo || !info.cli) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
  }
  if (!info.cliAvailable) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
  }
  const n = requireRequestNumber(number);
  const text = body.trim();
  if (text === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой комментарий');

  const args = info.cli === 'gh' ? ['pr', 'comment', String(n), '--body', text] : ['mr', 'note', String(n), '-m', text];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент отказался отправить комментарий',
    );
  }
  // Список читаем заново, а не приписываем отправленное к прежнему: у клиента
  // может быть своё форматирование, и «эхо» разошлось бы с тем, что на площадке.
  return forgeComments(ctx, n);
}

/**
 * Задачи площадки (issues): список открытых и закрытых вместе.
 *
 * Понятие есть и на GitHub, и на GitLab, и читается тем же клиентом, что и
 * запросы на слияние. Общей модели хватит: номер, заголовок, автор, состояние,
 * метки. GitHub отдаёт `gh issue list --state all`, GitLab — `glab issue list`.
 */
export async function forgeIssues(ctx: ForgeContext): Promise<ForgeIssue[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const args =
    info.cli === 'gh'
      ? ['issue', 'list', '--limit', '40', '--state', 'all', '--json', 'number,title,author,state,url,updatedAt,labels']
      : ['issue', 'list', '--output', 'json', '--per-page', '40'];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || `Клиент ${info.cli} не смог получить список задач`,
    );
  }
  return info.cli === 'gh' ? parseGhIssues(result.stdout) : parseGlabIssues(result.stdout);
}

/**
 * Создать задачу. Тексты передаём как есть, а площадка сама дополнит шаблоном.
 * Возвращаем обновлённый список, чтобы окно перерисовалось без второго запроса.
 */
export async function forgeIssueCreate(
  ctx: ForgeContext,
  options: { title: string; body?: string },
): Promise<ForgeIssue[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const title = options.title.trim();
  if (title === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Нужен заголовок задачи');

  const args =
    info.cli === 'gh'
      ? ['issue', 'create', '--title', title, ...(options.body ? ['--body', options.body] : ['--body', ''])]
      : ['issue', 'create', '--title', title, ...(options.body ? ['--description', options.body] : []), '--yes'];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент отказался создавать задачу',
    );
  }
  return forgeIssues(ctx);
}

/** Закрыть задачу. Открытым задачам это единственное действие со стороны IDE. */
export async function forgeIssueClose(ctx: ForgeContext, number: number): Promise<ForgeIssue[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const n = requireRequestNumber(number);
  const result = await runForge(info.cli, ['issue', 'close', String(n)], repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент не смог закрыть задачу',
    );
  }
  return forgeIssues(ctx);
}

/** Комментарии задачи — тем же разбором, что и обсуждение запроса. */
export async function forgeIssueComments(ctx: ForgeContext, number: number): Promise<ForgeComment[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const n = requireRequestNumber(number);
  // У GitLab заметки задачи берём через `glab api`: своего `--json` у `glab issue view` нет.
  const args =
    info.cli === 'gh'
      ? ['issue', 'view', String(n), '--json', 'comments']
      : ['api', `projects/:id/issues/${n}/notes?per_page=100`];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент не смог получить комментарии задачи',
    );
  }
  return info.cli === 'gh' ? parseGhComments(result.stdout) : parseGlabComments(result.stdout);
}

/** Написать комментарий к задаче. Возвращаем обновлённое обсуждение. */
export async function forgeIssueComment(ctx: ForgeContext, number: number, body: string): Promise<ForgeComment[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const n = requireRequestNumber(number);
  const text = body.trim();
  if (text === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой комментарий');

  const args =
    info.cli === 'gh' ? ['issue', 'comment', String(n), '--body', text] : ['issue', 'note', String(n), '-m', text];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент отказался отправить комментарий',
    );
  }
  return forgeIssueComments(ctx, n);
}

/**
 * Прогоны CI: Actions у GitHub и Pipelines у GitLab — одно и то же по смыслу.
 * Свежие сверху; список тот же, что показывает сама площадка.
 */
export async function forgePipelines(ctx: ForgeContext): Promise<ForgePipeline[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  // У GitLab `glab ci list` печатает таблицу — машинный ответ берём через `glab api`.
  const args =
    info.cli === 'gh'
      ? [
          'run',
          'list',
          '--limit',
          '20',
          '--json',
          'databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,url',
        ]
      : ['api', 'projects/:id/pipelines?per_page=20'];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || `Клиент ${info.cli} не смог получить прогоны CI`,
    );
  }
  return info.cli === 'gh' ? parseGhRuns(result.stdout) : parseGlabPipelines(result.stdout);
}

/**
 * Перезапустить прогон: у GitHub — `gh run rerun`, у GitLab — `glab ci retry`.
 * Возвращаем обновлённый список, а не «ок»: окно и так перерисовывает его.
 */
export async function forgePipelineRerun(ctx: ForgeContext, id: number): Promise<ForgePipeline[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const n = requireRequestNumber(id);
  const args = info.cli === 'gh' ? ['run', 'rerun', String(n)] : ['ci', 'retry', String(n)];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент не смог перезапустить прогон',
    );
  }
  return forgePipelines(ctx);
}

/**
 * Уведомления площадки: у GitHub — непрочитанные ветки обсуждений этого
 * репозитория (`repos/:owner/:repo/notifications`), у GitLab — незакрытые дела
 * (`todos`), из которых отбираем дела своего проекта.
 */
export async function forgeNotifications(ctx: ForgeContext): Promise<ForgeNotification[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  if (!info.repo) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Площадка не определена');
  const path = `${info.repo.owner}/${info.repo.repo}`;
  const args = info.cli === 'gh' ? ['api', `repos/${path}/notifications?per_page=50`] : ['api', 'todos?per_page=100'];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || `Клиент ${info.cli} не смог получить уведомления`,
    );
  }
  return info.cli === 'gh' ? parseGhNotifications(result.stdout) : parseGlabTodos(result.stdout, path);
}

/**
 * Отметить уведомление прочитанным: у GitHub — `PATCH notifications/threads/:id`,
 * у GitLab — `POST todos/:id/mark_as_done`. Возвращаем обновлённый список.
 */
export async function forgeNotificationRead(ctx: ForgeContext, id: string): Promise<ForgeNotification[]> {
  const { repoRoot, info } = await forgeReady(ctx);
  const thread = requireNotificationId(id);
  const args =
    info.cli === 'gh'
      ? ['api', '--method', 'PATCH', `notifications/threads/${thread}`]
      : ['api', '--method', 'POST', `todos/${thread}/mark_as_done`];
  const result = await runForge(info.cli, args, repoRoot, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    throw new RpcFailure(
      RpcErrorCode.Internal,
      result.stderr.trim() || result.stdout.trim() || 'Клиент не смог отметить уведомление прочитанным',
    );
  }
  return forgeNotifications(ctx);
}

/**
 * Площадка и клиент для действий с задачами. Сводит три проверки (есть удалённый
 * адрес, есть клиент, клиент найден), которые иначе повторялись бы в каждом методе.
 */
export async function forgeReady(
  ctx: ForgeContext,
): Promise<{ repoRoot: string; info: ForgeInfo & { cli: 'gh' | 'glab' } }> {
  const repoRoot = await ctx.root();
  const info = await forgeInfo(ctx);
  if (!info.repo || !info.cli) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, info.note || 'Площадка не определена');
  }
  if (!info.cliAvailable) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Клиент ${info.cli} не найден в системе`);
  }
  return { repoRoot, info: info as ForgeInfo & { cli: 'gh' | 'glab' } };
}

/** Номер запроса: целое больше нуля. Клиент на неверный номер отвечает непонятным текстом. */
function requireRequestNumber(value: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n <= 0) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Неверный номер запроса');
  return n;
}

/**
 * Идентификатор уведомления: только цифры. Из него собирается путь запроса к
 * площадке, поэтому всякий лишний знак — это не «странный номер», а чужой адрес.
 */
function requireNotificationId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Неверный номер уведомления');
  return id;
}
