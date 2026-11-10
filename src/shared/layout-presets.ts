import { sanitizeLayout, type LayoutSettings } from './api/settings';

/**
 * Именованные раскладки панелей: «сохранить эту под именем» и «вернуть».
 *
 * Макет проекта уже живёт в `.chui_ide` — это одна штука на проект. Но
 * положений у работы больше: разбор чужого кода требует широкого ассистента
 * и узкого дерева, отладка — высокой нижней панели, письмо — только
 * редактора. Запоминать их руками, возвращая каждый размер, — работа,
 * которую делает опция.
 *
 * Модуль чистый: ни окна, ни диска — список имён и макетов. Хранит
 * хозяин настроек, и это отдельный ключ от `layout`: сохранить раскладку
 * не значит сделать её текущей по умолчанию.
 */
export interface SavedLayout {
  /** Имя, как его назвал человек. Ключ и подпись — одно и то же. */
  name: string;
  /** Макет на момент сохранения. Копия, а не ссылка: живёт дольше. */
  layout: LayoutSettings;
}

export const MAX_SAVED_LAYOUTS = 12;

/**
 * Сохранить раскладку под именем.
 *
 * То же имя заменяет прежнее: человек, сохраняющий второй раз после правки,
 * правит свою раскладку, а не заводит ей соседа. Имя сравнивается без учёта
 * регистра — «Отладка» и «отладка» из головы не различить.
 *
 * Сверх потолка вытесняется САМАЯ СТАРАЯ: список — это не архив, а набор
 * рабочих положений, и упор в «больше нельзя» без выхода хуже тихой потери
 * того, чем давно не пользовались.
 */
export function saveLayout(layouts: readonly SavedLayout[], name: string, layout: LayoutSettings): SavedLayout[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return [...layouts];
  const rest = layouts.filter((entry) => entry.name.toLowerCase() !== trimmed.toLowerCase());
  const next: SavedLayout[] = [...rest, { name: trimmed, layout: { ...layout } }];
  return next.length > MAX_SAVED_LAYOUTS ? next.slice(next.length - MAX_SAVED_LAYOUTS) : next;
}

/** Убрать раскладку по имени; неизвестное имя — список без изменений. */
export function dropLayout(layouts: readonly SavedLayout[], name: string): SavedLayout[] {
  return layouts.filter((entry) => entry.name.toLowerCase() !== name.trim().toLowerCase());
}

/**
 * Найти раскладку по имени (без учёта регистра). `null` — такой нет.
 *
 * Пустое имя не ищется: «вернуть» с пустой строкой — это забытый ввод, а не
 * просьба найти раскладку с пустым именем (таких и не бывает — см. `saveLayout`).
 */
/**
 * Записи раскладок из файла настроек: кривые выбрасываем.
 *
 * Молча, потому что это файл настроек, а не документ: одна испорченная запись
 * не должна мешать остальным и не должна падать при выборе пункта меню.
 */
export function sanitizePresets(value: unknown): SavedLayout[] {
  if (!Array.isArray(value)) return [];
  const result: SavedLayout[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const name = (raw as { name?: unknown }).name;
    const layout = (raw as { layout?: unknown }).layout;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    if (typeof layout !== 'object' || layout === null) continue;
    result.push({ name: name.trim(), layout: sanitizeLayout(layout as Partial<LayoutSettings>) });
  }
  // Два пункта с одним именем — неразличимы в меню; побеждает первый.
  return result.filter((entry, index) => result.findIndex((other) => other.name === entry.name) === index);
}

export function findLayout(layouts: readonly SavedLayout[], name: string): LayoutSettings | null {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return null;
  const found = layouts.find((entry) => entry.name.toLowerCase() === wanted);
  return found ? { ...found.layout } : null;
}
