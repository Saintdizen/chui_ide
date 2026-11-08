import type { LspDiagnostic } from '../../shared/api/lsp';
import type { RpcClient } from './rpc';

/**
 * Орфография открытого файла словарями проекта (cSpell).
 *
 * Зачем вторая проверка рядом со встроенной (`core/spellcheck.ts`): встроенная
 * знает русский и английский из одного файла и работает по строкам — быстро, но
 * мимо словарного запаса проекта. У команды свои имена библиотек и термины, и
 * если она уже завела `cspell.json`, подчёркивания в IDE должны совпадать с её
 * прогоном в CI, а не спорить с ним.
 *
 * Считается в main: там настоящий cSpell со всеми словарями, а в окне остались
 * бы мегабайты слов. Заодно прогон не блокирует ввод.
 */
export interface SpellServerCheckDeps {
  rpc: Pick<RpcClient, 'request'>;
  /** Пометки файла отдельным источником: cSpell не должен затирать ошибки LSP. */
  setMarkers(path: string, diagnostics: LspDiagnostic[]): void;
  /** Включена ли проверка орфографии вообще (настройка `editor.spellcheck`). */
  enabled(): boolean;
  /** Словарь проекта: `editor.spellProjectWords`, свои термины поверх словарей. */
  projectWords(): readonly string[];
}

/**
 * Проверка одного файла. `text` берём тот, что видит человек (с несохранёнными
 * правками): иначе подчёркивания отстают от текста на одно сохранение.
 */
export type SpellServerCheck = (path: string, text: string) => Promise<void>;

export function createSpellServerCheck(deps: SpellServerCheckDeps): SpellServerCheck {
  // Какой файл проверяется сейчас. Ответ на прошлый запрос не должен лечь на
  // новый файл: человек переключил вкладку, а сервер ещё считал старое.
  let current: string | null = null;

  return async (path, text) => {
    if (!deps.enabled()) {
      deps.setMarkers(path, []);
      return;
    }
    current = path;
    const diagnostics = await deps.rpc
      .request('spell.serverDiagnostics', { path, text, words: [...deps.projectWords()] })
      .catch(() => null);
    // Не ответили или ответили не про этот файл — оставляем как было, а не
    // стираем пометки: пустой список читался бы как «здесь всё верно».
    if (diagnostics === null || current !== path) return;
    deps.setMarkers(path, diagnostics);
  };
}
