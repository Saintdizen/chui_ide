# Что предстоит

Только открытые задачи. Сделанное живёт в README, тестах и в истории файла
(`git log --follow -p TASKS.md`).

## LSP: остаток от сверки с metaModel 3.17

Сделано: `didSave`, `workspace/didChangeWatchedFiles`, `textDocument/formatting`,
`textDocument/prepareRename`, `declaration`/`typeDefinition`/`implementation`,
`workspaceSymbol/resolve`, `documentLink`/`documentLink/resolve` (уже были сделаны),
`willSave`. Осталось:

1. **Pull-диагностика** (`textDocument/diagnostic`): работаем на push-модели и так её
   и объявляем. Переход на pull — отдельная задача с кэшем и отменой запросов.
2. **`didSave` для файлов, не открытых в редакторе.** Сейчас шлём только тем, что
   отслеживает редактор (по спецификации — правильно), но сохранение через
   встроенный файловый менеджер тоже стоило бы сообщать серверу.
