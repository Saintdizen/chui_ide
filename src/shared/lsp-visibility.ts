import { languageFromPath } from './languages';
import type { LspSettings } from './api/lsp';

/** Возможности LSP, которые можно выключить по языку. */
export type LspPerLanguageFeature = 'inlayHintsOff' | 'codeLensOff' | 'hoverOff';

/**
 * Выключена ли возможность (inlay hints / code lens) для языка этого файла.
 *
 * Списки языков лежат в настройках LSP (`inlayHintsOff`/`codeLensOff`) в виде
 * идентификаторов языков (`typescript`, `python`). Пустой список — включено всюду.
 * Решаем до похода к серверу: выключенное не стоит даже запроса.
 */
export function featureOff(
  settings: { lsp: Pick<LspSettings, LspPerLanguageFeature> },
  key: LspPerLanguageFeature,
  filePath: string,
): boolean {
  const off = settings.lsp[key];
  if (!Array.isArray(off) || off.length === 0) return false;
  return off.includes(languageFromPath(filePath).toLowerCase());
}
