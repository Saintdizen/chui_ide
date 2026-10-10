import { execFile } from 'node:child_process';
import { collectFailure, parsePytestCollect, type CollectedSuite } from '../../shared/python-tests';
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
 */
export async function collectTests(root: string, python: string): Promise<CollectedSuite> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(await projectEnv(root)),
    PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1',
  };

  return new Promise((resolve) => {
    execFile(
      python,
      ['-m', 'pytest', '--collect-only', '-q', '--no-header', '-p', 'no:cacheprovider'],
      { cwd: root, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const suite = parsePytestCollect(`${stdout ?? ''}\n${stderr ?? ''}`);
        // Сбой самого pytest (например, несовместимый плагин) даёт трейсбек, а не
        // строку `ERROR`: без этого сводка выглядела бы пустой и без причины.
        if (error && suite.tests.length === 0 && suite.errors.length === 0) {
          suite.errors = collectFailure(`${stderr ?? ''}\n${stdout ?? ''}`);
        }
        resolve(suite);
      },
    );
  });
}
