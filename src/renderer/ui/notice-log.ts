import { type Notice } from '../core/notice-registry';
import { clear, h } from './dom';
import { createModal } from './modal';
// Журнал — тот же, в который пишет тост: окно только читает его и ведёт по адресам.
import { notices } from './toast';

export interface NoticeLogDeps {
  /** Исполнить шаг записи: «Куда смотреть» и кнопка действия живут в командах. */
  execute(command: string, args?: unknown[]): void;
  /**
   * Настройки — второе место, куда может вести отказ: если у уведомления нет
   * команды, но есть подсказка словами («Настройки → AI → Ключ»), человек идёт в одно
   * и то же место и не ищет по меню.
   */
  openSettings?: () => void;
}

export interface NoticeLogView {
  /** Окно целиком — приложение вставляет его в тело документа один раз. */
  element: HTMLElement;
  open(): void;
  close(): void;
}

const KIND_LABEL: Record<Notice['kind'], string> = {
  info: 'Сведения',
  error: 'Ошибка',
  success: 'Готово',
};

/** Когда это было — в человеческих словах: «14:05», «вчера». */
function whenLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  if (at >= dayStart.getTime()) return time;
  const yesterday = dayStart.getTime() - 24 * 3600_000;
  if (at >= yesterday) return `вчера, ${time}`;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}, ${time}`;
}

/**
 * Журнал уведомлений: «что было, пока я смотрел в код».
 *
 * Дефект, который это лечит: отказ жил в тосте и умирал вместе с ним. Текст
 * «не удалось подключиться» был, а вернуться к нему было некуда — ни повторить
 * шаг, ни узнать, где это чинится. Записи реестра теперь несут и то и другое,
 * а окно их показывает.
 */
export function createNoticeLog(deps: NoticeLogDeps): NoticeLogView {
  const list = h('ul', { class: 'notice-log', role: 'list' });
  const empty = h(
    'p',
    { class: 'notice-log-empty' },
    'Пока ничего не случилось — здесь появятся отказы и сообщения, в том числе пропущенные.',
  );

  const modal = createModal({
    className: 'notice-log-modal',
    title: 'Уведомления',
  });
  // Тело своё: окно даёт только рамку, а список живёт в модуле — его перерисовка
  // должна быть рядом с данными, которые она читает.
  modal.body.append(h('div', { class: 'notice-log-body' }, list, empty));

  function row(notice: Notice): HTMLElement {
    const actions = h('div', { class: 'notice-log-actions' });
    if (notice.source) {
      const source = notice.source;
      // «Куда смотреть» — двумя путями: окно, если оно названо, или подсказка словами.
      // Без команды это всё равно полезно: человеку назвали место, а не оставили с носом.
      const hint = source.command
        ? h(
            'button',
            {
              class: 'notice-log-sys-button',
              type: 'button',
              onclick: () => deps.execute(source.command ?? '', source.args),
            },
            source.where,
          )
        : h(
            'button',
            {
              class: 'notice-log-sys-button',
              type: 'button',
              onclick: () => deps.openSettings?.(),
            },
            source.where,
          );
      actions.append(h('span', { class: 'notice-log-sys' }, 'Куда смотреть: ', hint));
    }
    if (notice.action) {
      const action = notice.action;
      actions.append(
        h(
          'button',
          {
            class: 'notice-log-action',
            type: 'button',
            onclick: () => {
              deps.execute(action.command, action.args);
            },
          },
          action.label,
        ),
      );
    }

    return h(
      'li',
      { class: `notice-log-row is-${notice.kind}` },
      h(
        'div',
        { class: 'notice-log-head' },
        h('span', { class: 'notice-log-kind' }, KIND_LABEL[notice.kind]),
        h('span', { class: 'notice-log-time' }, whenLabel(notice.lastAt)),
        // Счётчик показывает именно «снова то же самое»: повтор — это отдельное
        // наблюдение, а не шум, который надо размазать по списку.
        ...(notice.count > 1 ? [h('span', { class: 'notice-log-count' }, `×${notice.count}`)] : []),
      ),
      h('p', { class: 'notice-log-text' }, notice.text),
      actions,
    );
  }

  function render(): void {
    const items = notices.history();
    clear(list);
    empty.hidden = items.length > 0;
    // Свежие сверху: журнал — это взгляд назад, а не хроника по порядку.
    for (const notice of [...items].reverse()) {
      list.append(row(notice));
      // Открытый журнал — это и есть «увидел»: непрочитанное в нём гаснет само.
      notices.markSeen(notice.key);
    }
  }

  return {
    element: modal.element,
    open(): void {
      render();
      modal.open();
    },
    close(): void {
      modal.close();
    },
  };
}
