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
   (п.8 так и закрыт: рост хвоста замерен, потери нет, код не тронут — ab9b2f5)

11. Скачки цены хода не объяснены до конца. Счётчик "цена контекста… 336.5k…
   ещё 168271k" рос СКАЧКАМИ (336.5k → 7.4k → 10.1k → 8.3k) внутри
   одного прогона, где я только правил TASKS.md. Причина хвоста найдена
   (946e09c: дубль в service.ts считал от ПОТОЛКА шагов), но скачки базы
   остались: (a) в основу промпта попадает переменная часть (сводка,
   spill-файлы, полные ответы read) — тогда 336k и есть утечка; либо
   (b) сам прибор складывает не то, что обещает.
   Сначала проверить счётчик, потом основу — иначе будем экономить на
   выдуманной цифре. Связано с п.2.
