# TASKS

Цель — довести до идеала шесть срезов. Источники сверки:

VS Code — docs/agents (tools, tools-reference, planning, subagents,
  memory, optimize-usage), docs/editing (intellisense, editingevolved,
  refactoring).
JetBrains IDEA — llms.txt, using-code-editor, inlay-hints, advanced/
  full-line/postfix/command completion, agents-in-ide, agentic-debugging,
  refactoring, mcp-server (все 64 инструмента).
Zed — ai/tools (16 инструментов), ai/zed-agent.
Neovim — runtime/doc/lsp.txt, nvim-lspconfig.
Cursor — cursor.com/llms.txt → .md: agent/tools/terminal, search, canvas,
  plan-mode, debug-mode, security/run-modes, rules, skills, subagents.
Xcode — JSON-API справки: source-editor (coding intelligence), debugging,
  testing.

Сверка с кодом проекта — перед каждым пунктом; чего не нашёл — пометил.

Нумерация сквозная 1-74.

## Правила

1. Перед пунктом — сверка с кодом.
2. Код и вычеркивание пункта — один коммит.
3. Готовое вычеркивается сразу, без пометок.
4. Экономия без числа до и после не считается сделанной.
5. Пункт, оказавшийся готовым при сверке, снимается тем же коммитом.

---

## I. IDE / оболочка (1-11)

1. ~~Sticky scroll~~ — готово: `stickyLayer` в `editor/view/editor-view.ts`.
2. ~~Breadcrumbs~~ — готово: `widgets/breadcrumbs-widget.ts`, подключён в `editor-host.ts`.
3. ~~Быстрый переход по открытым файлам~~ — готово: `ui/open-editors-block.ts`.
4. ~~Command palette с кириллицей~~ — готово: `rankFiles` поднимает недавние,
   раскладка прощается через `fuzzy.ts`.
5. ~~Палитра действий над файлом~~ — готово: `workspace.copyPath`, `file.revealInOS`.
6. ~~Раскладки панелей по проекту~~ — готово: `layout` в настройках и `session.load`.
7. Переключение панелей с клавиатуры (Ctrl+Alt+1..9) с номерами на
   панелях — **не сделано**.
8. ~~Тосты: очередь, история, «не беспокоить»~~ — готово: `ui/toast.ts` с `key`,
   `action`, `registry.mute`.
9. ~~Индикатор фоновых задач с отменой~~ — готово: `statusbar.ts` (`progress`,
   `symbols`), `projectCheck.cancel()`.
10. ~~Восстановление сессии~~ — готово: `session-store.ts` хранит `cursors`
    и `scrollTops`, `restoreRoots` возвращает план.
11. ~~Экран «что нового»~~ — готово: `CHANGELOG.md`, `shared/whats-new.ts`,
    тост при старте.


## II. Проводник (12-21)

12. Вставка (paste) в проводнике: копировать/переместить. В explorer.ts
    обработки paste нет.
13. Дублирование файла и папки — нет.
14. «Показать в файловом менеджере» — нет.
15. «Открыть терминал в папке» — нет.
16. Сравнить выбранные файлы: ref-diff-modal.ts есть, из проводника не
    вызывается.
17. Новый файл/папка inline-вводом в дереве (не диалогом).
18. Multi-root: несколько корневых папок в одном дереве. Сверить с
    project.ts; если нет — добавить.
19. Иконки типов файлов и git-статус на узлах дерева — проверить полноту.
20. Фильтр «только изменённые» и поиск по дереву.
21. Drag-and-drop между корнями с подтверждением для внешних путей.

## III. Редактор (22-33)

22. Inline-подсказки: inline-completions.ts есть; добавить режимы
    off/single-line/multi-line и приём по словам.
23. Автодополнение полной строки (JetBrains full-line) — нет; встроить
    источником в complete/assistant.ts.
24. Постфикс-завершения: postfix.ts есть; расширить по матрице JetBrains.
25. Завершение команд терминала (JetBrains command-completion) — нет.
26. Именованные аргументы и переопределения: named-args.ts, override.ts
    есть; проверить автопоказ без спец-жеста.
27. Inlay hints: есть; проверить отключение по языку и оформление.
28. Мультикурсор: в коде не найден. Минимум — Ctrl+D «следующее
    вхождение» и колонки (selection.ts).
29. Rename без LSP (fallback по word-index.ts): сейчас только через
    сервер.
30. Сворачивание по маркерам `#region` (folds.ts есть — проверить).
31. Вставка с учётом .editorconfig и автоперенос по словам.
32. Поиск с регуляркой и замена по группе файлов: undo для замен
    в файлах (find/ есть, group-count.ts есть).
33. Мини-карта и обзор: minimap.ts, overview.ts есть; замерить 100k
    строк.

## IV. Чат (34-43)

34. Контекст: `#файл` и drag-and-drop файлов из проводника в композер.
    Drag в chat-*.ts отсутствует.
35. Один жест прикрепляет текущий файл/выделение/диагностику
    (chat-composer-menu.ts есть — сделать кнопки).
36. Прикрепить ошибку из панели проблем и вывод терминала.
37. Планы: дерево шагов с прогрессом и «выполнить до конца»
    (chat-plan.ts есть).
38. Подзадачи в чате: вложенные карточки со сворачиванием и итогом.
39. Поиск по чатам по содержимому и дате (chat-persistence.ts есть,
    UI поиска нет).
40. Форки чата: панель сравнения двух веток (chat-fork.ts есть).
41. Компакция: показать до/после в токенах прямо в чате.
42. Цели (chat-goal.ts): переживать рестарт, показывать статус.
43. Очередь сообщений (chat-queue.ts): что долетит и когда, правка
    очереди.

## V. LSP и подсказки (44-53)

44. Call/type hierarchy: в main/lsp есть, в UI не задействовано — панель.
45. Document highlights: запрос есть (4 файла) — проверить UI.
46. Semantic tokens: 1 файл — проверить, используется ли в подсветке;
    если нет, подключить.
47. Selection range: есть (10 файлов) — сверить поведение расширения.
48. Inlay hints: вынести в настройки по языку целиком.
49. Linked editing: одно упоминание — довести до переименования пары
    тегов.
50. Document color: LSP есть — пикер цвета в редакторе.
51. Workspace symbol: ограничение по папке и задержка на больших
    проектах.
52. Code actions: «исправить всё» и группировка quickfix/refactor/source.
53. Форматирование: format-on-save по проекту и диапазонное.

## VI. Инструменты агента и экономия (54-57, 59-67)

54. `glob`: сверить наш набор (list/read/search/history/read_image/lsp/
    checks/run_tests/project_map/mcp/edit/web/terminal/terminalOpen/
    terminalOutput/terminalWrite/terminalStop/terminalList/file/skill/
    mind/browser/task/show) с Zed (16: diagnostics, fetch, find_path,
    grep, list_directory, read_file, search_web, copy_path,
    create_directory, delete_path, edit_file, move_path, write_file,
    terminal, skill, spawn_agent) и JetBrains MCP. Чего не хватает —
    добавить.
55. `diagnostics` отдельным именем: проверить, что `checks` покрывает
    файл/папку/проект так же, как Zed.
56. `fetch` с сохранением страницы в файл и учётом размера.
57. `git` (status/diff/blame/log, откат файла) вместо работы через
    `terminal`.
59. `todo` по коду (todo-panel.ts есть, в наборе агента нет).
60. `venv`/`pyenv`: venv-lookup.ts есть — решить, нужен ли в наборе.
61. Экономия: режимы `read` как у JetBrains `read_file` — `lines` (есть),
    `indentation` (дерево по отступам), `maxLines`, `offsets`, карта
    импортов. Сейчас есть только path/paths/startLine/endLine/force.
62. Экономия: `smart`-режим `search_file`: при совпадении с именем файла
    отдать файл целиком одним вызовом вместо списка.
63. Экономия: `list_directory_tree(depth, maxLines)` с ограничением
    глубины — у нас `list` не знает глубины.
64. Экономия: кэш `read`/`search` по mtime+размеру с метрикой попаданий
    (age-results.ts — базис).
65. Экономия: сворачивание повторов до «без изменений» сквозным
    счётчиком (output-trim.ts — базис).
66. Экономия: подбор фрагментов контекста по задаче через code-index
    с ранжированием.
67. Замер экономии: сводка токенов на сессию (вход/выход/кэш) в UI,
    чтобы каждый пункт экономии проверялся числом.

## VII. Донабор по Cursor / Xcode / Neovim (58, 68-74)

58. `symbols`: поиск по имени и по регулярке (JetBrains `search_symbol`,
    `search_regex`; Neovim `workspace/symbol`). code-index есть
    (symbols/store.ts, workspace/code-index.ts), инструмента нет.
68. ~~`debug`: отладочная сессия для агента~~ — сделано: инструмент
    `debug`, девять действий на той же сессии, что панель.
69. ~~`run`: запуск конфигурации и сборки~~ — сделано: инструмент
    `run`, резолвер `src/main/project/build.ts`.
70. `format`: переформатировать файл без сохранения (JetBrains
    `reformat_file`). Сейчас `checks` не правит.
71. `problems`: все пометки проекта сразу, не только текущий файл (JetBrains
    `get_file_problems`, `lint_files`) — сейчас только `checks`.
72. ~~`open_files`: открытые файлы с курсорами~~ — сделано: инструмент
    `open_files`, активная вкладка первой.
73. `move`/`copy_path`/`create_directory` (Zed, JetBrains
    `create_new_file`): создание и перенос отдельными именами, чтобы не
    собирать команды через `terminal`.
74. Режимы исполнения как у Cursor run-modes (allow/deny по типу
    действия) — настройка поверх текущего подтверждения опасных команд.
