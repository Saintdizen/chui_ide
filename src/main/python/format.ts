import { spawn } from 'node:child_process';
import type { PythonFormatResult } from '../../shared/api';
import { projectEnv } from '../project-env';

/**
 * Форматирование файла инструментом окружения: ruff или black.
 *
 * Инструмент запускаем как модуль интерпретатора проекта (`python -m ruff`) —
 * так берётся именно то окружение, в котором человек работает, без поиска
 * бинарников в PATH. Читаем из stdin, пишем в stdout: файл на диске трогает
 * только renderer, а он умеет провести правку через документ, undo и сохранение.
 *
 * Порядок — ruff, потом black: ruff быстрее и современнее, black — привычный
 * запасной. Ни того ни другого нет — это не ошибка, а «нечем форматировать».
 */

interface FormatTool {
  /** Имя для интерфейса и сообщений. */
  name: string;
  /** Аргументы `python -m …`; `-` вместо файла — читать stdin. */
  args: (path: string) => string[];
}

const TOOLS: readonly FormatTool[] = [
  { name: 'ruff', args: (path) => ['-m', 'ruff', 'format', '--stdin-filename', path, '-'] },
  { name: 'black', args: (path) => ['-m', 'black', '-q', '--stdin-filename', path, '-'] },
];

/** Результат одного запуска: получилось ли и что инструмент вернул. */
interface Attempt {
  ok: boolean;
  text: string;
}

export async function formatPython(
  root: string,
  python: string,
  path: string,
  text: string,
): Promise<PythonFormatResult> {
  const env = { ...process.env, ...(await projectEnv(root)), PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' };

  for (const tool of TOOLS) {
    const attempt = await run(python, tool.args(path), root, text, env);
    // Пустой вывод при успешном коде — тоже неудача: форматировать нечего/не получилось.
    if (attempt.ok && attempt.text.trim()) return { text: attempt.text, tool: tool.name };
  }

  return { text, tool: null };
}

/** Запустить инструмент, отдав текст в stdin, и вернуть его вывод. */
function run(python: string, args: string[], cwd: string, input: string, env: NodeJS.ProcessEnv): Promise<Attempt> {
  return new Promise((resolve) => {
    const child = spawn(python, args, { cwd, env, windowsHide: true });

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    // Ошибки инструмента нам не нужны: не получилось — пробуем следующий.
    child.stderr.on('data', () => undefined);

    child.on('error', () => resolve({ ok: false, text: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, text: out }));

    child.stdin.end(input);
  });
}
