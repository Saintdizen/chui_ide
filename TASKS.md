# Задачи chui_ide

 Открытых пунктов два: только **Чат** (35–36). Оболочка, Проводник,
Редактор и LSP закрыты целиком, их пунктов здесь больше нет. Здесь — только
открытые задачи: сделанное живёт в `git log --follow -p TASKS.md`, а то, что
оно умеет, — в README.

Номера сквозные — на них ссылаемся в коммитах; пропуски в нумерации —
закрытые пункты. У каждого пункта два поля:

- **Уже есть** — что именно в нашем коде делает половину дела (файл и
  символ), чтобы не делать второй раз и не искать заново;
- **Источник** — страница, откуда взято поведение.

Отсюда **правило**: пункт пишется только после `grep` и только если после
него пусто или половина.

Всё, что нашлось готовым, собрано в конце файла — чтобы следующий заход
начинал со списка «не трогать».

---

## Область. Чат


### 35. Правка — в контексте файла

**Дыра.** Рецензия правок и откат (checkpoint) есть
(`ui/chat-approvals.ts`, `ui/chat-checkpoints.ts`), а **показать правку в
файле с контекстом строк и «открыть на строке»** — нет: рецензия голая.

**Уже есть:** `createEditReview`, `revertPlan`, `openAt` (маркдаун уже
понимает `файл:12`).

**Источник:** Zed `agent edits`; JetBrains `AI Assistant`.

### 36. Модель видит то же, что и ты

**Дыра.** Вложение файла есть, а **признака «файл изменился с момента
вложения»** — нет: чип молчит, хотя содержимое ушло другое. Для агента это
не мелочь: он рассуждает о старом коде в уверенном тоне.

**Уже есть:** `ui/chat-attachments.ts`, `core/content-cache.ts`.

**Источник:** Cursor `@-context`; Zed `agent-panel` (context staleness).

---

## Проверено и найдено готовым — НЕ пункт

Если собрались писать пункт про это — сначала посмотрите сюда.

**Оболочка и дерево:** раскладка и размеры (`ui/layout.ts`), возврат фокуса
из палитры (`ui/focus-return.ts`), пауза тоста (`ui/toast.ts:174`),
закрепление и preview-вкладки (`ui/tabs.ts`), фильтр и DnD дерева
(`core/tree-filter.ts`), `aria-activedescendant` (`ui/explorer.ts:1996`),
сортировка и `expandAll`, панель проблем с отбором (`ui/problem-panel.ts`),
палитра символов (`ui/symbol-picker.ts`), breadcrumbs (`core/tree-crumbs.ts`,
`editor/widgets/breadcrumbs-widget.ts`), статус-метр (`ui/status-meter.ts`),
многовыделение в дереве (`core/tree-selection.ts`), цепочка папок
(`core/folder-chain.ts`), свёртка папок в цепочку (`chainDepth`),
автораскрытие активного файла (`explorer.revealActiveFile`), прокрутка дерева
в сессии проекта (`explorerScroll`).

**Редактор:** мультикурсор и column-select (`keymap.ts`, `selection.ts`),
сплиты (`view-commands.ts`), sticky scroll (`editor-view.ts:164`), мягкий
перенос и направляющие отступов (`editor/view/`), сниппеты, авто-закрытие
скобок, regex и многострочный поиск (`editor/find/search.ts`), сводка
«N из M» (`find-widget.ts:272`), задержка наведения (`editor-host.ts:193`).

**Чат:** `chat-markdown.ts` (ссылки `файл:12`), `chat-queue.ts`,
`chat-attachments.ts:128` (чипы), `chat-checkpoints.ts` (откат),
`chat-approvals.ts` (рецензия, команды, план, вопрос), `chat-fork.ts`,
`chat-plan.ts`, `chat-find-bar.ts`, `chat-branch-space.ts`,
`chat-persistence.ts`, `chat-patches.ts`, `chat-notify.ts`, `chat-goal.ts`.

**LSP:** `foldingRange`, `selectionRange`, `documentColor`, `documentLink`,
`inlayHint`, `codeLens`, `semanticTokens` (и `/range`), `callHierarchy`,
`typeHierarchy`, `linkedEditingRange`, `documentHighlight`, `inlineValue`,
`willSaveWaitUntil`, `didChangeWatchedFiles`, `workspaceSymbol/resolve`,
`prepareRename`, file operations, `workspace/configuration`,
`didChangeWorkspaceFolders`, `workspace/diagnostic`, форматирование на лету
(`formatOnType`), пересчёт по просьбе сервера (`REFRESH_METHODS`,
`PushTopic.LspRefresh`) — всё в `main/lsp/lsp.ts` и
`renderer/editor/host/lsp-features.ts`.

**Прочее:** автосохранение (`shared/auto-save.ts`), история и blame
(`core/blame.ts`, `ui/history-modal.ts`), source-control с коммитом,
панели debug, test, notebook, ports, todo, эммет, постикс
(`complete/postfix.ts`), свой эмулятор терминала (`renderer/terminal/**`) —
но сплита терминала нет.

---

## Правила работы со списком

- Пункт закрывается тестом, а не глазами: либо юнит на чистый модуль,
  либо сценарий на `tests/helpers/mini-dom.ts`.
- Перед пунктом — `grep`; после закрытия — снять его отсюда и дописать в
  список «найдено готовым», если по пути нашлось готовое.
- Ссылка на источник — в коммите и в журнале, а не в голове.
