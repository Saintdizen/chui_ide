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
Нумерация сквозная; закрытые пункты удалены, номера их соседей не сдвигаются
— на них ссылаются коммиты и память.

Сверка 10.11: редактор 29.6k строк, UI 38.2k, ядро 19.1k, shared 44.8k,
  ai 16.6k, lsp 6 файлов. Тесты 8495 зелёных, 5 пропусков (perf-baseline —
  сознательно ручной; ripgrep-run — skipIf, rg не установлен). tsc main — чисто.
  Внешний срез: каталоги VS Code/JetBrains/Zed/Neovim/Cursor/Xcode скачаны
  curl-ом (поиск не нужен, точные адреса читаются), сверка — в UPSTREAM.md.

## Правила

1. Перед пунктом — сверка с кодом.
2. Код и удаление пункта — один коммит.
3. Готовое удаляется сразу, без пометок.
4. Экономия без числа до и после не считается сделанной.
5. Пункт, оказавшийся готовым при сверке, удаляется тем же коммитом.
