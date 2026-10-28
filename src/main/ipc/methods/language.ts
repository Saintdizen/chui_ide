import { app } from 'electron';
import { VenvEvent } from '../../../shared/api';
import { activationForInterpreter, createVenv, findEnvironments, lookupVenv } from '../../python/environments';
import { findInterpreters } from '../../python/interpreters';
import { installPackages, installedPackages } from '../../python/pip';
import { collectTests } from '../../python/tests';
import { formatPython } from '../../python/format';
import { runLineProfile } from '../../python/line-profile';
import { checkEnvironments } from '../../python/health';
import { missingModules } from '../../python/packages';
import { missingPackages } from '../../node/packages';
import { missingLocalImports, projectAliases } from '../../project/local-imports';
import {
  checkEnvironment as checkNodeEnvironment,
  nodeInfo,
  installedPackages as installedNodePackages,
} from '../../node/environment';
import { formatNode } from '../../node/format';
import { collectNodeTests } from '../../node/tests';
import type { RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Языки проекта: окружение Python (venv, пакеты, импорты, тесты, форматирование,
 * профиль строк) и Node (версия, `node_modules`, здоровье, тесты).
 *
 * Общее — вопрос «чем и в каком окружении это исполнять». Отсюда и `resolvePython`
 * в контексте доменов: проверять импорты чужим питоном значило бы врать про окружение.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerLanguageMethods(router: RpcRouter, deps: RpcServices): void {
  /* ── Python: виртуальные окружения проекта ─────────────────────────────── */

  // Главное окружение идёт первым — на него ориентируются запуск, тесты и подсказки.
  router.register('python.environments', () => findEnvironments(deps.requireRoot(), process.platform));

  // Установленные в системе интерпретаторы: их выбор нужен при создании окружения.
  router.register('python.interpreters', () => findInterpreters(process.platform));

  // Создание долгое: шаги и вывод команд уезжают событиями, как у `git.clone`.
  router.register('python.createVenv', (params, ctx) =>
    createVenv(
      deps.requireRoot(),
      app.getPath('home'),
      params,
      (payload: unknown) => ctx.emit(VenvEvent.Progress, payload),
      ctx.signal,
    ),
  );

  // Окружение по папке, выбранной человеком: своё, созданное раньше и, может быть,
  // вне проекта. Корень не обязателен — взять чужое окружение можно и без проекта.
  router.register('python.venvAt', (params) =>
    lookupVenv(params.path, deps.workspace.rootPath(), app.getPath('home'), process.platform),
  );

  router.register('python.activateCommand', () => {
    const root = deps.requireRoot();
    // Окружение берём по рабочему интерпретатору: выбранное для проекта может быть и
    // вне проекта (`~/.venvs`), и команда активации должна вести именно в него.
    const run = deps.settings.get().run;
    return {
      command: activationForInterpreter(root, run.pythonByRoot[root] ?? run.pythonPath, process.platform),
    };
  });

  // Проверка импортов: какие модули файл подключает, а проект их не видит.
  // У Python окружение — интерпретатор, у JS/TS — каталоги `node_modules`,
  // а у относительных ссылок (`./util`, `from .mod`) — сам диск.
  router.register('imports.missing', async (params) => {
    const root = deps.workspace.rootPath();
    const missing =
      params.language === 'python'
        ? await missingModules(root, deps.resolvePython(root), params.modules)
        : await missingPackages(root, params.modules);
    // Свои модули проекта ищем рядом с файлом, который их импортирует; алиасы
    // (`@/x`) — по `paths` из tsconfig, и только если проект их объявил.
    const local = await missingLocalImports(
      params.language,
      params.path,
      params.locals,
      undefined,
      await projectAliases(root),
      root ?? '',
    );
    return { missing: [...missing, ...local] };
  });

  // Установленные пакеты главного окружения: имя и версия.
  router.register('python.packages', () =>
    installedPackages(deps.resolvePython(deps.workspace.rootPath()), deps.workspace.rootPath() ?? undefined),
  );

  // Установка долгая: шаги и вывод pip уезжают событиями, как при создании окружения.
  router.register('python.install', (params, ctx) => {
    const root = deps.requireRoot();
    return installPackages(
      root,
      deps.resolvePython(root),
      params,
      (payload: unknown) => ctx.emit(VenvEvent.Progress, payload),
      ctx.signal,
    );
  });

  // Список тестов проекта: сбор без выполнения самих тестов.
  router.register('python.tests', () => {
    const root = deps.requireRoot();
    return collectTests(root, deps.resolvePython(root));
  });

  // Здоровье окружений: читаем `pyvenv.cfg` и смотрим, на месте ли базовый питон и pip.
  router.register('python.envHealth', () => checkEnvironments(deps.requireRoot(), process.platform));

  // Форматирование: текст приходит из renderer и туда же уходит результат —
  // правку проводит документ, чтобы работали undo и сохранение.
  router.register('python.format', (params) => {
    const root = deps.requireRoot();
    return formatPython(root, deps.resolvePython(root), params.path, params.text);
  });

  // Профиль строк: свой профилировщик на stdlib исполняет скрипт и отдаёт время по
  // строкам. Интерпретатор — тот же, что у форматирования и проверок: профиль должен
  // быть про то окружение, в котором человек работает.
  router.register('python.profileLines', (params) => {
    const root = deps.requireRoot();
    return runLineProfile({
      root,
      python: deps.resolvePython(root),
      path: params.path,
      tempDir: app.getPath('temp'),
      ...(params.args ? { args: params.args } : {}),
    });
  });

  /* ── Node: окружение проекта ───────────────────────────────────────────── */

  // Версия Node и менеджер пакетов: чем запускается код и чем ставить зависимости.
  router.register('node.info', () => nodeInfo(deps.workspace.rootPath()));

  // Установленные пакеты: то, что лежит в `node_modules` проекта.
  router.register('node.packages', () => installedNodePackages(deps.requireRoot()));

  // Здоровье окружения: нет `node_modules`, не хватает зависимостей, версия Node
  // не под `engines.node`, нет файла блокировки.
  router.register('node.envHealth', () => checkNodeEnvironment(deps.requireRoot()));

  // Форматирование файла инструментом проекта. Уговор тот же, что у `python.format`:
  // текст приходит из renderer и туда же уходит результат, правку проводит документ.
  router.register('node.format', (params) => formatNode(deps.requireRoot(), params.path, params.text));

  // Список тестов проекта: у vitest — с именами, у jest и `node --test` — файлами.
  router.register('node.tests', () => collectNodeTests(deps.requireRoot()));
}
