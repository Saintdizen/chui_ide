import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { createMarkdownRenderer } from './chat-markdown';
import { clear, h } from './dom';

/**
 * Предпросмотр Markdown: разметка открытого файла, как её прочитает читатель.
 *
 * Отдельная вкладка нижней панели, а не экран поверх редактора: правку видно и в
 * разметке, и в тексте сразу — держать оба перед глазами и есть смысл предпросмотра.
 * Рисует его тот же разборщик, что ленту чата (`chat-markdown.ts`): он собирает узлы
 * напрямую, без `innerHTML`, поэтому чужой markdown не вставит разметку в интерфейс.
 *
 * Панель ничего не читает сама: текст активного файла берётся из документа (с
 * несохранёнными правками). Перерисовка идёт по правке с небольшой задержкой и только
 * когда панель на виду: пересобирать разметку на каждое нажатие незачем. Когда открыт не
 * markdown — говорим об этом, а не показываем пустоту: пустота читалась бы как «сломалось».
 */

export interface MarkdownPreviewDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  /** Вставить код из блока в позицию курсора (кнопка «Вставить»). */
  insertCode(code: string): boolean;
  /** Короткий путь для заголовка панели. */
  relativePath(path: string): string;
  /** Панель сейчас на экране — обновлять её, пока скрыта, смысла нет. */
  isVisible(): boolean;
}

export interface MarkdownPreviewView {
  element: HTMLElement;
  /** Перерисовать по активному файлу (вызывается при показе вкладки). */
  refresh(): void;
}

/** Пауза перед перерисовкой: разметку смотрим не на каждое нажатие. */
const REFRESH_DELAY = 250;

/** Файл, который умеет показывать предпросмотр: markdown и его родня. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx|mdown|mkd)$/i.test(path);
}

export function createMarkdownPreview(deps: MarkdownPreviewDeps): MarkdownPreviewView {
  const renderer = createMarkdownRenderer({ insertCode: (code) => deps.insertCode(code) });

  const title = h('span', { class: 'md-preview-title' }, 'Предпросмотр Markdown');
  const pathLabel = h('span', { class: 'md-preview-path' });
  const head = h('div', { class: 'md-preview-head' }, title, pathLabel);
  const body = h('div', { class: 'md-preview-body' });
  const element = h('div', { class: 'md-preview' }, head, body);

  let timer: number | null = null;

  const note = (text: string): void => {
    clear(body);
    body.appendChild(h('div', { class: 'empty-note' }, h('p', {}, text)));
  };

  const render = (): void => {
    const path = deps.openEditors.active?.path ?? null;
    if (!path) {
      pathLabel.textContent = '';
      note('Файл не открыт: предпросмотр показывает активный файл Markdown.');
      return;
    }
    pathLabel.textContent = deps.relativePath(path);
    if (!isMarkdownPath(path)) {
      note('Активный файл — не Markdown. Откройте файл .md, чтобы увидеть разметку.');
      return;
    }
    const text = deps.documents.get(path)?.value ?? '';
    renderer.renderInto(body, text);
    // Пустой файл начнут печатать — а пока подсказка вместо пустоты.
    if (body.textContent === '') note('Файл пуст — начните печатать, и разметка появится тут.');
  };

  const refresh = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    render();
  };

  // Смена активного файла — другой markdown: панель на виду, значит обновляем сразу.
  deps.openEditors.onDidChange(() => {
    if (deps.isVisible()) refresh();
    else if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  });
  // Правка текста: перерисовка с задержкой и только для показанного файла.
  deps.documents.onDidChange(({ document }) => {
    if (!deps.isVisible() || document.path !== deps.openEditors.active?.path) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      render();
    }, REFRESH_DELAY);
  });

  refresh();

  return { element, refresh };
}
