import type { GitBranch, GitChange, GitFileStatus } from '../../shared/api';
import type { CommandRegistry } from '../core/commands';
import type { GitModel } from '../core/git-model';
import type { WorkspaceModel } from '../core/workspace-model';
import { parseAuthorInput, parseCoAuthors, withCoAuthors } from '../../shared/git-identity';
import { changesLabel, rootSummaryLabel } from '../../shared/git-multiroot';
import { groupByPackage, NO_PACKAGE } from '../../shared/monorepo';
import type { ProjectPackagesModel } from '../core/project-packages';
import { showContextMenu } from './context-menu';
import { clear, h, svgIcon, type IconName } from './dom';
import { createSelect } from './select';

const CHANGE_LETTER: Record<GitChange, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

const CHANGE_TITLE: Record<GitChange, string> = {
  modified: 'изменён',
  added: 'добавлен в индекс',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'новый файл',
  conflicted: 'конфликт слияния',
};

export interface SourceControlDeps {
  git: GitModel;
  workspace: WorkspaceModel;
  commands: CommandRegistry;
  /** Спросить строку текста (диалог приложения): нужен для соавторов коммита. */
  askText?(options: { title: string; label: string; value: string }): Promise<string | null>;
  /** Сообщить о сбое рядом с панелью. */
  notify?(message: string, kind?: 'info' | 'error'): void;
  /**
   * Пакеты проекта: в монорепо правки раскладываются по ним, а не идут одним списком.
   * Нет модели — список остаётся плоским (обычный репозиторий).
   */
  packages?: ProjectPackagesModel;
}

export interface SourceControlView {
  element: HTMLElement;
  /** Поставить курсор в поле сообщения — этим панель «открывается». */
  focus(): void;
  /**
   * Подставить готовое сообщение в поле (сообщение коммита по diff). Именно
   * подставить, а не отправить: человек его прочитает и поправит перед коммитом.
   */
  setMessage(text: string): void;
}

/**
 * Панель изменений: ветка, сообщение коммита и два списка — проиндексированные
 * и остальные правки. Своих операций над репозиторием панель не делает:
 * она шлёт команды, поэтому то же действие доступно из палитры и от ассистента.
 */
export function createSourceControl(deps: SourceControlDeps): SourceControlView {
  const branchName = h('span', { class: 'sc-branch-name', title: 'Правый клик — действия с ветками' });
  const branchSelect = createSelect({ title: 'Текущая ветка', placeholder: 'нет ветки', class: 'sc-branch-select' });
  const branchInput = h('input', {
    class: 'sc-branch-input',
    type: 'text',
    placeholder: 'Имя новой ветки, Enter — создать',
    spellcheck: false,
  });
  const branchCreate = h('div', { class: 'sc-branch-create', hidden: true }, branchInput);

  const message = h('textarea', {
    class: 'sc-message',
    rows: 3,
    spellcheck: false,
    placeholder: 'Что изменилось?',
  });
  // Подсказка про Ctrl+Enter — значком в углу поля: словами она занимала место в
  // placeholder, а рядом с полем читалась как третья кнопка.
  const messageField = h(
    'div',
    { class: 'sc-message-box' },
    message,
    h('span', { class: 'sc-message-hint' }, svgIcon('keyboard', 12), 'Ctrl+Enter'),
  );
  const commitButton = h(
    'button',
    {
      class: 'btn btn-primary sc-commit',
      type: 'button',
      title: 'Закоммитить проиндексированное',
      onClick: () => void commit(),
    },
    'Закоммитить',
  );

  // «Исправить последний коммит»: переключатель в строке действий под полем —
  // так он попадает в один ряд с «Соавтором» и «Сообщением по diff», а не
  // висит отдельной строкой в футере. Пустое сообщение при нём сохраняет прежнее
  // (см. `git.amendCommit`).
  const amendBox = h('input', { class: 'sc-amend-box', type: 'checkbox' });
  const amendRow = h(
    'label',
    { class: 'sc-amend', title: 'Заменить последний коммит вместо создания нового' },
    amendBox,
    h('span', {}, 'Исправить последний'),
  );
  // Подпись кнопки коммита: режим amend и число проиндексированных. Пересчитывается
  // и в render, и при переключении флажка — иначе текст врёт о действии.
  let commitLabel: HTMLSpanElement | null = null;
  let stagedCount = 0;
  const syncCommitLabel = (): void => {
    if (!commitLabel) return;
    const action = amendBox.checked ? 'Исправить' : 'Закоммитить';
    commitLabel.textContent = stagedCount === 0 ? action : `${action} (${stagedCount})`;
  };
  amendBox.addEventListener('change', syncCommitLabel);
  // Соавторы: строка `Co-authored-by` дописывается в сообщение коммита. Панель не
  // придумывает людей сама — спрашивает имя и почту и дописывает их к тексту.
  const coAuthorButton = h(
    'button',
    {
      class: 'sc-coauthor',
      type: 'button',
      title: 'Дописать соавтора в сообщение коммита',
      'aria-label': 'Дописать соавтора в сообщение коммита',
    },
    svgIcon('userPlus', 13),
  );
  const coAuthorList = h('div', { class: 'sc-coauthors' });

  // Сообщение коммита из diff: одна кнопка — модель прочитает правки и предложит текст.
  // Кнопка шлёт команду, а не пишет сама: текст кладёт команда (у неё и AI-мост, и тосты),
  // а панель только показывает поле и умеет его заполнить.
  const messageFromDiffButton = h(
    'button',
    {
      class: 'sc-from-diff',
      type: 'button',
      title: 'Сообщение коммита по diff (AI)',
      onClick: () => void deps.commands.execute('git.generateCommitMessage'),
    },
    svgIcon('sparkle', 13),
  );

  const stagedGroup = h('div', { class: 'sc-group' });
  const unstagedGroup = h('div', { class: 'sc-group' });
  const hint = h('p', { class: 'sc-hint' });
  const initButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onClick: () => void deps.commands.execute('git.init'),
    },
    'Создать репозиторий',
  );

  const newBranchButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Новая ветка',
      onClick: () => openBranchInput(),
    },
    svgIcon('plus', 14),
  );

  /** Расхождение с удалённой веткой: сколько коммитов уехало и сколько не подтянуто. */
  const syncState = h('span', { class: 'sc-sync-state', hidden: true });

  /** Кнопка синхронизации: одна из трёх (fetch, pull, push) — различаются иконкой и командой. */
  const syncButton = (title: string, icon: IconName, command: string): HTMLButtonElement =>
    h(
      'button',
      { class: 'icon-btn', type: 'button', title, onClick: () => void deps.commands.execute(command) },
      svgIcon(icon, 14),
    );

  const fetchButton = syncButton('Забрать изменения (git fetch)', 'refresh', 'git.fetch');
  const pullButton = syncButton('Влить изменения из удалённого (git pull)', 'arrowDown', 'git.pull');
  const pushButton = syncButton('Отправить коммиты (git push)', 'arrowUp', 'git.push');
  // Отложенные изменения: своё окно — записи не мешают текущим правкам.
  const stashButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Отложенные изменения (stash)',
      onClick: () => void deps.commands.execute('git.openStash'),
    },
    svgIcon('archive', 14),
  );

  /** Сводка по корням рабочей области: видна, когда папок в окне несколько. */
  const rootsList = h('div', { class: 'sc-roots', hidden: true });
  // Обновить все папки области разом: кнопка рядом с заголовком списка корней.
  const rootsBox = h(
    'div',
    { class: 'sc-roots-box', hidden: true },
    h(
      'div',
      { class: 'sc-roots-head' },
      h('span', {}, 'Папки области'),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Забрать изменения во всех папках (fetch)',
          onClick: () => void deps.commands.execute('git.fetchRoots'),
        },
        svgIcon('refresh', 13),
      ),
    ),
    rootsList,
  );

  const element = h(
    'div',
    { class: 'source-control' },
    h(
      'div',
      { class: 'sc-head' },
      // Текущая ветка — только селект: отдельные иконка и подпись дублировали бы
      // то, что он и так показывает. Значок ветки едет значением опции.
      branchSelect.element,
      syncState,
      h(
        'div',
        { class: 'panel-actions' },
        // Три группы по смыслу, а не одна куча иконок: забрать (fetch) — отдельно
        // от «туда-обратно» (pull/push), ветки и отложенное — третья пара.
        fetchButton,
        h('span', { class: 'panel-actions-sep' }),
        pullButton,
        pushButton,
        h('span', { class: 'panel-actions-sep' }),
        stashButton,
        newBranchButton,
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Обновить состояние',
            onClick: () => void deps.commands.execute('git.refresh'),
          },
          svgIcon('refresh', 14),
        ),
      ),
    ),
    branchCreate,
    rootsBox,
    h(
      'div',
      { class: 'sc-commit-box' },
      messageField,
      coAuthorList,
      // Строка действий — под полем, в один ряд: изменение режима слева,
      // добавления справа. Кнопка коммита живёт ниже, у списка файлов.
      h('div', { class: 'sc-commit-rows' }, amendRow, h('div', { class: 'sc-commit-rows-right' }, coAuthorButton, messageFromDiffButton)),
    ),
    // Всё, что осталось, — файлы: это скроллируемая зона, она забирает высоту
    // (`flex: 1 1 auto` у `.sc-list`), поэтому футер виден при любом размере списка.
    h('div', { class: 'sc-list' }, stagedGroup, unstagedGroup, initButton),
    // Нижняя панель: подсказка слева, главное действие — справа во всю ширину панели.
    h(
      'div',
      { class: 'sc-footer' },
      h('div', { class: 'sc-footer-hint' }, hint),
      h(
        'button',
        { class: 'btn btn-primary sc-commit-block', type: 'button', onClick: () => void commit() },
        svgIcon('check', 14),
        // Подпись меняется в `render` (режим amend и число проиндексированных).
        (commitLabel = h('span', {}, 'Закоммитить')),
      ),
    ),
  );

  /** Показать уже упомянутых в сообщении соавторов — с кнопкой «убрать строку». */
  const renderCoAuthors = (): void => {
    const authors = parseCoAuthors(message.value);
    clear(coAuthorList);
    coAuthorList.hidden = authors.length === 0;
    for (const author of authors) {
      const remove = h('button', { class: 'icon-btn sc-coauthor-remove', type: 'button', title: 'Убрать соавтора' });
      remove.append(svgIcon('close', 12));
      remove.addEventListener('click', () => {
        const line = `Co-authored-by: ${author.name} <${author.email}>`;
        message.value = message.value
          .split('\n')
          .filter((row) => row.trim().toLowerCase() !== line.toLowerCase())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/\n+$/, '');
        renderCoAuthors();
        syncCommitDisabled();
      });
      coAuthorList.append(
        h('div', { class: 'sc-coauthor-row' }, h('span', {}, `${author.name} <${author.email}>`), remove),
      );
    }
  };

  coAuthorButton.addEventListener('click', async () => {
    if (!deps.askText) return;
    const answer = await deps.askText({
      title: 'Соавтор коммита',
      label: 'Имя <почта> — обратный порядок тоже годится',
      value: '',
    });
    if (answer === null) return;
    const author = parseAuthorInput(answer);
    if (!author) {
      deps.notify?.('Не разобрал почту соавтора — нужен адрес вида mail@example.com', 'error');
      return;
    }
    message.value = withCoAuthors(message.value, [author]);
    renderCoAuthors();
    syncCommitDisabled();
  });

  message.addEventListener('input', renderCoAuthors);
  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void commit();
    }
  });

  branchSelect.onChange((name) => {
    if (name) void deps.commands.execute('git.checkout', name);
  });

  /* ── создание ветки: поле открывается кнопкой «+», Enter — создать ── */

  function openBranchInput(): void {
    branchCreate.hidden = false;
    branchInput.value = '';
    branchInput.focus();
  }

  function closeBranchInput(): void {
    branchCreate.hidden = true;
    branchInput.value = '';
  }

  branchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBranchInput();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = branchInput.value.trim();
    if (!name) return;
    closeBranchInput();
    void deps.commands.execute('git.createBranch', name);
  });

  // Уход фокуса закрывает поле — как у строки переименования в дереве.
  branchInput.addEventListener('blur', () => closeBranchInput());

  // Правый клик по имени ветки — операции, которые в строку не влезают:
  // создание, переименование и удаление.
  branchName.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!deps.git.isRepository) return;
    showContextMenu(
      [
        { label: 'Новая ветка…', onSelect: () => openBranchInput() },
        { separator: true as const },
        { label: 'Переименовать текущую ветку…', onSelect: () => void deps.commands.execute('git.renameBranch') },
        { label: 'Удалить ветку…', danger: true, onSelect: () => void deps.commands.execute('git.deleteBranch') },
      ],
      event.clientX,
      event.clientY,
    );
  });

  const commit = async (): Promise<void> => {
    const amend = amendBox.checked;
    const info = await deps.commands.execute(amend ? 'git.amendCommit' : 'git.commit', message.value);
    // Сообщение очищаем только при успешном коммите: иначе текст не вернуть.
    if (info) {
      message.value = '';
      // Режим — на один раз: следующее нажатие снова создаёт обычный коммит.
      if (amend) amendBox.checked = false;
    }
    syncCommitDisabled();
  };

  /** Кнопка коммита активна, если есть сообщение — или выбран amend (тогда
      сообщение можно не писать: сохранится прежнее). */
  const syncCommitDisabled = (): void => {
    commitButton.disabled = message.value.trim().length === 0 && !amendBox.checked;
  };

  const row = (file: GitFileStatus, staged: boolean): HTMLElement => {
    const action = h(
      'button',
      {
        class: 'sc-row-action',
        type: 'button',
        title: staged ? 'Убрать из индекса' : 'Проиндексировать',
        onClick: (event: Event) => {
          event.stopPropagation();
          void deps.commands.execute(staged ? 'git.unstage' : 'git.stage', file.path);
        },
      },
      svgIcon(staged ? 'minus' : 'plus', 13),
    );

    return h(
      'button',
      {
        class: `sc-row is-${file.change}`,
        type: 'button',
        title: `${file.relative} — ${CHANGE_TITLE[file.change]}`,
        onClick: () => void deps.commands.execute('git.showDiff', file.path, staged),
        onContextMenu: (event: Event) => openMenu(file, staged, event as MouseEvent),
      },
      // Чекбокс слева — как в обычном списке выбора. Клик по нему = кнопка вправо:
      // одна и та же операция, но с той стороны, где рука ищет «выбрать этот файл».
      h(
        'span',
        { class: `sc-row-check${staged ? ' is-checked' : ''}`, 'aria-hidden': 'true' },
        svgIcon(staged ? 'check' : 'square', 12),
      ),
      h('span', { class: 'sc-row-name' }, deps.workspace.relative(file.path)),
      // Статус (M, U) — справа, рядом с кнопкой индексации.
      h('span', { class: `sc-badge is-${file.change}`, title: CHANGE_TITLE[file.change] }, CHANGE_LETTER[file.change]),
      action,
    );
  };

  const openMenu = (file: GitFileStatus, staged: boolean, event: MouseEvent): void => {
    event.preventDefault();
    showContextMenu(
      [
        { label: 'Показать различия', onSelect: () => void deps.commands.execute('git.showDiff', file.path, staged) },
        { label: 'История файла', onSelect: () => void deps.commands.execute('git.fileHistory', file.path) },
        { label: 'Открыть файл', onSelect: () => void deps.commands.execute('file.revealAt', file.path, 1, 1) },
        // У конфликтного файла предлагаем сначала разрешение: обычное сравнение
        // здесь мало помогает — смотреть надо на обе стороны.
        ...(file.change === 'conflicted'
          ? [
              { separator: true as const },
              {
                label: 'Разрешить конфликт',
                onSelect: () => void deps.commands.execute('git.resolveConflicts', file.path),
              },
            ]
          : []),
        { separator: true as const },
        staged
          ? { label: 'Убрать из индекса', onSelect: () => void deps.commands.execute('git.unstage', file.path) }
          : { label: 'Проиндексировать', onSelect: () => void deps.commands.execute('git.stage', file.path) },
        {
          label: 'Откатить правки',
          danger: true,
          onSelect: () => void deps.commands.execute('git.discard', file.path, CHANGE_TITLE[file.change]),
        },
      ],
      event.clientX,
      event.clientY,
    );
  };

  /** Массовое действие группы: кнопка в шапке списка. */
  const groupAction = (title: string, icon: IconName, command: string): HTMLButtonElement =>
    h(
      'button',
      {
        class: 'sc-group-action',
        type: 'button',
        title,
        onClick: (event: Event) => {
          event.stopPropagation();
          void deps.commands.execute(command);
        },
      },
      svgIcon(icon, 13),
    );

  const group = (title: string, files: GitFileStatus[], staged: boolean): void => {
    const host = staged ? stagedGroup : unstagedGroup;
    clear(host);
    host.hidden = files.length === 0;
    // Класс остаётся и у пустой группы: по нему `.sc-list` понимает, что список
    // пуст, и не рисует рамку — она выглядела полоской без содержимого.
    host.classList.toggle('is-empty', files.length === 0);
    if (files.length === 0) return;

    // Действия — справа от счётчика: видно, что можно сделать со всем списком,
    // не открывая контекстное меню каждой строки.
    const actions = h('div', { class: 'sc-group-actions' });
    if (staged) {
      actions.appendChild(groupAction('Убрать всё из индекса', 'minus', 'git.unstageAll'));
    } else {
      actions.appendChild(groupAction('Проиндексировать всё', 'plus', 'git.stageAll'));
      actions.appendChild(groupAction('Откатить все правки', 'revert', 'git.discardAll'));
    }

    host.appendChild(
      h(
        'div',
        { class: 'sc-group-title' },
        h('span', {}, title),
        h('span', { class: 'sc-group-count' }, String(files.length)),
        actions,
      ),
    );
    // Монорепо: внутри группы своего состояния (индекс/рабочее дерево) ещё и пакеты —
    // иначе правка в чужом пакете теряется среди десятка файлов.
    if (deps.packages?.isMonorepo) {
      for (const part of groupByPackage(
        deps.packages.all,
        files.map((file) => file.relative),
      )) {
        const partFiles = part.files
          .map((relative) => files.find((file) => file.relative === relative))
          .filter((file): file is GitFileStatus => file !== undefined);
        host.append(
          h(
            'div',
            { class: 'sc-package', title: part.path === NO_PACKAGE ? '' : part.path },
            h('span', { class: 'sc-package-name' }, part.name),
            h('span', { class: 'sc-group-count' }, String(partFiles.length)),
          ),
        );
        for (const file of partFiles) host.appendChild(row(file, staged));
      }
      return;
    }
    for (const file of files) host.appendChild(row(file, staged));
  };

  const renderBranches = async (): Promise<void> => {
    const current = deps.git.branch;
    const branches: GitBranch[] = await deps.git.branches();
    const signature = branches.map((branch) => `${branch.name}${branch.current ? '*' : ''}`).join('|');
    if (branchSelect.element.dataset.signature === signature) return;

    // Значок — только у текущего значения (слот `valueIcon` в select.ts), не в
    // строках списка: там он повторялся бы у каждой ветки и только шумел.
    // Поэтому опция описывается без `icon`, а значок ставится после `setValue`
    // через собственный слот кнопки.
    branchSelect.setOptions(
      branches.map((branch) => ({
        value: branch.name,
        label: branch.name,
        hint: branch.remote ? 'удалённая' : undefined,
      })),
    );
    branchSelect.element.classList.add('sc-branch-select');
    // Значок ветки — на кнопке селекта, а не отдельной иконкой в шапке.
    branchSelect.setValueIcon('branch');
    branchSelect.element.dataset.signature = signature;
    if (current) branchSelect.setValue(current);
    branchSelect.setHidden(branches.length === 0);
  };

  // Есть ли remote: без него push/pull/fetch бессмысленны, и кнопки только мешают.
  // Список спрашиваем один раз на репозиторий — он не меняется от правок в дереве.
  let remotesFor: string | null = null;
  let hasRemote = false;
  const syncRemotes = async (isRepo: boolean): Promise<void> => {
    const root = deps.git.repository?.root ?? null;
    if (!isRepo || !root) {
      setSyncVisible(false);
      return;
    }
    if (remotesFor !== root) {
      remotesFor = root;
      hasRemote = (await deps.git.remotes()).length > 0;
    }
    setSyncVisible(hasRemote);
  };
  const setSyncVisible = (visible: boolean): void => {
    fetchButton.hidden = !visible;
    pullButton.hidden = !visible;
    pushButton.hidden = !visible;
  };

  /**
   * Сводка по корням области. В обычном проекте корень один — блок скрыт: статус
   * активной папки и так показан ниже. В многообласти перечисляем все папки: видно,
   * где есть правки, а кликом можно переключить активный корень. Список приходит
   * push-событием от main (`git.summary`) — поэтому видны и правки в неактивной папке.
   */
  const renderRoots = (): void => {
    if (!deps.workspace.isMultiRoot) {
      rootsBox.hidden = true;
      clear(rootsList);
      return;
    }
    const activeRoot = deps.workspace.root;
    clear(rootsList);
    rootsBox.hidden = false;
    rootsList.hidden = false;
    for (const summary of deps.git.rootSummaries) {
      const isActive = summary.root === activeRoot;
      rootsList.appendChild(
        h(
          'button',
          {
            class: `sc-root${isActive ? ' is-active' : ''}`,
            type: 'button',
            title: `${summary.root} — ${rootSummaryLabel(summary)}`,
            onClick: () => {
              if (!isActive) void deps.workspace.setActiveRoot(summary.root).catch(() => undefined);
            },
          },
          svgIcon('branch', 12),
          h('span', { class: 'sc-root-name' }, summary.name),
          h('span', { class: 'sc-root-state' }, rootSummaryLabel(summary)),
          h('span', { class: 'sc-root-count' }, changesLabel(summary.files)),
        ),
      );
    }
  };

  // Пакеты нашли или сменили папку — список правок надо переложить по ним.
  deps.packages?.onDidChange(() => render());

  const render = (): void => {
    // Сводку по корням держим свежей: в многообласти папок несколько.
    if (deps.workspace.isMultiRoot) void deps.git.refreshSummary();
    renderRoots();
    const repository = deps.git.repository;
    const isRepo = repository !== null;

    branchName.textContent = repository
      ? (repository.branch ?? `HEAD ${repository.head ?? ''}`.trim())
      : 'не репозиторий';
    branchSelect.setHidden(!isRepo);
    newBranchButton.hidden = !isRepo;
    stashButton.hidden = !isRepo;
    // Синхронизация имеет смысл только в репозитории и только когда есть remote.
    void syncRemotes(isRepo);
    syncState.hidden = !isRepo || (repository?.ahead === 0 && repository?.behind === 0);
    if (isRepo && repository) {
      // Слово «push» рядом с иконкой — дубль: кнопка рядом уже говорит, что делает.
      // Остаётся число со стрелкой вверх (коммиты уедут) и вниз (коммиты заберутся) —
      // направление читается со значка, а цвет отличает две стороны.
      clear(syncState);
      const part = (icon: IconName, count: number, title: string): HTMLElement =>
        h('span', { class: 'sc-sync-part', title }, svgIcon(icon, 11), h('span', {}, String(count)));
      if (repository.ahead > 0) syncState.appendChild(part('arrowUp', repository.ahead, 'Впереди: уйдёт push'));
      if (repository.behind > 0) syncState.appendChild(part('arrowDown', repository.behind, 'Отстаёт: заберёт pull'));
      syncState.title =
        repository.ahead || repository.behind
          ? `Впереди на ${repository.ahead}, отстаёт на ${repository.behind}`
          : '';
    }
    if (!isRepo) closeBranchInput();

    const staged = deps.git.staged;
    const unstaged = deps.git.unstaged;
    group('Проиндексировано', staged, true);
    group('Изменения', unstaged, false);

    const total = staged.length + unstaged.length;
    hint.textContent = total === 0 ? '' : `${total} ${plural(total)}`;
    // Счётчик на кнопке — про проиндексированное: видно, что именно уйдёт в коммит.
    // Подсказка рядом считает все правки, включая ещё не отмеченные, и они не
    // должны сливаться в одно число. В режиме amend подпись говорит прямо, что
    // произойдёт: кнопки «Закоммитить» и «Исправить последний» — разные действия.
    stagedCount = staged.length;
    syncCommitLabel();
    syncCommitDisabled();
    // Исправлять можно только когда есть что: в репозитории и с хотя бы одним коммитом.
    amendRow.hidden = !isRepo || repository?.head == null;
    if (amendRow.hidden) amendBox.checked = false;
    initButton.hidden = isRepo;

    if (!isRepo) {
      stagedGroup.hidden = true;
      unstagedGroup.hidden = true;
      hint.textContent = 'Проект не в репозитории git';
    } else {
      void renderBranches();
    }
  };

  message.addEventListener('input', () => {
    syncCommitDisabled();
  });

  amendBox.addEventListener('change', () => syncCommitDisabled());

  deps.git.onDidChange(render);
  deps.git.onDidChangeSummary(renderRoots);
  render();

  return {
    element,
    focus: () => message.focus(),
    setMessage: (text) => {
      message.value = text;
      renderCoAuthors();
      syncCommitDisabled();
      message.focus();
    },
  };
}

function plural(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл с правками';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла с правками';
  return 'файлов с правками';
}
