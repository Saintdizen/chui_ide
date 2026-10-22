/**
 * Кто сейчас занимает область редактора.
 *
 * Область одна, а претендентов пять: полотно текста, страница браузера,
 * картинка, документ Office и просмотр разметки. Правило выбора — «побеждает
 * самый свежий выбор человека» — раньше было размазано по пяти `sync*`-функциям
 * в `app.ts`, и каждая знала про чужие экраны: картинка прятала документ, документ
 * — разметку, разметка — страницу. Добавить седьмой экран значило править все пять.
 *
 * Здесь правило в одном месте и одной функцией: `pickEditorSurface` говорит, что
 * показывать, а `surfaces` — что на экране погасить. Знания о DOM нет: модуль не
 * трогает элементы, а отдаёт решение. Показ — по-прежнему дело окна, потому что
 * только оно знает, какие у экранов методы.
 */

/** Экран, который может занять область редактора. */
export type EditorSurface = 'text' | 'page' | 'image' | 'doc' | 'markdown';

/** Всё, что решает выбор: состояние вкладок и предпросмотров на текущий момент. */
export interface EditorSurfaceInput {
  /** Активная страница браузера или `null`. */
  activePageId: string | null;
  /** Путь активного файла или `null`. */
  activePath: string | null;
  /** Активная вкладка — картинка. */
  isImage: boolean;
  /** Активная вкладка — документ Office. */
  isOffice: boolean;
  /** У активного файла включён просмотр разметки. */
  markdownPreview: boolean;
}

/**
 * Что показать в области редактора.
 *
 * Порядок старшинства — и он намеренный:
 *   1. Файл, который нельзя править текстом: картинка и документ Office. Человек
 *      выбрал именно его, а страница браузера — прошлый заход.
 *   2. Страница браузера: свой экран, тоже выбор человека. Вкладку файла при ней
 *      не закрывают, поэтому побеждает она только над текстом.
 *   3. Разметка `.md`: режим того же файла, что и текст.
 *   4. Текст — остаётся по умолчанию.
 */
export function pickEditorSurface(input: EditorSurfaceInput): EditorSurface {
  if (input.activePath !== null && input.isImage) return 'image';
  if (input.activePath !== null && input.isOffice) return 'doc';
  if (input.activePageId !== null) return 'page';
  if (input.activePath === null) return 'text';
  if (input.markdownPreview) return 'markdown';
  return 'text';
}

/** Какие экраны держать погашенными при выбранном. */
export function surfacesToHide(shown: EditorSurface): EditorSurface[] {
  const all: EditorSurface[] = ['page', 'image', 'doc', 'markdown'];
  return all.filter((surface) => surface !== shown);
}

/**
 * Решение «что показать» в виде, удобном окну: `shown` — что включить, `hidden` —
 * что выключить, `text` — показан ли настоящий редактор.
 *
 * Окно применяет это так: для каждого экрана из `hidden` зовёт `hide()` и снимает
 * класс `is-<экран>` с области, для `shown` — наоборот. Классов ровно столько же,
 * сколько экранов, и появляются они из одного места.
 */
export function editorSurfacePlan(input: EditorSurfaceInput): {
  shown: EditorSurface;
  hidden: EditorSurface[];
  text: boolean;
} {
  const shown = pickEditorSurface(input);
  return { shown, hidden: surfacesToHide(shown), text: shown === 'text' };
}
