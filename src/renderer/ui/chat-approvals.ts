import type { FileEdit } from '../../shared/edits';
import { fileWord } from './chat-text';
import { h, svgIcon } from './dom';

/**
 * Решения, которые агент спрашивает у человека прямо в ленте чата: ревью правок и
 * подтверждение команды.
 *
 * Оба устроены одинаково: рисуем карточку в ленте, ждём нажатия и отдаём ответ
 * обещанием. Прерванный вызов агента не должен оставить карточку «висеть» — поэтому
 * хозяин (панель чата) регистрирует у нас функцию отмены и зовёт её, когда разговор
 * прерывают (см. `closeApprovals` в `chat.ts`).
 *
 * Здесь только интерфейс и разметка: ни беседы, ни отправки запросов этот модуль
 * не знает. Текст файла для предпросмотра и место вставки приходят снаружи.
 */

/** Ограничения показа: ревью — не редактор, длинные пачки правок ему не нужны. */
const MAX_REVIEW_HUNKS = 20;
const MAX_REVIEW_LINES = 20;

export interface EditPreviewFile {
  path: string;
  error?: string;
  hunks: Array<{ label: string; removed: string[]; added: string[] }>;
  /** Сколько правок не поместилось в предпросмотр. */
  extra?: number;
}

export interface ApprovalHost {
  /** Текущий текст файла: открытый документ или с диска. `null` — прочитать не вышло. */
  readText(path: string): Promise<string | null>;
  /** Вставить карточку решения в ленту. */
  mount(block: HTMLElement): void;
  /** Прокрутить ленту к карточке. */
  scrollToEnd(): void;
  /** Зарегистрировать отмену; возвращает функцию снятия регистрации. */
  register(cancel: () => void): () => void;
}

/**
 * Предпросмотр правок одного файла. Чистая функция: по тексту и правкам строит
 * то, что показываем, — без DOM и запросов. Вынесена отдельно, поэтому проверяется
 * тестами (см. `tests/chat-review.test.ts`).
 */
export function previewFile(file: FileEdit, text: string | null): EditPreviewFile {
  if (text === null) return { path: file.path, error: 'не удалось прочитать файл', hunks: [] };

  const lines = text.split('\n');
  const hunks = file.edits.slice(0, MAX_REVIEW_HUNKS).map((edit) => {
    // Пустой диапазон (начало и конец совпадают) — это вставка: правка ничего не
    // удаляет, и показывать строку как удалённую было бы враньём.
    const insertion = edit.startLine === edit.endLine && edit.startColumn === edit.endColumn;
    return {
      label: edit.startLine === edit.endLine ? `строка ${edit.startLine}` : `строки ${edit.startLine}–${edit.endLine}`,
      removed: insertion ? [] : lines.slice(edit.startLine - 1, edit.endLine).slice(0, MAX_REVIEW_LINES),
      added: edit.newText.length === 0 ? [] : edit.newText.replace(/\n$/, '').split('\n').slice(0, MAX_REVIEW_LINES),
    };
  });

  return { path: file.path, hunks, extra: file.edits.length - hunks.length };
}

export interface EditReview {
  /**
   * Показать предложенные правки и дождаться решения. Ничего не применяет — это
   * делает вызывающий. Возвращает выбранные файлы или `null`, если отклонили всё.
   */
  review(fileEdits: readonly FileEdit[]): Promise<FileEdit[] | null>;
}

export function createEditReview(host: ApprovalHost): EditReview {
  async function review(fileEdits: readonly FileEdit[]): Promise<FileEdit[] | null> {
    const files = await Promise.all(fileEdits.map(async (file) => previewFile(file, await host.readText(file.path))));

    const block = h('div', { class: 'review' });
    const checks: HTMLInputElement[] = [];

    /** Сводка в шапке и подпись кнопки — по числу отмеченных файлов. */
    const head = h('div', { class: 'review-head' }, svgIcon('wrench', 13), h('span', { class: 'review-title' }));
    block.appendChild(head);

    files.forEach((file) => {
      const box = h('input', { class: 'review-check', type: 'checkbox' }) as HTMLInputElement;
      box.checked = true;
      checks.push(box);

      const section = h(
        'div',
        { class: 'review-file' },
        h('label', { class: 'review-file-head' }, box, h('span', { class: 'review-path' }, file.path)),
      );
      if (file.error) section.appendChild(h('div', { class: 'review-error' }, file.error));
      for (const hunk of file.hunks) {
        const group = h('div', { class: 'review-hunk' }, h('div', { class: 'review-range' }, hunk.label));
        for (const line of hunk.removed) group.appendChild(h('div', { class: 'review-del' }, `- ${line}`));
        for (const line of hunk.added) group.appendChild(h('div', { class: 'review-add' }, `+ ${line}`));
        section.appendChild(group);
      }
      if (file.extra) section.appendChild(h('div', { class: 'review-error' }, `… и ещё правок: ${file.extra}`));
      block.appendChild(section);
    });

    const status = h('span', { class: 'review-status' });
    let settle: (result: FileEdit[] | null) => void = () => undefined;
    const decision = new Promise<FileEdit[] | null>((resolve) => {
      settle = resolve;
    });

    const checkedIndexes = (): number[] => checks.flatMap((box, index) => (box.checked ? [index] : []));

    /** Решение принято — разбор правок больше не нужен: остаётся строка итога. */
    function finish(approved: boolean, note: string): void {
      unregister();
      const chosen = approved ? checkedIndexes() : [];
      block.classList.toggle('review-rejected', !approved || chosen.length === 0);
      block.classList.add('decision-done');
      const applied = files.filter((_, index) => chosen.includes(index));
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('wrench', 12),
          h(
            'span',
            {},
            approved && applied.length > 0
              ? `Правки применены · ${applied.length} ${fileWord(applied.length)}`
              : approved
                ? 'Ничего не выбрано'
                : 'Правки отклонены',
          ),
          note ? h('span', { class: 'decision-status' }, note) : null,
        ),
      );
      settle(approved && chosen.length > 0 ? fileEdits.filter((_, index) => chosen.includes(index)) : null);
    }

    const applyButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, '') },
      'Применить',
    );
    const rejectButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, '') },
      'Отклонить',
    );
    const allButton = h(
      'button',
      {
        class: 'link-btn review-all',
        type: 'button',
        onClick: () => {
          const all = checks.every((box) => box.checked);
          for (const box of checks) box.checked = !all;
          syncCount();
        },
      },
      'Все / ничего',
    );

    // Вызов агента прервали — отвечать ревью больше некому, закрываем его.
    const abort = (): void => finish(false, 'отменено');
    const unregister = host.register(abort);

    /** Сколько файлов отмечено: это видно в шапке и на кнопке. */
    function syncCount(): void {
      const count = checkedIndexes().length;
      head.querySelector('.review-title')!.textContent =
        `Ассистент предлагает правки · ${files.length} ${fileWord(files.length)} · отмечено ${count}`;
      applyButton.textContent = count > 0 ? `Применить (${count})` : 'Применить';
      applyButton.disabled = count === 0;
    }
    for (const box of checks) box.addEventListener('change', syncCount);
    syncCount();

    block.appendChild(h('div', { class: 'review-actions' }, applyButton, rejectButton, allButton, status));
    host.mount(block);
    host.scrollToEnd();

    return decision;
  }

  return { review };
}

export interface CommandApproval {
  /** Спросить разрешение на запуск команды; `true` — выполнять. */
  confirm(command: string): Promise<boolean>;
}

export function createCommandApproval(host: ApprovalHost): CommandApproval {
  function confirm(command: string): Promise<boolean> {
    const block = h('div', { class: 'approval' });
    block.appendChild(
      h('div', { class: 'approval-head' }, svgIcon('warning', 13), h('span', {}, 'Ассистент просит выполнить команду')),
    );
    block.appendChild(h('pre', { class: 'approval-command' }, command));
    block.appendChild(h('div', { class: 'field-hint' }, 'Команда выполнится в папке проекта от вашего имени.'));

    const status = h('span', { class: 'approval-status' });
    let settle: (allowed: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    /** Решение принято — команда и подсказка больше не нужны: остаётся строка статуса. */
    function finish(allowed: boolean, note: string): void {
      unregister();
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('terminal', 12),
          h('span', {}, 'Выполняется скрипт'),
          note ? h('span', { class: 'decision-status' }, note) : null,
        ),
      );
      block.scrollIntoView({ block: 'nearest' });
      settle(allowed);
    }

    const runButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, 'разрешено') },
      'Выполнить',
    );
    const skipButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, 'отменено') },
      'Отменить',
    );
    const abort = (): void => finish(false, 'отменено');
    const unregister = host.register(abort);

    block.appendChild(h('div', { class: 'approval-actions' }, runButton, skipButton, status));
    host.mount(block);
    host.scrollToEnd();

    return decision;
  }

  return { confirm };
}
