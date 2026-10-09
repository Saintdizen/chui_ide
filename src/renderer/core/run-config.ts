import { basename } from '../../shared/languages';
import type { ProjectScan } from '../../shared/project-scan';
import { resultMarkerCommand } from '../../shared/python-tests';
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
  source: 'file' | 'script' | 'test';
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

/** Сколько тестовых файлов показываем отдельными целями: список не должен расти безмерно. */
const MAX_TEST_TARGETS = 15;

/**
 * Цели pytest по карте проекта. «Запустить все тесты» есть всегда у Python-проекта
 * с тестами; отдельной целью становится ещё и активный файл, если это тест —
 * тогда не нужно искать его руками.
 */
export function pytestRunTargets(
  tools: ProjectTools,
  scan: ProjectScan | null,
  activeRelative: string | null,
): RunTarget[] {
  if (!scan) return [];
  // Тесты pytest есть только у Python-проекта: вид проекта — один вердикт,
  // а не разбор маркеров на месте.
  if (scan.kind.id !== 'python') return [];

  const tests = scan.testFiles.filter((file) => file.endsWith('.py'));
  if (tests.length === 0) return [];

  const targets: RunTarget[] = [
    {
      id: 'pytest:all',
      label: 'Запустить тесты (pytest)',
      detail: `${tools.pythonLabel} · pytest`,
      command: `${tools.pythonCommand} -m pytest`,
      source: 'test',
    },
    // Покрытие — отдельной целью: видно, что прогон отличается, и его не спутать
    // с обычным (нужен pytest-cov в окружении).
    pytestCoverageTarget(tools, null),
  ];

  // Активный тест — первой отдельной целью: чаще всего нужен именно он.
  const ordered = activeRelative && tests.includes(activeRelative)
    ? [activeRelative, ...tests.filter((file) => file !== activeRelative)]
    : tests;

  for (const file of ordered.slice(0, MAX_TEST_TARGETS)) {
    targets.push({
      id: `pytest:${file}`,
      label: `Тесты: ${basename(file)}`,
      detail: file,
      command: `${tools.pythonCommand} -m pytest ${shellQuote(file)}`,
      source: 'test',
    });
  }

  return targets;
}

/**
 * Одна цель pytest по селектору: идентификатор теста, класс или файл, а `null` —
 * все тесты проекта. Нужна панели тестов: там запускают конкретный узел дерева,
 * а не «всё подряд», и команду собирать должен тот же модуль, что и меню запуска,
 * иначе две кнопки разойдутся по поведению.
 */
export function pytestTarget(
  tools: ProjectTools,
  selector: string | null,
  options: { report?: boolean; platform?: string } = {},
): RunTarget {
  const base = selector
    ? `${tools.pythonCommand} -m pytest ${shellQuote(selector)}`
    : `${tools.pythonCommand} -m pytest`;
  // Отчёт: панель тестов дописывает печать кода выхода, чтобы узнать исход прогона.
  const command = options.report && options.platform ? `${base}${resultMarkerCommand(options.platform)}` : base;
  return {
    id: selector ? `pytest:${selector}` : 'pytest:all',
    label: selector ? `Тесты: ${basename(selector)}` : 'Запустить тесты (pytest)',
    detail: `${tools.pythonLabel} · pytest`,
    command,
    source: 'test',
  };
}

/**
 * Цель с покрытием: `pytest --cov`. Отдельная от обычного прогона, потому что
 * требует `pytest-cov` в окружении и пишет отчёт после тестов — смешивать их в
 * одной кнопке значило бы гадать, чего ждёт человек.
 *
 * `--cov` идёт ПЕРЕД селектором и отделён `--`: у `--cov` аргумент необязательный,
 * и `--cov tests/test_x.py` pytest-cov понимает как источник покрытия — тесты
 * тогда запускаются все, а покрытие выходит пустым. Проверено вживую.
 */
export function pytestCoverageTarget(
  tools: ProjectTools,
  selector: string | null,
  options: { report?: boolean; platform?: string } = {},
): RunTarget {
  // `term-missing` просим явно, хотя `--cov` и так печатает терминальный отчёт:
  // без него в отчёте нет колонки `Missing`, а по ней панель подсвечивает строки.
  // `--cov-branch` добавляет колонки `Branch`/`BrPart`: видно не только «строка
  // не исполнена», но и «ветвь условия пройдена лишь наполовину».
  const base = selector
    ? `${tools.pythonCommand} -m pytest --cov --cov-branch --cov-report=term-missing -- ${shellQuote(selector)}`
    : `${tools.pythonCommand} -m pytest --cov --cov-branch --cov-report=term-missing`;
  // Панель тестов и здесь просит отчёт: по маркеру она ставит исход, а строку
  // покрытия берёт из вывода pytest-cov, который печатается перед маркером.
  const command = options.report && options.platform ? `${base}${resultMarkerCommand(options.platform)}` : base;
  return {
    id: selector ? `pytest-cov:${selector}` : 'pytest-cov:all',
    label: selector ? `Покрытие: ${basename(selector)}` : 'Тесты с покрытием (pytest --cov)',
    detail: `${tools.pythonLabel} · pytest --cov`,
    command,
    source: 'test',
  };
}

/**
 * Установка пакетов Node менеджером проекта: `npm install zod`.
 *
 * Установка идёт в терминале, а не отдельным потоком, и это осознанно: вывод
 * `npm install` длинный и шумный, его принято читать и можно прервать — ровно
 * как задачи проекта. Менеджер берём из инструментов проекта (по блокировке или
 * настройке), чтобы не поставить пакеты «не тем» менеджером.
 */
export function nodeInstallTarget(tools: ProjectTools, packages: readonly string[]): RunTarget {
  const list = packages.map((name) => shellQuote(name)).join(' ');
  return {
    id: `install:${packages.join(',')}`,
    label: packages.length === 1 ? `Установить ${packages[0]}` : `Установить пакеты: ${packages.join(', ')}`,
    detail: `${tools.packageManager} install`,
    command: `${tools.packageManager} install ${list}`,
    source: 'script',
  };
}

/**
 * Набор для меню запуска: сначала сам файл, затем тесты, затем задачи проекта.
 * Задачи нужны почти всегда: обычный проект Node запускается не файлом, а скриптом.
 */
export function collectRunTargets(
  file: RunnableFile | null,
  tools: ProjectTools,
  scan: ProjectScan | null = null,
): RunTarget[] {
  const targets: RunTarget[] = [];
  if (file) {
    const target = fileRunTarget(file, tools);
    if (target) targets.push(target);
  }
  targets.push(...pytestRunTargets(tools, scan, file?.relative ?? null));
  targets.push(...scriptRunTargets(tools));
  return targets;
}
