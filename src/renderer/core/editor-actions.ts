/**
 * Действия редактора, которых нет среди наших команд.
 *
 * У самого редактора есть свой набор действий (свернуть всё, форматировать…), и часть
 * из них не заведена командами окна. Раньше превращение «действие редактора» → «пункт
 * палитры» жило прямо в обвязке регистрации в `app.ts`, вперемешку с `commands.register`
 * и обработчиком ошибок, — и проверить, например, что ключевые слова складываются из
 * id и псевдонима, было нельзя.
 *
 * Здесь только форма пункта: id с префиксом, заголовок, категория, ключевые слова.
 * Регистрация и ошибки — дело окна.
 */

/** Действие редактора в том виде, в каком его отдаёт `editors.listActions()`. */
export interface EditorActionFacts {
  /** Идентификатор внутри редактора, например `foldAll`. */
  id: string;
  /** Подпись для человека — она же заголовок пункта палитры. */
  label: string;
  /** Второе имя, по которому действие ищут (часто английское). Может отсутствовать. */
  alias?: string | null;
}

/** Пункт палитры для действия редактора. */
export interface EditorActionCommand {
  /** Префикс `editor.` — чтобы не спорить с командами окна по имени. */
  id: string;
  title: string;
  category: 'Редактор';
  keywords: string[];
}

/** Категория всех таких пунктов — одна: по ней их и находят в палитре. */
export const EDITOR_ACTION_CATEGORY = 'Редактор' as const;

/**
 * Пункт палитры для действия редактора.
 *
 * Ключевые слова — id и псевдоним: по ним ищут на латинице, а подпись у нас
 * русская. Пустой псевдоним в список не попадает, иначе в поиске от него остался бы
 * пустой ключ, совпадающий со всем подряд.
 */
export function editorActionCommand(action: EditorActionFacts): EditorActionCommand {
  return {
    id: `editor.${action.id}`,
    title: action.label,
    category: EDITOR_ACTION_CATEGORY,
    keywords: [action.id, action.alias ?? ''].filter((word) => word.length > 0),
  };
}

/** Все пункты для списка действий — в том же порядке, в каком их отдал редактор. */
export function editorActionCommands(actions: readonly EditorActionFacts[]): EditorActionCommand[] {
  return actions.map(editorActionCommand);
}
