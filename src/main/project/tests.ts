import { scanProject } from './scan';
import { declaredDependencyNames, nodeRuntime } from '../node/environment';
import { resolvePackageBin } from '../node/bin';
import { detectNodeTestRunner, nodeTestRunnerFrom, nodeTestRunnerLabel } from '../../shared/node-tests';

/**
 * Команда запуска тестов проекта: чем и как гонять тесты, не спрашивая об этом
 * человека. Нужна инструменту агента `run_tests`: агент не должен угадывать,
 * pytest здесь или vitest, — иначе половина прогонов падала бы на «команда не
 * найдена».
 *
 * Решение то же, что у панели тестов и меню запуска (renderer собирает команду в
 * `run-config.ts`), но живёт в main: здесь процессы и карта проекта, и агент тоже
 * работает в main. Логика раннера общая — `shared/node-tests.ts`, — поэтому две
 * кнопки и агент не разойдутся в том, что считать тестами проекта.
 */

/** Готовая команда: строка для запуска и имя раннера для подписи. */
export interface TestCommand {
  /** Команда целиком, как её понял бы человек в терминале. */
  command: string;
  /** Имя раннера: `pytest`, `vitest`, `jest`, `node --test`. */
  label: string;
}

/**
 * Чем запускать тесты проекта; `null` — тестов нет или запускать нечем.
 *
 * Python — всегда pytest: другого раннера у нас для него нет, и наличие тестов
 * мы уже знаем из карты проекта. Node — раннер по зависимостям (vitest/jest) или
 * встроенный `node --test`, если тестовые файлы есть, а раннера нет.
 */
export async function testCommand(root: string, python: string): Promise<TestCommand | null> {
  const scan = await scanProject(root);

  if (scan.kind.id === 'python') {
    // Тестов pytest нет — запускать нечего: пустой прогон не ответ, а шум.
    if (!scan.testFiles.some((file) => file.endsWith('.py'))) return null;
    return { command: `${quote(python)} -m pytest`, label: 'pytest' };
  }

  const runner = detectNodeTestRunner(nodeTestRunnerFrom(await declaredDependencyNames(root)), scan.testFiles);
  if (!runner) return null;
  if (runner === 'node') return { command: `${quote((await nodeRuntime()).command)} --test`, label: 'node --test' };

  // Раннер зовём его скриптом из `node_modules` тем же Node, что и проект, — как
  // форматтер и линтер: так берётся версия проекта, а не что-то из PATH.
  const script = await resolvePackageBin(root, runner, runner);
  if (!script) {
    // Объявлен, но не установлен: команду всё равно не собрать — говорим честно.
    return null;
  }
  const node = quote((await nodeRuntime()).command);
  // У vitest без `run` включается слежение: прогон из инструмента обязан
  // завершаться сам, иначе агентский шаг повиснет до таймаута.
  const args = runner === 'vitest' ? ['run'] : [];
  return {
    command: [node, quote(script), ...args].join(' '),
    label: nodeTestRunnerLabel(runner),
  };
}

/**
 * Взять аргумент в кавычки для оболочки. Кавычки разные: в posix-оболочке путь
 * с пробелом спасут одиночные, а в cmd.exe на Windows — двойные; иначе команда
 * с путём к проекту в «Мои документы» развалилась бы на части.
 */
function quote(value: string): string {
  return process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}
