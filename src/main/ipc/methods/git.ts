import { CloneEvent } from '../../../shared/api';
import type { RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Всё про git: рабочий каталог, индексы, отложенные изменения, история,
 * ветки, теги, forge (PR/issues/пайплайны) и LFS.
 *
 * Здесь только перевод имени метода в вызов `GitService`: сам сервис про RPC
 * не знает. Перенесено из `register.ts` без правок логики.
 */
export function registerGitMethods(router: RpcRouter, deps: RpcServices): void {
  router.register('git.status', () => deps.git.status());
  // Diff будущего коммита: по нему модель пишет сообщение (см. `ai.commitMessage`).
  router.register('git.commitDiff', () => deps.git.commitDiff());
  // Сводка по всем корням области: панель изменений видит правки и в неактивных папках.
  router.register('git.summary', () => deps.git.summary(deps.workspace.rootList()));
  router.register('git.init', () => deps.git.init());
  router.register('git.stage', (params) => deps.git.stage(params.paths));
  router.register('git.unstage', (params) => deps.git.unstage(params.paths));
  router.register('git.discard', (params) => deps.git.discard(params.paths));
  router.register('git.commit', (params) => deps.git.commit(params.message, params.paths, params.amend));
  router.register('git.diff', (params) => deps.git.diff(params.path, params.staged, params.commit));
  router.register('git.stageHunk', (params) => deps.git.stageHunk(params.path, params.index));
  // Блоки файла и откат одного блока — для действий прямо из жёлоба редактора.
  router.register('git.fileHunks', (params) => deps.git.fileHunks(params.path));
  router.register('git.discardHunk', (params) => deps.git.discardHunk(params.path, params.index));
  router.register('git.unstageHunk', (params) => deps.git.unstageHunk(params.path, params.index));
  router.register('git.blame', (params) =>
    deps.git.blame(params.path, { startLine: params.startLine, endLine: params.endLine }),
  );
  router.register('git.log', (params) => deps.git.log(params.limit, params.path));
  router.register('git.headText', (params) => deps.git.headText(params.path));

  // Отложенные изменения: список, сохранение, применение, удаление и просмотр.
  router.register('git.stashList', () => deps.git.stashList());
  router.register('git.stashSave', (params) => deps.git.stashSave(params));
  router.register('git.stashApply', (params) => deps.git.stashApply(params.index));
  router.register('git.stashPop', (params) => deps.git.stashPop(params.index));
  router.register('git.stashDrop', (params) => deps.git.stashDrop(params.index));
  router.register('git.stashShow', (params) => deps.git.stashShow(params.index));

  // Отдельные коммиты и теги.
  router.register('git.cherryPick', (params) => deps.git.cherryPick(params.commit));
  router.register('git.revert', (params) => deps.git.revert(params.commit));
  router.register('git.reset', (params) => deps.git.reset(params.mode, params.commit));
  // Интерактивный rebase: список шагов собирает renderer, git получает его своим
  // редактором последовательности. Ответ говорит, завершился ли rebase и не ждёт ли он человека.
  router.register('git.bisectState', () => deps.git.bisectState());
  router.register('git.bisectStart', (params) => deps.git.bisectStart(params));
  router.register('git.bisectMark', (params) => deps.git.bisectMark(params.mark));
  router.register('git.bisectReset', () => deps.git.bisectReset());
  router.register('git.compareRefs', (params) => deps.git.compareRefs(params.base, params.head));
  router.register('git.diffRefs', (params) => deps.git.diffRefs(params.base, params.head, params.path));
  router.register('git.rebase', (params) => deps.git.rebase(params.count, params.items));
  router.register('git.rebaseContinue', () => deps.git.rebaseContinue());
  router.register('git.rebaseAbort', () => deps.git.rebaseAbort());
  router.register('git.rebaseSkip', () => deps.git.rebaseSkip());
  router.register('git.tags', () => deps.git.tags());
  router.register('git.createTag', (params) =>
    deps.git.createTag(params.name, { message: params.message, commit: params.commit }),
  );
  router.register('git.deleteTag', (params) => deps.git.deleteTag(params.name));
  router.register('git.pushTag', (params) => deps.git.pushTag(params.name));
  router.register('git.deleteBranch', (params) => deps.git.deleteBranch(params.name, params.force));
  router.register('git.renameBranch', (params) => deps.git.renameBranch(params.from, params.to));
  router.register('git.ignore', (params) => deps.git.ignore(params.paths));
  router.register('git.checkIgnore', (params) => deps.git.checkIgnore(params.paths));
  router.register('git.submodules', () => deps.git.submodules());
  router.register('git.submoduleUpdate', () => deps.git.submoduleUpdate());
  router.register('git.worktrees', () => deps.git.worktrees());
  router.register('git.worktreeAdd', (params) =>
    deps.git.worktreeAdd(params.path, { branch: params.branch, newBranch: params.newBranch }),
  );
  router.register('git.worktreeRemove', (params) => deps.git.worktreeRemove(params.path, params.force));
  router.register('git.worktreePrune', () => deps.git.worktreePrune());
  router.register('git.reflog', (params) => deps.git.reflog(params.limit));
  router.register('git.logGraph', (params) => deps.git.logGraph(params.limit));
  router.register('git.conflictParts', (params) => deps.git.conflictParts(params.path));
  router.register('git.markResolved', (params) => deps.git.markResolved(params.path));
  router.register('git.branches', () => deps.git.branches());
  router.register('git.checkout', (params) => deps.git.checkout(params.name, params.create));
  router.register('git.remotes', () => deps.git.remotes());
  router.register('git.fetch', () => deps.git.fetch());
  // Во всех корнях области: у каждой папки свой репозиторий (см. `fetchRoots`).
  router.register('git.fetchRoots', () => deps.git.fetchRoots(deps.workspace.rootList()));
  router.register('git.pull', (params) => deps.git.pull(params.mode));
  router.register('git.push', (params) => deps.git.push(params));

  router.register('git.forgeInfo', (params) => deps.git.forgeInfo(params.remote));
  router.register('git.forgeCreate', (params) => deps.git.forgeCreate(params));
  router.register('git.forgeCheckout', (params) => deps.git.forgeCheckout(params.number));
  router.register('git.forgeComments', (params) => deps.git.forgeComments(params.number));
  router.register('git.forgeComment', (params) => deps.git.forgeComment(params.number, params.body));
  router.register('git.forgeIssues', () => deps.git.forgeIssues());
  router.register('git.forgeIssueCreate', (params) => deps.git.forgeIssueCreate(params));
  router.register('git.forgeIssueClose', (params) => deps.git.forgeIssueClose(params.number));
  router.register('git.forgeIssueComments', (params) => deps.git.forgeIssueComments(params.number));
  router.register('git.forgeIssueComment', (params) => deps.git.forgeIssueComment(params.number, params.body));
  router.register('git.forgePipelines', () => deps.git.forgePipelines());
  router.register('git.forgePipelineRerun', (params) => deps.git.forgePipelineRerun(params.id));
  router.register('git.forgeNotifications', () => deps.git.forgeNotifications());
  router.register('git.forgeNotificationRead', (params) => deps.git.forgeNotificationRead(params.id));

  router.register('git.identity', () => deps.git.identity());
  router.register('git.setIdentity', (params) => deps.git.setIdentity(params.values));
  router.register('git.sshKeys', () => deps.git.sshKeys());
  router.register('git.lfsInfo', () => deps.git.lfsInfo());
  router.register('git.lfsTrack', (params) => deps.git.lfsTrack(params.pattern));
  router.register('git.lfsUntrack', (params) => deps.git.lfsUntrack(params.pattern));
  router.register('git.lfsPull', () => deps.git.lfsPull());
  router.register('git.lfsInstall', () => deps.git.lfsInstall());
  router.register('git.sparseInfo', () => deps.git.sparseInfo());
  router.register('git.sparseSet', (params) => deps.git.sparseSet(params.directories));
  router.register('git.sparseAdd', (params) => deps.git.sparseAdd(params.directory));
  router.register('git.sparseDisable', () => deps.git.sparseDisable());

  router.register('git.clone', (params, ctx) =>
    deps.git.clone(params.url, params.directory, (line) => ctx.emit(CloneEvent.Progress, { line })),
  );
}
