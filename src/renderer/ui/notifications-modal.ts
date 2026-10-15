import type { ForgeInfo, ForgeNotification } from '../../shared/git-platform';
import { platformLabel, unreadNotificationCount } from '../../shared/git-platform';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';

export interface NotificationsModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface NotificationsModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/**
 * Экран уведомлений площадки — то, что ждёт внимания человека.
 *
 * У GitHub это непрочитанные ветки обсуждений репозитория (`repos/:repo/notifications`),
 * у GitLab — незакрытые дела проекта (`todos`). Разбираем их одним списком: `title`,
 * вид предмета, причина и «ждёт ли внимания». Разговор с площадкой ведёт клиент
 * `gh`/`glab` — токены и вход остаются за ним (см. `ui/forge-modal.ts`).
 */
export function createNotificationsModal(deps: NotificationsModalDeps): NotificationsModalView {
  let info: ForgeInfo | null = null;
  let notifications: ForgeNotification[] = [];
  let busy = false;

  const headline = h('div', { class: 'forge-headline' });
  const statusLine = h('div', { class: 'forge-status' });
  const list = h('div', { class: 'forge-list' });

  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Обновить список', onClick: () => void reload() },
    svgIcon('refresh', 14),
  );
  const close = (): void => {
    element.hidden = true;
  };
  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal forge-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Уведомления' },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Уведомления'),
        h('div', { class: 'forge-head-actions' }, refreshButton, closeButton),
      ),
      h('div', { class: 'modal-body' }, headline, statusLine, h('div', { class: 'settings-divider' }), list),
    ),
  );

  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await operation();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  const renderHeadline = (): void => {
    clear(headline);
    if (!info?.repo) {
      headline.append(h('span', { class: 'forge-repo' }, 'Площадка не определена'));
      return;
    }
    headline.append(
      h('span', { class: 'forge-platform' }, platformLabel(info.repo.platform)),
      h('code', { class: 'forge-repo-name' }, `${info.repo.owner}/${info.repo.repo}`),
      h('span', { class: 'forge-remote' }, info.remote ? `удалённый: ${info.remote}` : ''),
    );
  };

  const renderStatus = (): void => {
    clear(statusLine);
    if (!info) return;
    if (info.cli) statusLine.append(h('p', { class: 'forge-line' }, `клиент ${info.cli}`));
    if (notifications.length > 0) {
      const unread = unreadNotificationCount(notifications);
      statusLine.append(h('p', { class: 'forge-line' }, `ждут внимания: ${unread} · всего: ${notifications.length}`));
    }
  };

  /** Одна строка: заголовок, вид и причина, время и действия. */
  const notificationRow = (notification: ForgeNotification): HTMLElement => {
    const state = h(
      'span',
      { class: `forge-state is-${notification.unread ? 'open' : 'closed'}` },
      notification.unread ? 'ждёт' : 'прочитано',
    );

    const open = h('button', { class: 'btn btn-small', type: 'button', title: 'Открыть на площадке' }, 'Открыть');
    open.addEventListener('click', () => {
      if (notification.url) void deps.git.openExternal(notification.url);
    });

    const buttons = h('div', { class: 'forge-row-actions' }, open);
    if (notification.unread) {
      const read = h('button', { class: 'btn btn-small', type: 'button', title: 'Отметить прочитанным' }, 'Прочитано');
      read.addEventListener('click', () => {
        void run(async () => {
          notifications = await deps.git.forgeNotificationRead(notification.id);
          deps.notify('Уведомление отмечено прочитанным');
          render();
        });
      });
      buttons.append(read);
    }

    return h(
      'div',
      { class: 'forge-item' },
      h(
        'div',
        { class: 'forge-row' },
        h(
          'div',
          { class: 'forge-row-info' },
          h(
            'div',
            { class: 'forge-row-title' },
            h('span', { class: 'forge-title' }, notification.title || '(без заголовка)'),
            state,
          ),
          h(
            'div',
            { class: 'forge-row-meta' },
            notification.kind ? h('span', {}, notification.kind) : null,
            notification.reason ? h('span', {}, ` · ${notification.reason}`) : null,
            notification.updatedAt ? h('span', { class: 'forge-updated' }, ` · ${notification.updatedAt}`) : null,
          ),
        ),
        buttons,
      ),
    );
  };

  const render = (): void => {
    renderHeadline();
    renderStatus();
    clear(list);
    if (!info) return;
    if (notifications.length === 0) {
      list.append(h('p', { class: 'forge-empty' }, 'Непрочитанного нет — всё разобрано.'));
      return;
    }
    for (const notification of notifications) list.append(notificationRow(notification));
  };

  async function reload(): Promise<void> {
    try {
      info = await deps.git.forgeInfo();
      notifications = info.repo && info.cli ? await deps.git.forgeNotifications() : [];
    } catch (error) {
      info = null;
      notifications = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  async function open(): Promise<void> {
    element.hidden = false;
    headline.replaceChildren();
    statusLine.replaceChildren(h('p', { class: 'field-hint' }, 'Спрашиваю git и клиента площадки…'));
    list.replaceChildren();
    await reload();
  }

  return { element, open, close };
}
