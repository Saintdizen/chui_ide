/**
 * Мост от токенов к палитре темы.
 *
 * Цвета подсветки в проекте уже есть, и менять их нельзя: редактор, чат и блоки кода
 * в ответах должны выглядеть одинаково. Поэтому подсветка своего редактора берёт
 * цвета из той же таблицы (`core/theme.ts`), что и всё остальное, — по типу токена
 * получает роль палитры, а по роли цвет и начертание.
 *
 * Обёртка нужна ещё и затем, чтобы у зависимости было одно место. Модули подсветки
 * живут сами по себе (`highlight/`), а знание о палитре приложения — здесь; при
 * переносе редактора в другой проект менять придётся только этот файл.
 */

import type { TokenKey } from '../../../shared/theme-file';
import { tokenKeyFor, tokenPalette, type Scheme } from '../../core/theme';

export type { Scheme } from '../../core/theme';

/** Роль палитры для типа токена. `null` — тип бесцветный. */
export function roleOfToken(type: string): TokenKey | null {
  return tokenKeyFor(type);
}

/**
 * Цвета ролей для текущей схемы. Представление ставит их переменными на свой корень,
 * а классы токенов в оформлении (`styles/editor.css`) берут значения оттуда.
 */
export function paletteOf(scheme: Scheme): Record<TokenKey, string> {
  return tokenPalette(scheme);
}
