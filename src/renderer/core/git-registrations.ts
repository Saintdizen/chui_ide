import type { DefineCommand } from './command-args';
import { registerGitAiCommands } from './git-ai-commands';
import { registerGitHistoryCommands } from './git-history-commands';
import { registerGitPanelCommands } from './git-panel-commands';
import { registerGitSyncCommands } from './git-sync-commands';
import { registerGitToolsCommands } from './git-tools-commands';
import { registerGitViewCommands } from './git-view-commands';
import { registerGitWriteCommands } from './git-write-commands';
import { createSymbolPickers } from './symbol-pickers';

/**
 * Порты семи домов git и списков символов. У каждого дома свой набор — они и
 * собраны здесь по именам, чтобы видно было, кто что трогает, не открывая сами дома.
 */
export interface GitRegistrationsDeps {
  define: DefineCommand;
  write: Parameters<typeof registerGitWriteCommands>[1];
  ai: Parameters<typeof registerGitAiCommands>[1];
  view: Parameters<typeof registerGitViewCommands>[1];
  panel: Parameters<typeof registerGitPanelCommands>[1];
  tools: Parameters<typeof registerGitToolsCommands>[1];
  history: Parameters<typeof registerGitHistoryCommands>[1];
  sync: Parameters<typeof registerGitSyncCommands>[1];
}

/**
 * Семь домов git — только регистрация, без решений: каждое тело живёт в своём
 * `core/git-*-commands.ts`, а здесь остаются стадии сборки окна к нему.
 *
 * Порядок не важен — дома не делят имён команд — но сохранён тем же, в каком
 * они читались в `app.ts`: снизу вверх по тому, что человек может сделать с
 * репозиторием (записать → показать → выбрать из списка → синхронизировать).
 */
export function registerGitCommands(deps: GitRegistrationsDeps): void {
  registerGitWriteCommands(deps.define, deps.write);
  registerGitAiCommands(deps.define, deps.ai);
  registerGitViewCommands(deps.define, deps.view);
  registerGitPanelCommands(deps.define, deps.panel);
  registerGitToolsCommands(deps.define, deps.tools);
  registerGitHistoryCommands(deps.define, deps.history);
  registerGitSyncCommands(deps.define, deps.sync);
}

/**
 * Списки символов — не git, но живут рядом: те же «выбери из списка и перейди».
 * Состав и переходы в `core/symbol-pickers.ts`, команды он регистрирует сам.
 */
export function registerSymbolLists(deps: Parameters<typeof createSymbolPickers>[0]): void {
  createSymbolPickers(deps);
}
