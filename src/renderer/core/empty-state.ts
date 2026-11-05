/**
 * Что сказать на пустом месте в дереве — и что предложить сделать.
 *
 * Почему отдельным чистым модулем: текст пустоты — не украшение, а диагноз.
 * «Папка пуста» на пяти разных бедах — это один и тот же ответ на вопросы,
 * которых пять: проект без файлов, папка без детей, корень пропал с диска,
 * папка битком набита исключённым, поиск ничего не нашёл. Разные беды —
 * разные слова и разные кнопки, иначе человек ищет у себя то, чего нет.
 */

/** Почему на этом месте ничего не видно. */
export type EmptyReason =
  /** Открыт проект, но файлов в нём нет совсем. */
  | 'project-empty'
  /** Папка прочитана и действительно пуста. */
  | 'folder-empty'
  /** Корень проекта больше не читается: папку переименовали, удалили, отключили диск. */
  | 'root-gone'
  /** Фильтр дерева ничего не нашёл. */
  | 'filter-empty'
  /** Всё содержимое папки спрятано масками `explorer.exclude`. */
  | 'excluded-only';

/** Действие под текстом: подпись и что оно делает. */
export interface EmptyAction {
  readonly label: string;
  /** Команда, которую нужно выполнить. Пусто у действия, которое делает хозяин вида. */
  readonly command?: string;
}

/** Готовое пустое состояние: заголовок, объяснение, действие. */
export interface EmptyState {
  readonly title: string;
  readonly hint: string;
  readonly action: EmptyAction | null;
}

/**
 * Текст и действие для пустого места.
 *
 * `patterns` нужны только для `excluded-only`: по ним человек видит, какая
 * маска спрятала всё, и правит её, а не ищет наугад.
 */
export function emptyState(reason: EmptyReason, patterns: readonly string[] = []): EmptyState {
  switch (reason) {
    case 'project-empty':
      return {
        title: 'В проекте пока нет файлов',
        hint: 'Создайте первый файл — он появится в дереве сразу.',
        action: { label: 'Создать файл', command: 'file.newFile' },
      };
    case 'folder-empty':
      return {
        title: 'Папка пуста',
        hint: 'Файлы можно создать здесь — место уже выбрано.',
        action: { label: 'Создать файл', command: 'file.newFile' },
      };
    case 'root-gone':
      return {
        // Не «ошибка чтения»: папка не сломалась, её нет. И виноват не человек —
        // так и говорим, иначе он ищет у себя опечатку в правах доступа.
        title: 'Папка проекта больше не открывается',
        hint: 'Её могли переименовать, перенести или отключить диск.',
        action: { label: 'Выбрать другую папку', command: 'workspace.openFolder' },
      };
    case 'filter-empty':
      return {
        title: 'Ничего не найдено',
        hint: 'Ни один файл не подходит под фильтр — попробуйте другое слово.',
        // Команды сброса фильтра нет: поле живёт в дереве. Действие местное.
        action: { label: 'Сбросить фильтр' },
      };
    case 'excluded-only':
      return {
        title: 'Всё содержимое исключено',
        hint:
          patterns.length > 0
            ? `Папка не пустая: её прячут маски ${patterns.join(', ')}.`
            : 'Папка не пустая: её прячут правила исключения.',
        // Действие местное: показать здесь, не трогая настройку чужого проекта.
        action: { label: 'Показать всё равно' },
      };
  }
}

/**
 * Какой из случаев на самом деле перед нами.
 *
 * Порядок проверок — это и есть смысл: пропавший корень важнее пустоты (иначе
 * человек пойдёт создавать файл в папку, которой нет), а исключённое важнее
 * пустоты — иначе он поверит, что папка пуста, хотя она полна.
 */
export function emptyReasonFor(state: {
  readonly isLoading: boolean;
  readonly failed: boolean;
  readonly hasFilter: boolean;
  readonly total: number;
  readonly shown: number;
  readonly excluded: number;
  readonly isRoot: boolean;
}): EmptyReason | null {
  if (state.isLoading) return null;
  if (state.failed) return state.isRoot ? 'root-gone' : null;
  if (state.hasFilter) return state.shown === 0 ? 'filter-empty' : null;
  if (state.shown > 0) return null;
  // Папка не пуста, но и не показана: всё съели маски.
  if (state.excluded > 0) return 'excluded-only';
  if (state.total > 0) return null;
  return state.isRoot ? 'project-empty' : 'folder-empty';
}
