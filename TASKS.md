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

12. ~~Вставка (paste) с копированием/переносом~~ — готово: `core/file-clipboard.ts`.
13. ~~Дублирование файла и папки~~ — готово: `core/duplicate-name.ts`, `file.duplicate`.
14. ~~«Показать в файловом менеджере»~~ — готово: `file.revealInOS` в меню дерева.
15. ~~«Открыть терминал в папке»~~ — готово: `terminal.openIn` в меню дерева.
16. ~~Сравнить выбранные файлы~~ — готово: `core/compare-commands.ts`.
17. ~~Новый файл/папка inline-вводом~~ — готово: `inlineEdit` в `explorer.ts`.
18. ~~Multi-root~~ — готово: группы корней в `explorer.ts`.
19. ~~Иконки типов и git-статус на узлах~~ — готово: `file-icons.ts`, значки git.
20. ~~Фильтр «только изменённые» и поиск по дереву~~ — готово: `core/tree-filter.ts`.
21. ~~Drag-and-drop между корнями~~ — готово: `shared/drop-guard.ts`,
    перенос извне проекта — с `dialog.confirm`.

## III. Редактор (22-33)

22. ~~Режимы inline-подсказок и приём по словам~~ — готово: `inline-completions.ts`.
23. ~~Автодополнение полной строки~~ — готово: `shared/full-line.ts`.
24. ~~Postfix по матрице JetBrains~~ — готово: `complete/postfix.ts`.
25. ~~Завершение команд терминала~~ — готово: `terminal/core/command-completion.ts`.
26. ~~Автопоказ подсказок без жеста~~ — готово: `named-args.ts`, `override.ts`.
27. ~~Inlay hints~~ — готово: `lsp-inlay-hints.ts`, отключение по языку.
28. ~~Мультикурсор Ctrl+D/Ctrl+Shift+L~~ — готово: `selectNextOccurrence`.
29. ~~Переименование без LSP~~ — готово: `shared/rename-fallback.ts`.
30. ~~Складывание по `#region`~~ — готово: `highlight/folds.ts`.
31. ~~`.editorconfig`~~ — готово: `shared/editorconfig.ts`, применяется.
32. ~~Отмена групповой замены~~ — готово: одна правка — одна запись истории.
33. ~~Мини-карта на больших файлах~~ — готово: прореживание по `minimapScale`.

## IV. Чат (34-43)

34. ~~`#файл` и бросок файла из проводника в композер~~ — готово.
35. ~~Один жест прикрепляет файл/выделение/диагностику~~ — готово: кнопки.
36. ~~Ошибка из панели проблем и вывод терминала~~ — готово: `#terminal`.
37. ~~Планы: дерево шагов с прогрессом и «выполнить до конца»~~ — готово.
38. ~~Подзадачи вложенными карточками со сворачиванием и итогом~~ — готово.
39. ~~Поиск по чатам по содержимому и дате~~ — готово.
40. ~~Форки чата: панель сравнения двух веток~~ — готово: `/compare`.
41. ~~Компакция: до/после в токенах~~ — готово.
42. ~~Цели: переживать рестарт, показывать статус~~ — готово.
43. ~~Очередь сообщений: что долетит и когда, правка очереди~~ — готово.

## V. LSP и подсказки (44-53)

44. ~~Call hierarchy: панель с деревом~~ — готово. Type hierarchy попапом.
45. ~~Document highlights~~ — готово: подсветка вхождений, не задействования нет.
46. ~~Semantic tokens~~ — готово: подключено к подсветке с паузой и видимым диапазоном.
47. ~~Selection range~~ — готово: expandSelection через selectionRanges.
48. ~~Inlay hints по языку~~ — готово: `shared/lsp-visibility.ts`.
49. ~~Linked editing~~ — готово: правка зеркалится в парный тег.
50. ~~Document color~~ — готово: клик по плашке открывает пикер.
51. ~~Workspace symbol по папке~~ — готово: параметр `folder` в `lsp.symbols`.
52. ~~Code actions~~ — готово: группировка по видам, команда «Исправить всё».
53. ~~Форматирование~~ — готово: format-on-save из настроек проекта, `format.selection`.

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
