import { basename } from '../../shared/languages';
import type { ProjectTools } from './project-tools';
import { shellQuote } from './project-tools';

/**
 * Что можно запустить прямо сейчас.
 *
 * Правило простое: показываем то, что действительно выполнится. Python —
 * интерпретатором окружения проекта, Node — самим `node` или скриптом из
 * package.json. Ничего не выдумываем: если файл не запускается (`.css`,
 * `README.md`), кнопки запуска нет.
 */

export interface RunTarget {
  /** Стабильный ключ: им же помечаем значок на поле номера строки. */
  id: string;
  label: string;
  /** Чем запускаем — видно в подсказке и в меню: «.venv · ./.venv/bin/python». */
  detail: string;
  /** Готовая строка для терминала. */
  command: string;
  /** Строка файла, с которой связано «запускаемое» место (для значка ▶ в жёлобе). */
  line?: number;
  source: 'file' | 'script';
}

export interface RunnableFile {
  path: string;
  /** Путь от корня проекта: команда должна работать в его каталоге. */
  relative: string;
  languageId: string;
  text: string;
}

/** `if __name__ == "__main__":` — точка входа Python. */
const PY_MAIN = /^[ \t]*if[ \t]+__name__[ \t]*==[ \t]*['"]__main__['"][ \t]*:/m;
/** `require.main === module` / `if (require.main)` — точка входа Node. */
const JS_MAIN = /^[ \t]*(?:if[ \t]*\(?[ \t]*require\.main|require\.main[ \t]*===[ \t]*module)/m;

/** Номер строки первого совпадения (1-based), иначе null. */
export function entryLine(languageId: string, text: string): number | null {
  const pattern = languageId === 'python' ? PY_MAIN : languageId === 'javascript' || languageId === 'typescript' ? JS_MAIN : null;
  if (!pattern) return null;
  const match = pattern.exec(text);
  if (!match) return null;
  return text.slice(0, match.index).split('\n').length;
}

/** Файл как программа. null — запускать нечего. */
export function fileRunTarget(file: RunnableFile, tools: ProjectTools): RunTarget | null {
  const name = basename(file.path);
  const path = shellQuote(file.relative);
  const line = entryLine(file.languageId, file.text) ?? undefined;

  if (file.languageId === 'python') {
    return {
      id: `file:${file.path}`,
      label: `Запустить ${name}`,
      detail: tools.pythonFromProject ? `${tools.pythonLabel} · файл запускается окружением проекта` : tools.pythonLabel,
      command: `${tools.pythonCommand} ${path}`,
      ...(line ? { line } : {}),
      source: 'file',
    };
  }

  if (file.languageId === 'javascript') {
    return {
      id: `file:${file.path}`,
      label: `Запустить ${name}`,
      detail: 'node',
      command: `node ${path}`,
      ...(line ? { line } : {}),
      source: 'file',
    };
  }

  if (file.languageId === 'typescript' && tools.tsRunner) {
    return {
      id: `file:${file.path}`,
      label: `Запустить ${name}`,
      detail: `${tools.tsRunner} · TypeScript выполняется раннером проекта`,
      command: `${tools.tsRunner} ${path}`,
      ...(line ? { line } : {}),
      source: 'file',
    };
  }

  if (file.languageId === 'shell') {
    return {
      id: `file:${file.path}`,
      label: `Запустить ${name}`,
      detail: 'bash',
      command: `bash ${path}`,
      source: 'file',
    };
  }

  return null;
}

/** Задачи из package.json: `npm run dev`, `pnpm run test` и прочее. */
export function scriptRunTargets(tools: ProjectTools): RunTarget[] {
  if (!tools.hasPackageJson || tools.scripts.length === 0) return [];
  return tools.scripts.map((script) => ({
    id: `script:${script.name}`,
    label: `${tools.packageManager} run ${script.name}`,
    detail: script.command,
    command: `${tools.packageManager} run ${script.name}`,
    source: 'script' as const,
  }));
}

/**
 * Набор для меню запуска: сначала сам файл, затем задачи проекта.
 * Задачи нужны почти всегда: обычный проект Node запускается не файлом, а скриптом.
 */
export function collectRunTargets(file: RunnableFile | null, tools: ProjectTools): RunTarget[] {
  const targets: RunTarget[] = [];
  if (file) {
    const target = fileRunTarget(file, tools);
    if (target) targets.push(target);
  }
  targets.push(...scriptRunTargets(tools));
  return targets;
}
