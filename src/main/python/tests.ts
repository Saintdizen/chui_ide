import { execFile } from 'node:child_process';
import {
  collectFailure,
  failedPluginNames,
  parsePytestCollect,
  pluginBlockArgs,
  type CollectedSuite,
} from '../../shared/python-tests';
import { projectEnv } from '../project-env';

/**
 * Список тестов проекта: `pytest --collect-only`.
 *
 * Собираем один раз, а запускаем отдельным вызовом (тесты идут в терминале, там
 * их видно и можно прервать). Здесь только сбор: он дешёвый и, что важно,
 * не выполняет тесты — `--collect-only` именно этим и хорош.
 *
 * Ошибку сбора не считаем сбоем метода: pytest мог не найтись или тест не
 * импортируется. Тогда в сводке будут ошибки и пустой список — это ответ, а не падение.
 *
 * Отдельная забота — плагины окружения. Чужой плагин, несовместимый с версией
 * pytest, роняет запуск целиком: `pytest --collect-only` падает ещё до сбора, и
 * человек видит трейсбек вместо своих тестов — при том что тесты в проекте есть.
 * Поэтому виновника находим в трейсбеке и повторяем сбор, отключив его: пусть
 * тесты будут видны, а о беде скажем прямо (`disabledPlugins`). Отключение — это
 * `-p no:<имя>`, тот же ключ, что уходит и в прогон из панели.
 */
export async function collectTests(root: string, python: string): Promise<CollectedSuite> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(await projectEnv(root)),
    PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1',
  };

  const first = await collect(root, python, env, []);
  if (first.suite.tests.length > 0 || first.suite.errors.length === 0) return first.suite;

  const plugins = failedPluginNames(first.output);
  if (plugins.length === 0) return first.suite;

  const second = await collect(root, python, env, pluginBlockArgs(plugins));
  // Повтор не помог — показываем исходную причину: она и есть настоящая, а
  // отключённым называть плагин, который всё равно роняет запуск, было бы враньём.
  if (second.suite.tests.length === 0 && second.suite.errors.length > 0) return first.suite;
  return { ...second.suite, disabledPlugins: plugins };
}

/** Сводка и сырой вывод одного прогона сбора: по выводу ищем упавший плагин. */
interface CollectAttempt {
  suite: CollectedSuite;
  /** Диагностика (stderr и stdout): из неё берём трейсбек загрузки плагина. */
  output: string;
}

/** Один прогон сбора. `args` — дополнительные ключи pytest (отключение плагинов). */
function collect(
  root: string,
  python: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<CollectAttempt> {
  return new Promise((resolve) => {
    execFile(
      python,
      ['-m', 'pytest', '--collect-only', '-q', '--no-header', '-p', 'no:cacheprovider', ...args],
      { cwd: root, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = stdout ?? '';
        const err = stderr ?? '';
        const suite = parsePytestCollect(`${out}\n${err}`);
        // Сбой самого pytest (например, несовместимый плагин) даёт трейсбек, а не
        // строку `ERROR`: без этого сводка выглядела бы пустой и без причины.
        if (error && suite.tests.length === 0 && suite.errors.length === 0) {
          suite.errors = collectFailure(`${err}\n${out}`);
        }
        resolve({ suite, output: `${err}\n${out}` });
      },
    );
  });
}
