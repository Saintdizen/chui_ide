import type { ForgeInfo, ForgeRequest } from '../../shared/git-platform';
import {
  branchesLabel,
  newRequestWebUrl,
  openRequestCount,
  platformLabel,
  requestWebUrl,
  requestWord,
} from '../../shared/git-platform';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';
import { createSelect } from './select';

export interface ForgeModalDeps {
  git: GitModel;
  /** Текущая ветка — её предлагаем влить по умолчанию. */
  currentBranch(): string | null;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Спросить подтверждение (забрать ветку запроса — это смена рабочего дерева). */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
}

export interface ForgeModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Состояние запроса — словом и классом для значка. */
const STATE_LABEL: Record<ForgeRequest['state'], string> = {
  open: 'открыт',
  draft: 'черновик',
  merged: 'слит',
  closed: 'закрыт',
};

/**
 * Экран запросов на слияние (PR/MR) — своя обёртка над консольными клиентами площадок.
 *
 * Прямого разговора с API GitHub/GitLab тут нет намеренно. Токены, вход и все запросы
 * берёт на себя тот клиент, которым человек уже пользуется, — `gh` или `glab`. IDE
 * лишь показывает, что он вернул, и зовёт его же на «создать» и «забрать ветку».
 * Если клиента нет или вход не выполнен, окно говорит об этом словами, а не молчит:
 * иначе пустой список выглядел бы как «запросов нет».
 */
export function createForgeModal(deps: ForgeModalDeps): ForgeModalView {
  let info: ForgeInfo | null = null;
  let busy = false;
  let creating = false;

  const headline = h('div', { class: 'forge-headline' });
  const statusLine = h('div', { class: 'forge-status' });
  const list = h('div', { class: 'forge-list' });

  const titleInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'Заголовок запроса',
  });
  const bodyInput = h('textarea', {
    class: 'field-input forge-body',
    rows: '3',
    spellcheck: false,
    placeholder: 'Описание (необязательно)',
  });
  const targetSelect = createSelect({ title: 'Целевая ветка', placeholder: 'как настроено' });
  const draftBox = h('input', { type: 'checkbox' });
  const createForm = h('div', { class: 'forge-create', hidden: true });

  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Обновить список', onClick: () => void reload() },
    svgIcon('refresh', 14),
  );
  const newButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Создать запрос на слияние' },
    svgIcon('plus', 14),
  );
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
      { class: 'modal forge-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Запросы на слияние' },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Запросы на слияние'),
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
    if (info.requests.length > 0) {
      const open = openRequestCount(info.requests);
      parts.push(`открытых: ${open}, всего: ${info.requests.length}`);
    }
    if (parts.length > 0) statusLine.append(h('p', { class: 'forge-line' }, parts.join(' · ')));
    if (info.note) statusLine.append(h('p', { class: 'forge-note' }, info.note));
  };

  /** Одна строка списка: номер с заголовком, ветки, автор, действия. */
  const requestRow = (request: ForgeRequest): HTMLElement => {
    const state = h('span', { class: `forge-state is-${request.state}` }, STATE_LABEL[request.state]);

    const open = h('button', { class: 'btn btn-small', type: 'button', title: 'Открыть на площадке' }, 'Открыть');
    open.addEventListener('click', () => {
      const url = request.url || (info?.repo ? requestWebUrl(info.repo, request.number) : '');
      if (url) void deps.git.openExternal(url);
    });

    const buttons = h('div', { class: 'forge-row-actions' }, open);
    // Ветку имеет смысл забирать только у открытого запроса: слитый или закрытый
    // переключать некуда — работа уже закончена.
    if (request.state === 'open' || request.state === 'draft') {
      const checkout = h('button', { class: 'btn btn-small', type: 'button' }, 'Забрать ветку');
      checkout.addEventListener('click', () => {
        void run(async () => {
          const confirmed = await deps.confirm({
            title: 'Забрать ветку запроса',
            message: `Переключиться на ветку «${request.sourceBranch}» запроса #${request.number}?`,
            detail:
              'Клиент площадки сам сделает fetch и переключит рабочее дерево. Текущие правки должны быть ' +
              'закоммичены или отложены, иначе git откажется переключаться.',
            confirmLabel: 'Забрать',
          });
          if (!confirmed) return;
          await deps.git.forgeCheckout(request.number);
          deps.notify(`Ветка «${request.sourceBranch}» запроса #${request.number} забрана`);
          await reload();
        });
      });
      buttons.append(checkout);
    }

    return h(
      'div',
      { class: 'forge-row' },
      h(
        'div',
        { class: 'forge-row-info' },
        h(
          'div',
          { class: 'forge-row-title' },
          h('span', { class: 'forge-number' }, `#${request.number}`),
          h('span', { class: 'forge-title' }, request.title || '(без заголовка)'),
          state,
        ),
        h(
          'div',
          { class: 'forge-row-meta' },
          h('code', { class: 'forge-branches' }, branchesLabel(request)),
          request.author ? h('span', {}, ` · ${request.author}`) : null,
          request.updatedAt ? h('span', { class: 'forge-updated' }, ` · ${request.updatedAt}`) : null,
        ),
        request.labels.length > 0
          ? h(
              'div',
              { class: 'forge-labels' },
              ...request.labels.map((label) => h('span', { class: 'forge-label' }, label)),
            )
          : null,
      ),
      buttons,
    );
  };

  const renderList = (): void => {
    clear(list);
    if (!info) return;
    if (info.requests.length === 0) {
      list.append(
        h(
          'p',
          { class: 'forge-empty' },
          info.note
            ? 'Список недоступен — подробности выше.'
            : `Открытых ${requestWord(info.repo?.platform ?? 'github')} нет. Создайте новый кнопкой «+».`,
        ),
      );
      return;
    }
    for (const request of info.requests) list.append(requestRow(request));
  };

  /** Форма создания: заголовок, описание, целевая ветка и «черновик». */
  const buildCreateForm = (): void => {
    clear(createForm);
    const current = deps.currentBranch();
    const submit = (): void => {
      void run(async () => {
        const title = titleInput.value.trim();
        if (title === '') {
          deps.notify('Нужен заголовок запроса', 'error');
          return;
        }
        info = await deps.git.forgeCreate({
          title,
          body: bodyInput.value,
          target: targetSelect.value || undefined,
          draft: draftBox.checked,
        });
        titleInput.value = '';
        bodyInput.value = '';
        draftBox.checked = false;
        creating = false;
        createForm.hidden = true;
        deps.notify('Запрос на слияние создан');
        render();
      });
    };

    createForm.append(
      h(
        'div',
        { class: 'forge-create-head' },
        current ? `Ветка «${current}» — предлагаем влить` : 'Создание запроса на слияние',
      ),
      titleInput,
      bodyInput,
      h(
        'div',
        { class: 'forge-create-row' },
        h('span', { class: 'field-name' }, 'Влить в'),
        targetSelect.element,
        h('label', { class: 'forge-draft' }, draftBox, 'черновик'),
      ),
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
              const url = newRequestWebUrl(info.repo, current ?? '', targetSelect.value || '');
              void deps.git.openExternal(url);
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
    } catch (error) {
      info = null;
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  async function open(): Promise<void> {
    element.hidden = false;
    headline.replaceChildren();
    statusLine.replaceChildren(h('p', { class: 'field-hint' }, 'Спрашиваю git и клиента площадки…'));
    list.replaceChildren();
    // Целевые ветки — те, что есть у площадки глазами git: локальные и удалённые.
    const branches = await deps.git
      .branches()
      .then((items) => items.map((branch) => ({ value: branch.name, label: branch.name })))
      .catch(() => [] as { value: string; label: string }[]);
    targetSelect.setOptions([{ value: '', label: 'как настроено в клиенте' }, ...branches]);
    await reload();
  }

  return { element, open, close };
}
