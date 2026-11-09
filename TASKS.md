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

Нумерация сквозная 1-85. Закрытые пункты удалены; номера сдвигать не надо —
на них ссылаются коммиты и память проекта.
Готовое удаляется из списка, а не вычеркивается: здесь только то, что
впереди.

## Правила

1. Перед пунктом — сверка с кодом.
2. Код и удаление пункта — один коммит.
3. Готовое удаляется сразу, без пометок.
4. Экономия без числа до и после не считается сделанной.
5. Пункт, оказавшийся готовым при сверке, удаляется тем же коммитом.

---

## Открыто после среза VII

0. Повторный run той же команды в одном прогоне отдаёт «без изменений
   с шагом N» вместо полного вывода. Число: символы на вызов terminal.

84. Длинные строки в `read`: файлы с малым числом строк, но длинными,
    проходят мимо WHOLE_FILE_MAX_LINES (160) и уходят целиком — 2 654
    вызова `read` >3 000 символов (43% веса ответов). Свёртка по возрасту
    (ступень 3) их забирает, но только на следующих шагах; первый ответ
    едет целиком.
    Рычаг: резать по «кирпичам» — по строкам до предела символов, — но
    только по замеру частоты таких файлов. Замера пока нет.
    Проверено 09.11 (коммит 1c55d49): ступень 3 в самом деле сворачивает их
    на следующих шагах; остался именно первый ответ.

