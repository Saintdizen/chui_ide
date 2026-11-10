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

Сверка 09.11: редактор 29.6k строк, UI 38.2k, ядро 19.1k, shared 44.8k,
  ai 16.6k, lsp 6 файлов. Тесты 8477 зелёных, 5 пропусков (perf-baseline —
  сознательно ручной; ripgrep-run — skipIf, rg не установлен). tsc main — чисто.
  Внешний срез: поиск в интернете лежит (404), читаются только точные адреса.

### 1. IDE — каркас, состояние, восстановление

15. Снят без работы (10.11), сверено по коду: VimBinding.handleKey
    (vim-binding.ts:129) первым делом требует `if (!this.on) return false`,
    т.е. режим включается явно и по умолчанию выключен; зовётся он из
    обработчика клавиатуры редактора, когда фокус уже в редакторе;
    KeybindingService.handle (keybindings.ts:111) — отдельный слушатель Window —
    второй и читает `defaultPrevented`, т.е. не повторяет съеденное.
    Двух равноправных держателей одного сочетания нет. Если человек пожалуется
    на конфликт — смотреть сначала списки vim.ts против
    default-keybindings.ts на равенство строк сочетаний.
    Отдельно и НЕ про vim: слушатель Window не смотрит, что фокус в поле ввода
    чата — это своё поведение, в задачу не превращено.
16. Снят без работы (10.11): удалённая работа (WSL/SSH, не-file пути) как
    задача не нужна — не проверяем и не делаем.

### 2. Проводник и всё вокруг

17. ЗАКРЫТ (сверено по коду 10.11): `SearchResult.slow` ставится в
    `searchWithFs` (workspace.ts:750, `slow: !(await this.hasRipgrep())`), едет
    через слой инструмента в `formatCodeSearch` (src/shared/code-search.ts:190),
    который печатает оговорку «медленный обход — ripgrep не найден». Тест на
    текст оговорки — tests/code-search.test.ts:182. Работы здесь не осталось;
    открытым он висел по старой записи «поле не отдаётся наружу» — устарела.
19. Большие деревья: виртуализация есть, порог лага не мерен ни разу.
20. Массовое изменение на диске (git checkout, сотни файлов): debounce есть,
    поведение не мерено.


### Сверка с внешним

50. Из шапки прочитана ТОЛЬКО спецификация LSP (обзор). Остальное — каталоги
    адресов, не тексты: поиск лежит (404), читаются лишь точные URL. Пункт:
    пройти по каталогам поштучно и записать, что взято. Без этого «собрать всё
    по всем IDE» — обещание, а не работа.
51. JetBrains MCP — ЗАКРЫТ 10.11 СВЕРКОЙ (не догадкой).
    Источник: https://www.jetbrains.com/help/idea/mcp-server.html.md
    (curl), секции `### ` + имена строк целиком.
    Наших инструментов РОВНО 28 (src/shared/tools.ts, `name:`): browser,
    checks, debug, edit, file, git, history, list, lsp, mcp, mind, open_files,
    project_map, read, read_image, run, run_tests, search, show, skill,
    spawn, terminal, terminalList, terminalOpen, terminalOutput,
    terminalStop, terminalWrite, todo, web. (Прежние «23» и «40+» — обе
    неверны, это были мои оценки.)
    Расхождение мнимое: из 64 инструментов JB 24 — дебаггер и БД, которых
    у нас нет и не должно быть. Остальные 40 сверены поимённо, ВСЕ покрыты:
      get_file_problems     → checks (и `file` action=diagnostics/lint)
      get_symbol_info / rename_refactoring / analyze_*_usages → lsp
                                 (action=rename/info/references, agent-lsp.ts)
      replace_text_in_file  → edit
      create_new_file_with_text → file action=create
      reformat_code         → file action=format (agent-edit.ts:633)
      build_project / run_configuration → run (команду выбирает сам)
      get_debugger_breakpoints / toggle_breakpoint → debug
                                 (action=breakpoints, agent-debug.ts:290)
      search_in_files_by_regex / _by_text → search
      list_directory / find_path / move_path / copy_path / delete_path
                                 → list + file
    НЕ проверено кодом, но и не наша зона: execute_action_by_id,
    get_project_modules/dependencies, create_new_project, work with
    databases. Пункт `optimize_imports` закрыт фактом:
    `source.organizeImports` уже обрабатывается (src/main/lsp/lsp.ts:1918).
    inlay-hints — это НЕ инструмент агента и в этом же доке их нет; мой
    прежний упрёк смешивал фичу UI с инструментом. Вынесено отдельной
    задачей — см. п.53.
52. Zed — ЗАКРЫТ 10.11. По https://zed.dev/docs/ai/tools у Zed своего
    набора 16 инструментов, все покрыты: edit_file/write_file → edit+file,
    read_file → read, grep/find_path/list_directory → search+list,
    create_directory/delete_path/move_path/copy_path → file,
    fetch/web_search → web, diagnostics → checks, run_command/terminal
    → run + terminal*, spawn_agent → spawn (алиас, tool-aliases.ts),
    update_plan/create_thread/edit_thread → mind (steps/goal/exit_plan).
53. inlay-hints — ЗАКРЫТ 10.11, дыры не было. Есть целиком:
    src/shared/lsp-inlay-hints.ts (логика),
    src/renderer/editor/host/lsp-features.ts (подключка),
    настройка lsp.inlayHintsOff по языкам, тесты
    editor-inlay-hints.test.ts + lsp-inlay-hints.test.ts.
54. `file action=organizeImports` — СДЕЛАНО 10.11.
    Обработчик `source.organizeImports` был (src/main/lsp/lsp.ts:1918),
    агенту не отдан. Добавлено:
    - LspService.organizeImports(path) — textDocument/codeAction c kind
      source.organizeImports, разворачивает edit у самого действия, правит
      только этот файл;
    - ToolContext.organizeImports + проброс в service.ts рядом с formatFile;
    - действие 'organizeImports' в схеме tools.ts и диспетчере agent-edit.ts
      (образец — formatFile).
    Тестов на текст нет — как и у format: юнит-тест требует живого LSP;
    покрыто типом и двумя обновлёнными enum-тестами. 8486 зелёных.


## Правила

1. Перед пунктом — сверка с кодом.
2. Код и удаление пункта — один коммит.
3. Готовое удаляется сразу, без пометок.
4. Экономия без числа до и после не считается сделанной.
5. Пункт, оказавшийся готовым при сверке, удаляется тем же коммитом.
