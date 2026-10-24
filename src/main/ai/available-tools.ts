import type { AiWebSearchSettings } from '../../shared/api';
import type { ChatHostBridge } from './service';
import type { AgentToolSpec } from '../../shared/tools';
import { ALWAYS_AVAILABLE } from '../../shared/tool-policy';
import type { Linter, SymbolSearch, TerminalAgent, TestRunner } from './tool-context';
import { webSearchNeedsKey } from './web-search';

/**
 * Какие инструменты предлагать модели прямо сейчас.
 *
 * Правило одно и оно строгое: инструмент, который заведомо не сработает, хуже
 * отсутствующего — модель потратит шаг на вызов, который не может пройти.
 * Поэтому здесь всё, что зависит от сборки (подключён ли мост к окну, есть ли
 * терминал, линтер, символы, браузер), а не от беседы.
 *
 * Условия чистые: вместо полей сервиса им отдают ровно те возможности, которые
 * у него есть. Так это проверяется без настроек и без окна — и так граф
 * зависимостей виден в сигнатуре, а не в сорока строках условия.
 */

/** Что из окружения есть в этой сборке: остального нет — нет моста или сервиса. */
export interface ToolAvailability {
  host: ChatHostBridge | undefined;
  terminals: TerminalAgent | undefined;
  tests: TestRunner | undefined;
  linter: Linter | undefined;
  symbols: SymbolSearch | undefined;
  /** Есть ли браузер вовсе (его действия). */
  browser: { zoom?: unknown } | undefined;
  /** Браузер включён настройкой — как веб-поиск, а не «если модуль есть». */
  browserEnabled: boolean;
  webSearch: AiWebSearchSettings;
  webFetchEnabled: boolean;
  /** Ключ поиска: свой или запасной от подключения DeepSeek. */
  webSearchKey: string | undefined;
}

/**
 * Готов ли веб-поиск к работе: включён и обеспечен ключом, если тот нужен.
 * Brave без ключа — это инструмент, который заведомо ответит ошибкой, поэтому
 * модели он не предлагается.
 */
export function canUseWebSearch(env: Pick<ToolAvailability, 'webSearch' | 'webSearchKey'>): boolean {
  if (!env.webSearch.enabled) return false;
  return !webSearchNeedsKey(env.webSearch.provider) || Boolean(env.webSearchKey);
}

export function canRunTool(tool: AgentToolSpec, env: ToolAvailability): boolean {
  const { host } = env;
  // Правка файлов в двух формах: по якорю и по позициям. Нужен хоть один мост,
  // вторую форму без своего моста откажет обработчик — своими словами.
  if (tool.name === 'edit') return host?.applyEdits !== undefined || host?.applyPatches !== undefined;
  // Терминал: команда, задание в фоне и живая сессия — без окна команду не
  // подтвердить, а без сервиса терминалов не открыть сессию. Условие одно на
  // все действия, как у браузера: действие без своей возможности откажет
  // словами в обработчике, но в списке у модели инструмент есть.
  if (tool.name.startsWith('terminal')) return env.terminals !== undefined || host?.confirmCommand !== undefined;
  // Проверки: у действий разные возможности (пометки даёт окно, линтер — main),
  // поэтому условие одно на оба, как у браузера и терминала.
  if (tool.name === 'checks') return host?.getDiagnostics !== undefined || env.linter !== undefined;
  // Ресурсы MCP предлагаются только тогда, когда серверы их объявили, — это
  // знает лишь подключение, а проверка синхронная. Схемы добавляет
  // `resourceTools`, поэтому в статическом отборе их нет.
  if (tool.name === 'mcp') return false;
  // Заметки, вопрос, план и его утверждение живут в окне; отказ без него
  // скажет обработчик.
  if (tool.name === 'mind') return host !== undefined;
  if (tool.name === 'show') return host?.openFile !== undefined || host !== undefined;
  // Символы живут на языковом сервере: без него их не предлагаем. Переименование
  // меняет код через сервер: аргументов здесь не видно, поэтому условие общее на
  // все действия — без окна с применением правок `lsp` не предлагается.
  if (tool.name === 'lsp') return env.symbols !== undefined && host?.applyEdits !== undefined;
  // Тесты выполняют код проекта: нужен и резолвер команды, и подтверждение.
  if (tool.name === 'run_tests') return env.tests !== undefined && host?.confirmCommand !== undefined;
  // Поиск одним именем: действия `code` и `sessions` без своей возможности
  // откажут словами в обработчике, а текстовый и документация есть всегда.
  if (tool.name === 'web') return canUseWebSearch(env) || env.webFetchEnabled;
  // Браузер: включается настройкой (как веб-поиск), а действия на странице
  // спрашивают подтверждение — значит, без подключённого окна их не предлагаем.
  if (tool.name === 'browser') {
    if (!env.browser || !env.browserEnabled) return false;
    // Действия браузера не исполнить без окна редактора: `permitBrowser`
    // спрашивает человека через `confirmBrowser`, а без моста молча отвечает
    // отказом. Один признак на все действия — встроенный Chromium и режим масштаба
    // (env.browser.zoom) его не заменяют: подтверждения у них нет.
    return host?.confirmBrowser !== undefined;
  }

  // Всё прочее — только по явному признаку. Новый инструмент без условия в
  // этой проверке модели не предлагается вовсе (это видно в пробе), а не
  // открывается ей сам собой: раньше дефолт был «main — значит можно».
  return ALWAYS_AVAILABLE.has(tool.name);
}
