/**
 * Установка зависимостей и выбор интерпретатора — то, что раньше жило замыканиями
 * в `app.ts` и потому не проверялось ни одним тестом.
 *
 * Здесь нет ни одной ссылки на UI: ни попапа, ни редактора, ни попадания в DOM.
 * Кому показать итог (`toast`), где взять настройки и как перезапустить сервер
 * подсказок — приходит функциями от вызывающего. Именно поэтому модуль можно
 * проверить в тесте: RPC подменяется шпионом, и видно, какие запросы ушли.
 */

import type { VenvLookup } from '../../shared/python-env';
import type { ProjectTools } from './project-tools';
import type { RpcClient } from './rpc';
import { nodeInstallTarget, type RunTarget } from './run-config';

export interface InstallActionsOptions {
  rpc: RpcClient;
  /** Итог словами для человека: «Готово: numpy», отказ pip и т. п. */
  toast: (message: string, kind?: 'info' | 'success' | 'error') => void;
  /** Свои настройки, чтобы дописать `run.pythonPath` / `run.pythonByRoot`. */
  settings: () => { run: { pythonPath: string; pythonByRoot: Record<string, string> } };
  /** Куда писать выбор интерпретатора: `null` — проект закрыт, писать некуда. */
  root: () => string | null;
  /** Чем ставить Node-пакеты: инструменты проекта для команды установки. */
  projectTools: () => ProjectTools;
  /** Поставить Node-зависимости в терминал: вывод длинный, его читают руками. */
  runInTerminal: (target: RunTarget) => Promise<void>;
  /** Пакеты появились — подчёркнутые импорты должны это увидеть. */
  refreshImports: () => void;
  /** Сменить интерпретатор — перезапустить сервер подсказок под новое окружение. */
  onInterpreterChanged: () => void;
}

/**
 * Что сказать, когда установка прошла. Явные пакеты называем поимённо — человек
 * искал именно их; пустой список значит «все объявленные», и тогда незачем
 * перечислять пустоту: `pip install -r requirements.txt` ставит что найдёт.
 */
export function installedMessage(installed: readonly string[], nothing: string): string {
  return installed.length > 0 ? `Готово: ${installed.join(', ')}` : nothing;
}

export function createInstallActions(options: InstallActionsOptions) {
  const { rpc, toast, settings, root, onInterpreterChanged, refreshImports, runInTerminal, projectTools } = options;

  /**
   * Python ставит сам main (`python.install`) — и стримом, потому что pip бывает
   * долгим. Пакеты появились — подчёркнутые импорты должны это увидеть.
   */
  const installPythonPackages = async (packages: string[], requirements = false): Promise<void> => {
    if (!root()) {
      toast('Проект не открыт', 'error');
      return;
    }
    toast(packages.length > 0 ? `Ставлю: ${packages.join(', ')}…` : 'Устанавливаю зависимости…');
    try {
      const result = await rpc.stream('python.install', { packages, requirements }, () => undefined);
      toast(installedMessage(result.installed, 'Нечего ставить'));
      refreshImports();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  /** Кнопка «установить из requirements.txt»: список пакетов пуст намеренно. */
  const installRequirements = (): Promise<void> => installPythonPackages([], true);

  /**
   * Node ставится в терминал, а не через RPC: вывод `npm install` длинный, его
   * читают и прерывают руками. Команду собирает `nodeInstallTarget`.
   */
  const installNodePackages = async (packages: string[]): Promise<void> => {
    const tools = projectTools();
    if (!tools.root) {
      toast('Проект не открыт', 'error');
      return;
    }
    await runInTerminal(nodeInstallTarget(tools, packages));
    refreshImports();
  };

  /**
   * Запомнить интерпретатор за ЭТИМ проектом: два Python-проекта не должны
   * подменять друг другу окружение. Пусто — вернуться к общему: ключ удаляется,
   * а не пишется пустой строкой, иначе проект «помнит» ничего.
   *
   * Инструменты и кнопка запуска пересчитываются сами по push-событию настроек
   * (`applySettings`), поэтому здесь только запись.
   */
  const setProjectInterpreter = async (command: string): Promise<void> => {
    const key = root();
    if (!key) return;
    const pythonByRoot = { ...settings().run.pythonByRoot };
    if (command) pythonByRoot[key] = command;
    else delete pythonByRoot[key];
    await rpc.request('settings.update', { run: { pythonByRoot } });
    onInterpreterChanged();
  };

  /**
   * Взять окружение, которое уже есть: папку указывают руками. Путь проверяет main
   * (`python.venvAt`): «похоже на venv» — знание о раскладке bin/Scripts, а не об окне.
   *
   * Проверка обязательна. В диалоге папок легко указать соседнюю — и проект тихо
   * остался бы на прежнем питоне, а причину искали бы в коде. Поэтому не подошло —
   * человеку фраза, а не тишина.
   *
   * Без проекта выбирать «для проекта» нечего: интерпретатор остаётся общим.
   */
  const pickExistingVenv = async (): Promise<void> => {
    const picked = await rpc.request('dialog.pickFolder', { title: 'Папка виртуального окружения' });
    if (!picked.path) return;
    const found: VenvLookup = await rpc.request('python.venvAt', { path: picked.path });
    const environment = found.environment;
    if (!environment) {
      toast(found.reason ?? 'В выбранной папке нет виртуального окружения', 'error');
      return;
    }
    if (root()) await setProjectInterpreter(environment.python);
    else await rpc.request('settings.update', { run: { pythonPath: environment.python } });
    toast(`Интерпретатор: ${environment.label}`);
    // Подсказки подняты со старым интерпретатором — перезапускаем: у нового
    // окружения может найтись и свой pylsp.
    onInterpreterChanged();
  };

  return { installPythonPackages, installRequirements, installNodePackages, setProjectInterpreter, pickExistingVenv };
}

export type InstallActions = ReturnType<typeof createInstallActions>;
