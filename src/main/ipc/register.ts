import { PushTopic } from '../../shared/api';
import { lintProject } from '../project/lint';
import { testCommand } from '../project/tests';
import { openIdeWindow } from '../window';
import { type AppDependencies, rpcServices } from './context';
import { registerAiMethods } from './methods/ai';
import { registerAppMethods } from './methods/app';
import { registerDebugMethods } from './methods/debug';
import { registerDialogMethods } from './methods/dialog';
import { registerGitMethods } from './methods/git';
import { registerLanguageMethods } from './methods/language';
import { registerLspMethods } from './methods/lsp';
import { registerProjectMethods } from './methods/project';
import { registerShellMethods } from './methods/shell';
import { registerWindowMethods } from './methods/window';
import { registerWorkspaceMethods } from './methods/workspace';
import { pushToRenderers } from './push';
import { RpcRouter } from './router';

export type { AppDependencies } from './context';

/**
 * Открыть папку как проект: запомнить её, поднять окно IDE, обновить git.
 *
 * Один путь на все входы: стартовое окно, путь в командной строке, `open-file`
 * на macOS и второй запуск приложения. Разные пути означали бы, что проект,
 * открытый из терминала, чем-то отличается от открытого из стартового окна —
 * например, не попадает в историю или не обновляет состояние git.
 */
export async function openProjectFolder(
  deps: AppDependencies,
  folder: string,
): Promise<{ root: string; name: string }> {
  const info = await deps.workspace.open(folder);
  deps.settings.rememberProject(info.root);
  openIdeWindow();
  await deps.git.refresh();
  return { root: info.root, name: info.name };
}

/**
 * Связываем сервисы с контрактом RPC. Компилятор следит за тем, чтобы
 * аргументы и результат каждого метода совпадали с shared/api.ts.
 */
export function registerIpc(deps: AppDependencies): RpcRouter {
  const router = new RpcRouter();
  // Домены получают сервисы вместе с двумя общими вопросами (корень проекта,
  // интерпретатор Python) — раньше они были замыканиями ниже по файлу.
  const services = rpcServices(deps);

  // Терминалы — тоже: агент работает с pty-сессиями, а не только разовыми командами.
  deps.ai.attachTerminals(deps.terminals);
  // Языковой сервер умеет искать по символам («перейти к символу») — это и есть
  // инструмент search (action code). Нет сервера — действие ищет только текстом.
  if (deps.lsp) deps.ai.attachSymbols(deps.lsp);
  // Линтер проекта — действие lint инструмента checks. Движок и запуск живут в main
  // (`project/lint.ts`); корень и интерпретатор Python разрешает это окно, где
  // они уже собраны. Без подключения инструмент модели не предлагается.
  deps.ai.attachLinter({
    lint: (target) => {
      const root = services.requireRoot();
      return lintProject(root, services.resolvePython(root), target);
    },
  });
  // Команда запуска тестов — инструмент run_tests. Резолвер общий с панелью
  // тестов по логике; здесь в main, потому что агент работает в main.
  deps.ai.attachTests({
    command: (target) => {
      const root = services.requireRoot();
      return testCommand(root, services.resolvePython(root), target);
    },
  });
  // Внешние инструменты (MCP): список ведут серверы из настроек, а запускает их
  // этот сервис — агент получает готовые вызовы.
  if (deps.mcp) deps.ai.attachMcp(deps.mcp);

  // Домены подключаются ИМЕНЕМ, а не телом: сам RPC-метод живёт в
  // `methods/<домен>.ts`, а здесь только порядок вызовов.
  registerDialogMethods(router, services);
  registerWorkspaceMethods(router, services);
  registerProjectMethods(router, services);
  registerLanguageMethods(router, services);
  registerWindowMethods(router, services);
  registerAppMethods(router, services);
  registerGitMethods(router, services);
  registerLspMethods(router, services);
  registerShellMethods(router, services);
  registerAiMethods(router, services);
  registerDebugMethods(router, services);

  router.attach();
  deps.host.attach();

  deps.settings.onDidChange((settings) => pushToRenderers(PushTopic.SettingsChanged, settings));

  return router;
}
