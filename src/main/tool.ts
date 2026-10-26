import { execFile } from 'node:child_process';
import { type GitResult, GIT_TIMEOUT_MS } from './git/exec';

/**
 * Запуск внешнего инструмента без оболочки: ssh-keygen, gpg, gh.
 *
 * Отдельно от `execGit`, потому что это НЕ git: у него нет ни `--no-optional-locks`,
 * ни корня репозитория в cwd. И отдельно от `git/tool.ts`, потому что им пользуются
 * и ключи git, и подпись коммитов — то есть модуль лежит выше git.
 *
 * `GIT_TERMINAL_PROMPT=0` оставлен нарочно: gh и ssh могут спросить пароль в
 * терминале, которого у нас нет, — лучше чистый отказ, чем висящий процесс.
 * Возвращает `GitResult`, а не бросает: «gh не установлен» — обычный ответ.
 */
export function runTool(file: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}
