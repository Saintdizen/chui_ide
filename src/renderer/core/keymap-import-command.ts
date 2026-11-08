import { importIdeaKeymap, importVsCodeKeymap, mergeImportedOverrides } from '../../shared/keymap-import';
import type { KeybindingOverride } from '../../shared/keybindings';
import type { DefineCommand } from './command-args';
import type { RpcClient } from './rpc';

export interface KeymapImportDeps {
  rpc: RpcClient;
  /** Текущие переопределения: своё импорт не перебивает. */
  current: () => readonly KeybindingOverride[];
  apply: (overrides: KeybindingOverride[]) => void;
  /** Сказать число словами: «перенесено 12 из 40». */
  notify: (message: string, kind?: 'info' | 'error' | 'success') => void;
}

/**
 * Импорт чужой карты клавиш — из VS Code и IDEA.
 *
 * Две команды, а не одна с «угадай по расширению»: по одному `ctrl+s` не
 * отличить `keybindings.json` от XML профиля IDEA, а угадывание открывало бы
 * не тот разбор и говорило «не понял» на целый корректный файл.
 *
 * Итог говорится ЧИСЛАМИ («перенесено 12 из 40, 28 не нашли пары»): молчать о
 * пропущенном значило бы дать думать, что перенеслось всё, и потом искать
 * пропавшие сочетания по одному.
 */
export function registerKeymapImportCommands(define: DefineCommand, deps: KeymapImportDeps): void {
  const run = async (kind: 'vscode' | 'idea'): Promise<void> => {
    try {
      const picked = await deps.rpc.request('dialog.openFile', {
        title: kind === 'vscode' ? 'Карта клавиш VS Code' : 'Профиль клавиш IDEA',
        filters:
          kind === 'vscode'
            ? [{ name: 'Карта клавиш', extensions: ['json'] }]
            : [{ name: 'Профиль IDEA', extensions: ['xml'] }],
      });
      if (picked.path === null) return;

      const file = await deps.rpc.request('workspace.readFile', { path: picked.path });
      const result =
        kind === 'vscode' ? importVsCodeKeymap(file.text) : importIdeaKeymap(file.text);
      if (result.error) {
        deps.notify(`Не разобрал файл: ${result.error}`, 'error');
        return;
      }
      if (result.total === 0) {
        // Ноль сочетаний — либо пустой файл, либо выбран не тот вид.
        deps.notify('В файле не нашлось ни одного сочетания клавиш', 'error');
        return;
      }

      const merged = mergeImportedOverrides(deps.current(), result.overrides);
      deps.apply(merged.overrides);
      const parts = [`перенесено ${merged.overrides.length - deps.current().length} из ${result.total}`];
      if (merged.skipped > 0) parts.push(`${merged.skipped} уже были настроены — не трогал`);
      if (result.unknown.length > 0) {
        const shown = result.unknown.slice(0, 3).join(', ');
        const rest = result.unknown.length > 3 ? ` и ещё ${result.unknown.length - 3}` : '';
        parts.push(`без пары: ${shown}${rest}`);
      }
      deps.notify(parts.join('; '));
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  define(
    { id: 'keymap.importVsCode', title: 'Импорт карты клавиш VS Code…', category: 'Вид' },
    () => run('vscode'),
  );
  define(
    { id: 'keymap.importIdea', title: 'Импорт карты клавиш IDEA…', category: 'Вид' },
    () => run('idea'),
  );
}
