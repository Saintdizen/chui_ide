import path from 'node:path';
import { RpcErrorCode, type GitStatus } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { execGit } from './exec';

/**
 * Чтение и точечная правка отдельных коммитов. Всё, что нужно от `GitService`,
 * сведено к трём ответам; состоянием класса операции не пользуются.
 */
export interface InspectContext {
  /** Корень репозитория или `null`, если папка проектом не является. */
  repositoryRoot(): Promise<string | null>;
  /** Корень с ошибкой, если его нет: операции ниже без репозитория бессмысленны. */
  requireRoot(): string;
  /** Свежий статус — им же в интерфейс уходит уведомление об изменении. */
  refresh(): Promise<GitStatus>;
}

/**
 * Содержимое файла в HEAD. `null` — рабочая папка не репозиторий (тогда полосок
 * изменений быть не должно); пустая строка — файл новый или без коммитов.
 */
export async function headText(ctx: InspectContext, filePath: string): Promise<string | null> {
  const repoRoot = await ctx.repositoryRoot();
  if (!repoRoot) return null;
  const relative = path.relative(repoRoot, path.resolve(filePath));
  return show(`HEAD:${relative}`, repoRoot);
}

/** Отменить один коммит новым коммитом с обратными правками. */
export async function revert(ctx: InspectContext, commit: string): Promise<GitStatus> {
  const repoRoot = ctx.requireRoot();
  // --no-edit: сообщение берём готовое, редактор не открываем.
  await execGit(['revert', '--no-edit', commitArg(commit)], repoRoot);
  return ctx.refresh();
}

/** Передвинуть ветку на коммит: soft (только указатель), mixed (+ индекс), hard (+ дерево). */
export async function reset(ctx: InspectContext, mode: 'soft' | 'mixed' | 'hard', commit: string): Promise<GitStatus> {
  const repoRoot = ctx.requireRoot();
  await execGit(['reset', `--${mode}`, commitArg(commit)], repoRoot);
  return ctx.refresh();
}

/** Имя коммита может начинаться с `-` — тогда git примет его за флаг, а не за ссылку. */
function commitArg(commit: string): string {
  const value = commit.trim();
  if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задан коммит');
  if (value.startsWith('-'))
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка на коммит: ${value}`);
  return value;
}

async function show(spec: string, cwd: string): Promise<string> {
  const result = await execGit(['show', spec], cwd, { allowFailure: true });
  return result.ok ? result.stdout : '';
}
