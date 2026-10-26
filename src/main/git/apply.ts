import { spawn } from 'node:child_process';
import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * `git apply` с патчем на stdin.
 *
 * Отдельно от `execGit`: патч идёт потоком во вход процесса, а не аргументом —
 * аргументом он не влез бы в командную строку, да и кавычки ОС по дороге его
 * испортили бы.
 */
export function runApply(args: readonly string[], repoRoot: string, patch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], {
      cwd: repoRoot,
      windowsHide: true,
      env: {
        ...process.env,
        // Никаких диалогов и редакторов: всё, что требует ввода, в IDE решается иначе.
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_PAGER: 'cat',
      },
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new RpcFailure(RpcErrorCode.Internal, `git apply: ${stderr.trim() || `код ${code}`}`));
    });
    child.stdin.end(patch);
  });
}

/** Патч одного блока в индекс; `reverse` — снять его оттуда. */
export function applyToIndex(patch: string, repoRoot: string, reverse: boolean): Promise<void> {
  const args = ['apply', '--cached', '--whitespace=nowarn'];
  if (reverse) args.push('--reverse');
  return runApply(args, repoRoot, patch);
}

/** Обратный патч в рабочее дерево: индекс не трогается. */
export function applyToWorktree(patch: string, repoRoot: string): Promise<void> {
  return runApply(['apply', '--whitespace=nowarn', '--reverse'], repoRoot, patch);
}
