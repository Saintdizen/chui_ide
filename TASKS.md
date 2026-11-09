# TASKS

Цель — довести до идеала оставшиеся срезы. Источники сверки:

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

Нумерация сквозная 1-74; номера закрытых пунктов остаются занятыми.
Готовое удаляется из списка, а не вычеркивается: здесь только то, что
впереди.

## Правила

1. Перед пунктом — сверка с кодом.
2. Код и удаление пункта — один коммит.
3. Готовое удаляется сразу, без пометок.
4. Экономия без числа до и после не считается сделанной.
5. Пункт, оказавшийся готовым при сверке, удаляется тем же коммитом.

---

## I. IDE / оболочка

7. Переключение панелей с клавиатуры (Ctrl+Alt+1..9) с номерами на
   панелях — **не сделано**.

## VI. Инструменты агента и экономия

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

## VII. Донабор по Cursor / Xcode / Neovim

58. `symbols`: поиск по имени и по регулярке (JetBrains `search_symbol`,
    `search_regex`; Neovim `workspace/symbol`). code-index есть
    (symbols/store.ts, workspace/code-index.ts), инструмента нет.
70. `format`: переформатировать файл без сохранения (JetBrains
    `reformat_file`). Сейчас `checks` не правит.
71. `problems`: все пометки проекта сразу, не только текущий файл (JetBrains
    `get_file_problems`, `lint_files`) — сейчас только `checks`.
73. `move`/`copy_path`/`create_directory` (Zed, JetBrains
    `create_new_file`): создание и перенос отдельными именами, чтобы не
    собирать команды через `terminal`.
74. Режимы исполнения как у Cursor run-modes (allow/deny по типу
    действия) — настройка поверх текущего подтверждения опасных команд.
