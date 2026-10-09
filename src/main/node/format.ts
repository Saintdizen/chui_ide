import { spawn } from 'node:child_process';
import type { NodeFormatResult } from '../../shared/api';
import { nodeFormatOrder, nodeFormatPackage, type NodeFormatTool } from '../../shared/format';
import { resolvePackageBin } from './bin';
import { declaredDependencyNames, nodeRuntime } from './environment';

/**
 * Форматирование файла инструментом проекта: prettier или biome.
 *
 * Инструмент берём из `node_modules` проекта, а не из PATH: форматировать надо тем,
 * что выбрал проект, — у него конфиг, версия и набор плагинов. Запускаем его тем же
 * Node, которым проект запускается (`nodeRuntime`), чтобы не зависеть от того, что
 * оказалось в PATH у графического приложения.
 *
 * Читаем из stdin, пишем в stdout: файл на диске трогает только renderer, а он умеет
 * провести правку через документ, undo и сохранение. Это тот же уговор, что и у
 * питоновского форматтера, — поэтому и результат той же формы.
 */

/** Инструмент: где он лежит в `node_modules` и как его позвать. */
interface FormatTool {
  /** Имя для интерфейса и сообщений. */
  name: NodeFormatTool;
  /** Аргументы; `path` — чтобы инструмент взял из конфига настройки этого файла. */
  args: (path: string) => string[];
}

const TOOLS: Record<NodeFormatTool, FormatTool> = {
  prettier: { name: 'prettier', args: (path) => ['--stdin-filepath', path] },
  biome: { name: 'biome', args: (path) => ['format', '--stdin-file-path', path] },
};

export async function formatNode(root: string, path: string, text: string): Promise<NodeFormatResult> {
  const node = (await nodeRuntime()).command;
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  const order = nodeFormatOrder(await declaredDependencyNames(root));

  for (const name of order) {
    const tool = TOOLS[name];
    const script = await resolvePackageBin(root, nodeFormatPackage(name), name);
    if (!script) continue;
    const attempt = await run(node, [script, ...tool.args(path)], root, text, env);
    // Пустой вывод при успешном коде — тоже неудача: форматировать нечего/не получилось.
    if (attempt.ok && attempt.text.trim()) return { text: attempt.text, tool: tool.name };
  }

  return { text, tool: null };
}

/** Результат одного запуска: получилось ли и что инструмент вернул. */
interface Attempt {
  ok: boolean;
  text: string;
}

/** Запустить инструмент, отдав текст в stdin, и вернуть его вывод. */
function run(node: string, args: string[], cwd: string, input: string, env: NodeJS.ProcessEnv): Promise<Attempt> {
  return new Promise((resolve) => {
    const child = spawn(node, args, { cwd, env, windowsHide: true });

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
