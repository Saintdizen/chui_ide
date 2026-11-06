# Задачи chui_ide

Пять областей: **Оболочка IDE**, **Проводник**, **Редактор**, **Чат**, **LSP и
подсказки**. Здесь — только открытые задачи: сделанное живёт в
`git log --follow -p TASKS.md`, а то, что оно умеет, — в README.

Номера сквозные — на них ссылаемся в коммитах; пропуски в нумерации —
закрытые пункты. У каждого пункта два поля:

- **Уже есть** — что именно в нашем коде делает половину дела (файл и
  символ), чтобы не делать второй раз и не искать заново;
- **Источник** — страница, откуда взято поведение.

Сверка 2026-11-06, третья. Две первые были плохи: первый заход брал фичи по
описаниям конкурентов без сверки — 5 из 23 оказались сделанными; второй всё
равно протащил ещё 6 таких же (мягкий перенос, направляющие отступов,
сниппеты, `foldingRange`, `selectionRange`, `documentColor`, `documentLink`,
возврат фокуса из палитры, breadcrumbs — всё это есть).

Отсюда **правило**: пункт пишется только после `grep` и только если после
него пусто или половина.

Счёт на 2026-11-06: было 26 (18–43). Область 5 закрыта целиком — 37, 38
(пересчёт по просьбе сервера, формат на лету) и 39–43 (источник пометки,
умения в списке серверов, подсказка по аргументам, действия по виду,
проект целиком одним запросом). Осталось 20 пунктов (18–36). Всё, что нашлось готовым, собрано в конце файла —
чтобы следующий заход начинал со списка «не трогать».

---

## Область 1. Оболочка IDE

### 18. Раскладка помнит себя не только в размерах

**Дыра.** Размеры колонок и видимость панелей едут в сессию
(`ui/layout.ts` + `persistLayout`), а **активная группа вкладок и их порядок**
— нет: после перезапуска фокус на другой группе, вкладки пересортированы. Не
хватает и восстановления юнитов терминала — в сессию не пишется.

**Уже есть:** `ui/layout.ts` (splitter'ы, `--sidebar-width`),
`app.ts:247` (`onChange` → `session.scheduleSave`).

**Источник:** VS Code `Custom Layout`;
https://code.visualstudio.com/docs/configure/custom-layout

### 19. Команда знает, откуда её позвали

**Дыра.** Палитра возвращает фокус (`ui/focus-return.ts`: `focusOwner`,
`returnFocus`), а прочие «плавающие» входы — нет: меню строки дерева
(`gutterMenus`), меню вкладки, палитра символов (`ui/symbol-picker.ts`)
возвращают фокус в тело окна. После `Esc` выделение в редакторе теряется.

**Уже есть:** `ui/palette.ts:294` — образец правильного поведения;
`ui/focus-return.ts` — готовый механизм, надо подключить.

**Источник:** Zed `key-bindings` (dispatch); https://zed.dev/docs/key-bindings

### 20. Подсказка об отказе объясняет себя

**Дыра.** Отказ сервера или провайдера живёт в тосте: текст есть, а **«Куда
смотреть»** (лог панели, настройка) и список прочитанных после перезапуска —
нет. Человек видит ошибку, которую уже видел, и не может вернуться к старой.

**Уже есть:** `ui/toast.ts` (пауза при наведении), `ui/notifications-modal.ts`.

**Источник:** VS Code `Notifications`;
https://code.visualstudio.com/docs/configure/accessibility

### 21. Статусная строка — вход в причину

**Дыра.** Кнопки есть (29 `onClick` в `ui/statusbar.ts`), а **клавиатурного
доступа** к ним нет: элементы — `div` без `tabindex` и без `aria-label`
действия; с клавиатуры к языку, ветке и кодировке не попасть.

**Уже есть:** `ui/statusbar.ts`, `ui/status-meter.ts`.

**Источник:** VS Code `Status Bar`; WAI-ARIA APG `Toolbar`.

---

## Область 2. Проводник

### 22. Файл из вкладки находится в дереве сам

**Дыра.** Автораскрытия нет: движок ставит `aria-activedescendant` на строку
(`ui/explorer.ts:1996`), но при переключении вкладки дерево остаётся на
старом месте — человек ищет файл глазами.

**Уже есть:** `ui/explorer.ts` (`reveal(path)`), `workspace.revealPath`
(`app.ts:582`).

**Источник:** Zed `project_panel.auto_reveal_entries`;
https://zed.dev/docs/project-panel

### 23. Выделение не одно, и с ним работают

**Дыра.** Нет выделения нескольких строк и `Ctrl+Shift+E`: кнопка «Свернуть
всё» есть (`case 'expandAll'`, `ui/explorer.ts:2642`), а выбрать можно только
одну строку.

**Уже есть:** `ui/explorer.ts` (кейматчик), `core/tree-walk.ts`.

**Источник:** VS Code `Explorer` (multi-select);
https://code.visualstudio.com/docs/getstarted/userinterface

### 24. Цепочка папок схлопывается

**Дыра.** `a/b/c/src` из одной вложенной папки занимает три строки. Свёртки
цепочки (`auto_fold_dirs`) нет.

**Уже есть:** `core/tree-filter.ts` (сборка рядов), `ui/explorer.ts`.

**Источник:** Zed `project_panel.auto_fold_dirs`;
https://zed.dev/docs/project-panel

### 25. Совпало с фильтром — остальные уходят

**Дыра.** Фильтр дерева (`core/tree-filter.ts`, `filterTreePaths`) **отбирает
по имени**, но не гасит остальные строки — видно всё дерево с подсветкой.
Нужно два режима: «отобрать» и «подсветить».

**Уже есть:** `ui/explorer.ts:303` (поле фильтра), `filterTreePaths`.

**Источник:** Zed `project_panel` (filter); VS Code `Explorer filter`.

### 26. Проводник переживает перезапуск целиком

**Дыра.** Позиция свёрнутых папок есть (`Set` раскрытия), а **вид (размер
колонки, режим сортировки, скрытие по `.gitignore`) и позиция прокрутки** —
нет: после перезапуска списки идут по алфавиту вперемешку с папками.

**Уже есть:** `ui/explorer.ts` (сортировка, дерево).

**Источник:** Zed `project_panel.sort_mode`, `hide_gitignore`;
https://zed.dev/docs/project-panel

---

## Область 3. Редактор

### 27. Правка одного — видна во всех

**Дыра.** Мультибуфера нет вовсе: поиск по проекту
(`core/search-commands.ts`) открывает файлы по одному; результат не
раскрывается списком, где правка множества вхождений одна на все.

**Уже есть:** `editor/find/search.ts`, `core/search-commands.ts`.

**Источник:** Zed `multibuffers`; https://zed.dev/docs/multibuffers

### 28. Найти — со своей историей

**Дыра.** Многострочный поиск, regex и сводка «N из M» есть. Не хватает
**истории запросов** (запрос теряется между вызовами) и области **«в
выделении»**.

**Уже есть:** `editor/find/search.ts`, `editor/widgets/find-widget.ts:272`.

**Источник:** VS Code `Find and Replace`;
https://code.visualstudio.com/docs/editing/codebasics

### 29. Свёртка знает о языке

**Дыра.** `foldingRange` запрашивается и типы есть (`lsp-features.ts:585`),
но в UI не доведено: нет свёртки региона выбора, свёртки всех блоков по
уровню и счётчика свёрнутого в строке.

**Уже есть:** `lsp-features.ts:585`, `editor-commands.ts:110` (`foldAll`).

**Источник:** Zed `editing-code` (folding); https://zed.dev/docs/editing-code

### 30. Сравнить два любых файла

**Дыра.** Показ изменений и сравнение по `git` есть, а **«сравнить два
произвольных файла»** (перетащил файл на вкладку — открылось сравнение) и
поиск сразу по обоим — нет.

**Уже есть:** `ui/conflict-view.ts`, `core/view-commands.ts`.

**Источник:** VS Code `Diff Editor`;
https://code.visualstudio.com/docs/sourcecontrol/overview

### 31. Правая колонка — на себя

**Дыра.** Мини-карта есть, а **закладок на ней и отметок ошибок в правом
поле** — нет: лента изменений в редакторе есть (`onChangeMarker`), а
правого жёлоба с ошибками нет.

**Уже есть:** `editor/view/` (мини-карта), `app.ts:4202` (`onChangeMarker`).

**Источник:** VS Code `Minimap`; Zed `editing-code` (scrollbar diagnostics).

---

## Область 4. Чат

### 32. Контекст виден до отправки — с ценой

**Дыра.** Чипы контекста (`ui/chat-attachments.ts`) показывают
приложенное, а **сколько это стоит и что будет обрезано** — нет; «убрать»
есть, а пересчёта бюджета при каждом чипе — нет.

**Уже есть:** `chat-attachments.ts:128-170` (чипы и размер файла),
`chat-composer.ts`.

**Источник:** Cursor `@-context`; https://docs.cursor.com/context/@-symbols

### 33. Каждая нить разговора — со своим местом

**Дыра.** Своя ветка и рабочий каталог есть (`shared/branch-space.ts`,
`ui/chat-branch-space.ts`), а **списка нитей с состоянием (идёт, ждёт,
упала) и цены по нитям** — нет: вкладок чата много (`ui/chat-tabs.ts`),
а вкладки не говорят, где именно идёт работа.

**Уже есть:** `ui/chat-tabs.ts`, `shared/branch-space.ts`,
`ui/chat-queue.ts`.

**Источник:** Zed `parallel-agents`; https://zed.dev/docs/ai/parallel-agents

### 34. Стоп гасит инструменты

**Дыра.** `Стоп` останавливает ответ, но **запущенные команды, чтение и
записи** остаются сиротами: нет общего `AbortController` на цепочку
инструментов, и человек не видит, что ещё идёт.

**Уже есть:** `ui/chat-stream.ts`, `ui/chat-tools.ts`,
`ui/chat-approvals.ts:315` (`createCommandApproval`).

**Источник:** Zed `agent-panel` (`stop`); JetBrains `AI Chat`.

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

## Область 5. LSP и подсказки

**Все пункты закрыты 2026-11-06.** Сверка по коду показала:

- **39** — `source` сохраняется (`main/lsp/lsp.ts`) и панель по нему фильтрует
  (`ui/problem-panel.ts`);
- **40** — `LspStatus.servers` отдаёт `capabilities` (ручка `lsp.capabilities`,
  `main/ipc/methods/lsp.ts:63`);
- **41** — подсказки по аргументам с контекстом и триггерами
  (`LspFeatures.signatureHelp`, `app.ts:562`), `completionItem/resolve` есть;
- **42** — действия по видам на сохранении и по команде
  (`LspFeatures.sourceActions`, `core/file-write.ts:117`), у каждой правки —
  отмена через общую историю;
- **43** — сделан в этом заходе: `LspService.workspaceDiagnostics` и переключение
  обхода проекта на пакетный запрос (см. ниже).

### 43 (закрыт). Проект целиком одним запросом

**Было.** Обход проекта шёл файлом за файлом через `textDocument/diagnostic`:
на большом проекте — минуты даже на тёплом кэше, и закрытые файлы оставались
тайной.

**Стало.** `workspace/diagnostic`: одна просьба на сервер, ответ разбирается
поштучно (`full`/`unchanged` через `previousResultIds`), результат уходит тем же
путём, что и обычные пометки. Сервер без `workspaceDiagnostics` идёт прежним
пофайловым путём. Заявлено `workspace.diagnostics.identifier`.
Тест: `tests/lsp-workspace-diagnostics.test.ts`.

---

## Проверено и найдено готовым — НЕ пункт

Если собрались писать пункт про это — сначала посмотрите сюда.

**Оболочка и дерево:** раскладка и размеры (`ui/layout.ts`), возврат фокуса
из палитры (`ui/focus-return.ts`), пауза тоста (`ui/toast.ts:174`),
закрепление и preview-вкладки (`ui/tabs.ts`), фильтр и DnD дерева
(`core/tree-filter.ts`), `aria-activedescendant` (`ui/explorer.ts:1996`),
сортировка и `expandAll`, панель проблем с отбором (`ui/problem-panel.ts`),
палитра символов (`ui/symbol-picker.ts`), breadcrumbs (`core/tree-crumbs.ts`,
`editor/widgets/breadcrumbs-widget.ts`), статус-метр (`ui/status-meter.ts`).

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
`didChangeWorkspaceFolders` — всё в `main/lsp/lsp.ts` и
`renderer/editor/host/lsp-features.ts`.

**Закрыто 2026-11-06 (было пунктами 37 и 38), не писать заново:**

- подписки на пересчёт — `REFRESH_METHODS` в `main/lsp/lsp.ts`, колбэк
  `onRefresh` в конструкторе, топик `PushTopic.LspRefresh`;
  заявлены `resolveSupport` у `codeLens`/`inlayHint` и `refreshSupport` у
  `semanticTokens`. В окне — `EditorHost.refreshFromServer(method)` и
  `EditorWorkspace.refreshFromServer` через `case PushTopic.LspRefresh` в
  `app.ts`. Тест: `tests/lsp-refresh-and-on-type.test.ts`.
- форматирование на лету — `LspService.formatOnType()` (сверяет знак со
  списком триггеров сервера), канал `lsp.formatOnType`, ввод идёт через
  `EditorController.typeWithFormatting()`.

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
