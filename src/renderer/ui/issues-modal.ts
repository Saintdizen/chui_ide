import type { ForgeComment, ForgeInfo, ForgeIssue } from '../../shared/git-platform';
import { issueLabel, issueWebUrl, newIssueWebUrl, openIssueCount, platformLabel } from '../../shared/git-platform';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';

export interface IssuesModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Спросить подтверждение (закрытие задачи — действие на площадке, назад не отменить). */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
}

export interface IssuesModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Состояние задачи — словом и классом для значка (классы те же, что у запросов). */
const STATE_LABEL: Record<ForgeIssue['state'], string> = {
  open: 'открыта',
  closed: 'закрыта',
};

/**
 * Экран задач площадки (issues) — тот же приём, что у запросов на слияние: разговор
 * с площадкой ведёт консольный клиент (`gh`/`glab`), а IDE показывает, что он вернул,
 * и зовёт его же на «создать» и «закрыть». Токены и вход — забота клиента; свой слой
 * авторизации тут намеренно не заводится (см. `ui/forge-modal.ts`).
 *
 * Разметку делим с экраном запросов: классы `.forge-*` общие, потому что и там, и тут
 * список одинаков по устройству (строка с номером, заголовком, состоянием и метками).
 */
export function createIssuesModal(deps: IssuesModalDeps): IssuesModalView {
  let info: ForgeInfo | null = null;
  let issues: ForgeIssue[] = [];
  let busy = false;
  let creating = false;

  const headline = h('div', { class: 'forge-headline' });
  const statusLine = h('div', { class: 'forge-status' });
  const list = h('div', { class: 'forge-list' });

  const titleInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'Заголовок задачи',
  });
  const bodyInput = h('textarea', {
    class: 'field-input forge-body',
    rows: '3',
    spellcheck: false,
    placeholder: 'Описание (необязательно)',
  });
  const createForm = h('div', { class: 'forge-create', hidden: true });

  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Обновить список', onClick: () => void reload() },
    svgIcon('refresh', 14),
  );
  const newButton = h('button', { class: 'icon-btn', type: 'button', title: 'Создать задачу' }, svgIcon('plus', 14));
  newButton.addEventListener('click', () => {
    creating = !creating;
    createForm.hidden = !creating;
    if (creating) titleInput.focus();
  });

  const close = (): void => {
    element.hidden = true;
    creating = false;
    createForm.hidden = true;
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
      { class: 'modal forge-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Задачи' },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Задачи'),
        h('div', { class: 'forge-head-actions' }, refreshButton, newButton, closeButton),
      ),
      h(
        'div',
        { class: 'modal-body' },
        headline,
        statusLine,
        h('div', { class: 'settings-divider' }),
        list,
        createForm,
      ),
    ),
  );

  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      // Escape сперва закрывает форму создания, и только потом сам экран.
      if (creating) {
        creating = false;
        createForm.hidden = true;
        return;
      }
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
      headline.append(h('span', { class: 'forge-repo' }, info?.note || 'Площадка не определена'));
      return;
    }
    const { repo } = info;
    headline.append(
      h('span', { class: 'forge-platform' }, platformLabel(repo.platform)),
      h('code', { class: 'forge-repo-name' }, `${repo.owner}/${repo.repo}`),
      h('span', { class: 'forge-remote' }, info.remote ? `удалённый: ${info.remote}` : ''),
    );
  };

  const renderStatus = (): void => {
    clear(statusLine);
    if (!info) return;
    const parts: string[] = [];
    if (info.cli) parts.push(info.cliAvailable ? `клиент ${info.cli} найден` : `клиент ${info.cli} не найден`);
    if (info.cliAvailable) parts.push(info.authenticated ? 'вход выполнен' : 'вход не выполнен');
    if (issues.length > 0) parts.push(`открытых: ${openIssueCount(issues)}, всего: ${issues.length}`);
    if (parts.length > 0) statusLine.append(h('p', { class: 'forge-line' }, parts.join(' · ')));
    if (info.note) statusLine.append(h('p', { class: 'forge-note' }, info.note));
  };

  /**
   * Обсуждение задачи: список комментариев и поле «написать».
   *
   * Читаем лениво — только когда человек раскрыл блок: список задач нужен сразу,
   * а обсуждение к каждой — по требованию (это ещё один вызов клиента).
   */
  const commentsBlock = (issue: ForgeIssue): { element: HTMLElement; toggle(): void } => {
    const listNode = h('div', { class: 'forge-comment-list' });
    const field = h('textarea', {
      class: 'field-input forge-comment-input',
      rows: '2',
      spellcheck: false,
      placeholder: 'Написать комментарий…',
    });
    const sendButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Отправить');
    const element = h(
      'div',
      { class: 'forge-comments', hidden: true },
      listNode,
      h('div', { class: 'forge-comment-form' }, field, sendButton),
    );

    const renderComments = (comments: ForgeComment[]): void => {
      clear(listNode);
      if (comments.length === 0) {
        listNode.append(h('p', { class: 'forge-empty' }, 'Комментариев пока нет.'));
        return;
      }
      for (const comment of comments) {
        listNode.append(
          h(
            'div',
            { class: 'forge-comment' },
            h(
              'div',
              { class: 'forge-comment-head' },
              h('span', { class: 'forge-comment-author' }, comment.author || 'неизвестный'),
              comment.createdAt ? h('span', { class: 'forge-comment-date' }, comment.createdAt) : null,
            ),
            h('div', { class: 'forge-comment-body' }, comment.body),
          ),
        );
      }
    };

    const load = async (): Promise<void> => {
      clear(listNode);
      listNode.append(h('p', { class: 'field-hint' }, 'Загружаю обсуждение…'));
      try {
        renderComments(await deps.git.forgeIssueComments(issue.number));
      } catch (error) {
        clear(listNode);
        listNode.append(h('p', { class: 'forge-note' }, error instanceof Error ? error.message : String(error)));
      }
    };

    sendButton.addEventListener('click', () => {
      void run(async () => {
        const text = field.value.trim();
        if (text === '') {
          deps.notify('Пустой комментарий', 'error');
          return;
        }
        // Клиент возвращает обновлённый список — рисуем его, а не приписываем эхо.
        renderComments(await deps.git.forgeIssueComment(issue.number, text));
        field.value = '';
        deps.notify('Комментарий отправлен');
      });
    });

    let loaded = false;
    return {
      element,
      toggle: () => {
        element.hidden = !element.hidden;
        if (!element.hidden && !loaded) {
          loaded = true;
          void load();
        }
      },
    };
  };

  /** Одна строка списка: номер с заголовком, автор, метки, действия. */
  const issueRow = (issue: ForgeIssue): HTMLElement => {
    const state = h('span', { class: `forge-state is-${issue.state}` }, STATE_LABEL[issue.state]);

    const open = h('button', { class: 'btn btn-small', type: 'button', title: 'Открыть на площадке' }, 'Открыть');
    open.addEventListener('click', () => {
      const url = issue.url || (info?.repo ? issueWebUrl(info.repo, issue.number) : '');
      if (url) void deps.git.openExternal(url);
    });

    const comments = commentsBlock(issue);
    const discuss = h(
      'button',
      { class: 'btn btn-small', type: 'button', title: 'Показать обсуждение задачи' },
      'Комментарии',
    );
    discuss.addEventListener('click', () => comments.toggle());

    const buttons = h('div', { class: 'forge-row-actions' }, open, discuss);
    // Закрывать имеет смысл только открытую задачу: для закрытой действие бессмысленно.
    if (issue.state === 'open') {
      const closeIssue = h('button', { class: 'btn btn-small', type: 'button' }, 'Закрыть');
      closeIssue.addEventListener('click', () => {
        void run(async () => {
          const confirmed = await deps.confirm({
            title: 'Закрыть задачу',
            message: `Закрыть задачу ${issueLabel(issue)}?`,
            detail: 'Клиент площадки закроет задачу. Открыть её обратно можно уже только на площадке.',
            confirmLabel: 'Закрыть',
          });
          if (!confirmed) return;
          issues = await deps.git.forgeIssueClose(issue.number);
          deps.notify(`Задача #${issue.number} закрыта`);
          render();
        });
      });
      buttons.append(closeIssue);
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
            h('span', { class: 'forge-number' }, `#${issue.number}`),
            h('span', { class: 'forge-title' }, issue.title || '(без заголовка)'),
            state,
          ),
          h(
            'div',
            { class: 'forge-row-meta' },
            issue.author ? h('span', {}, issue.author) : null,
            issue.updatedAt ? h('span', { class: 'forge-updated' }, ` · ${issue.updatedAt}`) : null,
          ),
          issue.labels.length > 0
            ? h(
                'div',
                { class: 'forge-labels' },
                ...issue.labels.map((label) => h('span', { class: 'forge-label' }, label)),
              )
            : null,
        ),
        buttons,
      ),
      comments.element,
    );
  };

  const renderList = (): void => {
    clear(list);
    if (!info) return;
    if (issues.length === 0) {
      list.append(
        h(
          'p',
          { class: 'forge-empty' },
          info.note ? 'Список недоступен — подробности выше.' : 'Задач нет. Создайте новую кнопкой «+».',
        ),
      );
      return;
    }
    for (const issue of issues) list.append(issueRow(issue));
  };

  /** Форма создания: заголовок и описание. */
  const buildCreateForm = (): void => {
    clear(createForm);
    const submit = (): void => {
      void run(async () => {
        const title = titleInput.value.trim();
        if (title === '') {
          deps.notify('Нужен заголовок задачи', 'error');
          return;
        }
        issues = await deps.git.forgeIssueCreate({ title, body: bodyInput.value });
        titleInput.value = '';
        bodyInput.value = '';
        creating = false;
        createForm.hidden = true;
        deps.notify('Задача создана');
        render();
      });
    };

    createForm.append(
      h('div', { class: 'forge-create-head' }, 'Новая задача'),
      titleInput,
      bodyInput,
      h(
        'div',
        { class: 'forge-create-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onClick: submit }, 'Создать'),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            title: 'Открыть страницу создания на площадке',
            onClick: () => {
              if (!info?.repo) return;
              void deps.git.openExternal(newIssueWebUrl(info.repo));
            },
          },
          'Открыть на площадке',
        ),
      ),
    );
  };

  const render = (): void => {
    renderHeadline();
    renderStatus();
    renderList();
    buildCreateForm();
    // Без площадки и клиента создавать нечем: кнопку «+» прячем, а не оставляем мёртвой.
    const canCreate = Boolean(info?.repo && info.cli && info.cliAvailable);
    newButton.hidden = !canCreate;
    if (!canCreate) {
      creating = false;
      createForm.hidden = true;
    }
  };

  async function reload(): Promise<void> {
    try {
      info = await deps.git.forgeInfo();
      issues = info.repo && info.cli && info.cliAvailable ? await deps.git.forgeIssues() : [];
    } catch (error) {
      info = null;
      issues = [];
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
