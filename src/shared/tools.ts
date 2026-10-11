/**
 * Описание инструментов агента: какие действия ассистент может вызывать и где
 * они исполняются.
 *
 * `side` — принципиальный момент архитектуры: файловые операции живут в main
 * (там есть доступ к ФС), а правки документов — в renderer (там документная
 * модель и undo). Мост между ними уже готов — это RPC + события.
 *
 * Реализованы все: list_dir, read_file, search и run_terminal — в main,
 * apply_edit — в renderer через хостовый вызов. Какие из них предложить модели,
 * решает сборка: см. `canRun` в `src/main/ai/service.ts`.
 */

export type AgentToolSide = 'main' | 'renderer';

export type AgentToolName =
  | 'list_dir'
  | 'read_file'
  | 'read_files'
  | 'search'
  | 'codebase_search'
  | 'find_references'
  | 'go_to_definition'
  | 'rename_symbol'
  | 'project_map'
  | 'file_outline'
  | 'run_linter'
  | 'run_tests'
  | 'find_files'
  | 'get_diagnostics'
  | 'apply_edit'
  | 'replace_in_files'
  | 'run_terminal'
  | 'web_search'
  | 'create_file'
  | 'delete_file'
  | 'move_file'
  | 'update_plan'
  | 'task'
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_evaluate'
  | 'browser_close'
  | 'remember'
  | 'forget'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_blame'
  | 'git_stage'
  | 'git_unstage'
  | 'git_commit'
  | 'git_checkout'
  | 'git_discard'
  | 'git_fetch'
  | 'git_pull'
  | 'git_push'
  | 'open_file'
  | 'terminal_list'
  | 'terminal_start'
  | 'terminal_read'
  | 'terminal_write'
  | 'terminal_stop';

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  items?: JsonSchemaProperty;
  enum?: string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Минимум, нужный, чтобы предложить инструмент модели. Есть и у наших
 * инструментов, и у внешних (MCP): их схемы приходят от чужой программы и в
 * `JsonSchema` не помещаются, а `toOpenAiTools` отдаёт схему как есть.
 */
export interface ExposedToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

export interface AgentToolSpec extends ExposedToolSpec {
  name: AgentToolName;
  side: AgentToolSide;
  inputSchema: JsonSchema;
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    name: 'list_dir',
    side: 'main',
    description: 'Показать содержимое папки внутри рабочей директории.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к папке.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    side: 'main',
    description:
      'Прочитать файл. Большие файлы читай диапазоном строк — так в контекст попадёт нужное, ' +
      'а не первые 20 000 символов. Строки в выводе нумеруются с 1: по этим номерам удобно ' +
      'готовить правки apply_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу.' },
        startLine: {
          type: 'number',
          description: 'Первая строка диапазона (1-based, включительно). Без него — с начала файла.',
        },
        endLine: {
          type: 'number',
          description: 'Последняя строка диапазона (включительно). Без него — до конца (с лимитом строк).',
        },
        force: {
          type: 'boolean',
          description:
            'Перечитать даже ранее прочитанное в этом ходе — на случай, если содержимое выпало из контекста.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    side: 'main',
    description:
      'Поиск подстроки или регулярного выражения по содержимому файлов рабочей директории. ' +
      'Для обзора «где это вообще встречается» ставь filesOnly=true — вернутся только имена файлов.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Образец поиска.' },
        isRegex: { type: 'boolean', description: 'Считать query регулярным выражением.' },
        caseSensitive: { type: 'boolean', description: 'Учитывать регистр (по умолчанию — нет).' },
        filesOnly: { type: 'boolean', description: 'Вернуть только пути файлов с совпадением, без строк.' },
        glob: { type: 'string', description: 'Маска файлов, например **/*.ts' },
      },
      required: ['query'],
    },
  },
  {
    name: 'codebase_search',
    side: 'main',
    description:
      'Поиск по коду, когда имя известно примерно, а файл — нет: сначала ищет объявления ' +
      'символов через языковой сервер («где определён»), затем — текстовые совпадения, ' +
      'свёрнутые по файлам (сколько раз и где первое). Умеет имена словами: запрос ' +
      '«read file» находит readFile. Точную строку ищи через search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Имя символа или слова из него, например `readFile`.' },
        limit: { type: 'number', description: 'Сколько объявлений вернуть (по умолчанию 40).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_references',
    side: 'main',
    description:
      'Где символ используется во всём проекте (языковой сервер, не текстовый поиск): ссылки ' +
      'без комментариев и одноимённых переменных. Вызывай перед переименованием или удалением — ' +
      'понять, что ещё сломается. Имя символа можно писать словами («read file»).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Имя символа, например `saveCalibration` или «read file».' },
        path: {
          type: 'string',
          description: 'Если у символа несколько объявлений — сузить поиск этим файлом (абсолютный путь).',
        },
        includeDeclaration: {
          type: 'boolean',
          description: 'Включить само объявление в список (по умолчанию да).',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'go_to_definition',
    side: 'main',
    description:
      'Перейти к объявлению символа. Либо по имени (`symbol`) — где он определён, либо из позиции ' +
      'использования (`path` + `line`): тогда переход делает языковой сервер. Требует языкового сервера.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Имя символа — если известно, где искать по имени.' },
        path: { type: 'string', description: 'Файл с использованием (абсолютный путь).' },
        line: { type: 'number', description: 'Строка использования в этом файле (1-based).' },
        column: { type: 'number', description: 'Столбец (1-based). Без него — начало строки.' },
      },
    },
  },
  {
    name: 'rename_symbol',
    side: 'main',
    description:
      'Переименовать символ с учётом семантики: языковой сервер меняет имя только там, где это ' +
      'именно этот символ, — в объявлении и во всех ссылках, включая другие файлы. Это не то же, ' +
      'что `replace_in_files`: та бьёт по подстроке и заденет одноимённые переменные и комментарии. ' +
      'Перед вызовом полезно посмотреть `find_references`. Правки проходят ревью, как у `apply_edit`.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Текущее имя символа.' },
        newName: { type: 'string', description: 'Новое имя.' },
        path: {
          type: 'string',
          description: 'Если у символа несколько объявлений — сузить поиск этим файлом (абсолютный путь).',
        },
      },
      required: ['symbol', 'newName'],
    },
  },
  {
    name: 'file_outline',
    side: 'main',
    description:
      'Скелет файла: объявления (классы, функции, методы) с номерами строк и вложенностью, ' +
      'без тел. Вызывай перед чтением, чтобы понять устройство файла и не читать его целиком: ' +
      'дальше бери нужные строки read_file с startLine и endLine. Требует языкового сервера; ' +
      'если файл небольшой — читай его сразу.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_linter',
    side: 'main',
    description:
      'Проверить код линтером проекта: ruff у Python, eslint или biome у Node. Возвращает ' +
      'найденные проблемы (файл, строка, правило, сообщение). Без пути проверяется весь проект, ' +
      'с путём — файл или папка. Файлы не меняются: это только проверка. Вызывай после правок, ' +
      'чтобы убедиться, что не внёс новых замечаний, и вместо догадок о качестве кода.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Файл или папка (абсолютный путь). Без него — проект целиком.',
        },
      },
    },
  },
  {
    name: 'run_tests',
    side: 'main',
    description:
      'Запустить тесты проекта: чем — определяет IDE (pytest у Python, vitest, jest или `node --test` ' +
      'у Node), гадать о команде не нужно. Возвращает вывод и код выхода: ненулевой — упавшие ' +
      'тесты. Запуск подтверждает пользователь. Вызывай после правок, чтобы убедиться, что ничего ' +
      'не сломал.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_map',
    side: 'main',
    description:
      'Карта проекта: что за проект, из чего состоит, где тесты и точки входа — по именам файлов, ' +
      'без чтения содержимого. Вызывай, чтобы сориентироваться до работы, вместо обхода дерева ' +
      'и чтения манифестов. Краткая версия карты уже есть в системном промпте — этот вызов нужен, ' +
      'если она устарела или нужны подробности.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_files',
    side: 'main',
    description:
      'Найти файлы по glob-маске пути — например **/*.test.ts или src/**/*.py. ' +
      'Служебные папки (node_modules, .git, dist и прочие) пропускаются. ' +
      'Вызывай, когда нужно узнать, какие файлы вообще есть в проекте, а не их содержимое.',
    inputSchema: {
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description:
            'Маска пути: `**` — любая глубина, `*` — в пределах сегмента. ' +
            'Например **/*.py или src/renderer/**. Без маски вернутся все файлы проекта.',
        },
        limit: { type: 'number', description: 'Максимум путей (по умолчанию 200, максимум 2000).' },
      },
    },
  },
  {
    name: 'read_files',
    side: 'main',
    description:
      'Прочитать несколько файлов одним вызовом — когда нужно свериться с 2–5 файлами сразу. ' +
      'Экономит шаги: вместо пяти read_file хватает одного. Каждый файл возвращается с номерами ' +
      'строк, как у read_file, но общий размер вывода ограничен.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Абсолютные пути файлов.',
          items: { type: 'string', description: 'Путь к файлу.' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'replace_in_files',
    side: 'main',
    description:
      'Заменить все вхождения строки или регулярного выражения по файлам проекта — массовое ' +
      'переименование, а не точечная правка. Для изменения одной пары строк используй apply_edit. ' +
      'Маска glob ограничивает, в каких файлах искать. Все изменения сразу пишутся на диск ' +
      'и видны в панели изменений.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Что заменить.' },
        replacement: { type: 'string', description: 'Чем заменить (пустая строка — удалить).' },
        isRegex: {
          type: 'boolean',
          description: 'Считать query регулярным выражением (тогда в замене работают группы $1).',
        },
        caseSensitive: { type: 'boolean', description: 'Учитывать регистр (по умолчанию — нет).' },
        glob: { type: 'string', description: 'Маска файлов, например **/*.ts' },
      },
      required: ['query', 'replacement'],
    },
  },
  {
    name: 'get_diagnostics',
    side: 'renderer',
    description:
      'Ошибки и предупреждения, которые показывает редактор: без аргументов — по всем ' +
      'открытым файлам. Вызывай перед тем, как чинить код, а не после.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ограничить одним файлом (абсолютный путь).' },
      },
    },
  },
  {
    name: 'apply_edit',
    side: 'renderer',
    description:
      'Применить правки к документам. Путь абсолютный, позиции 1-based (как в LSP). ' +
      'В каждой правке передавай oldText — точный текст, который она заменяет: по нему ' +
      'правка сверяется с файлом и не «попадает» в чужое место. Обязательно для строк ' +
      'с не-ASCII (кириллица, эмодзи), где легко ошибиться в колонках. ' +
      'Правку видит и подтверждает пользователь, она попадает в undo-стек редактора.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Массив объектов { path, expectedVersion, edits: TextEdit[] }.',
          items: { type: 'object', description: 'FileEdit' },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'web_search',
    side: 'main',
    description:
      'Найти информацию в интернете: ссылки, заголовки и краткие описания. Нужен для документации ' +
      'и внешних сведений, которых нет в проекте. Это только поисковая выдача — по ссылкам агент ' +
      'не переходит, поэтому сведения из неё стоит перепроверять, а не выдавать за факт.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос.' },
        limit: { type: 'number', description: 'Сколько результатов вернуть (по умолчанию 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_terminal',
    side: 'main',
    description:
      'Выполнить команду оболочки в рабочей папке и вернуть её вывод. ' +
      'Каждый запуск подтверждает пользователь, поэтому команда должна быть одной и по делу.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для запуска.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'create_file',
    side: 'main',
    description:
      'Создать новый файл с содержимым. Существующий файл НЕ перетирается — вернётся ошибка; ' +
      'для правки существующего файла используй apply_edit. Поле contents обязательно: пустая ' +
      'строка создаст пустой файл осознанно, а забытое содержимое — ошибка, а не тихий пустой файл.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к новому файлу.' },
        contents: { type: 'string', description: 'Содержимое нового файла (обязательно).' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'delete_file',
    side: 'main',
    description: 'Удалить файл или папку (в корзину). Вызывай только когда уверен: отмена — из корзины вручную.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу или папке.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    side: 'main',
    description: 'Переместить или переименовать файл либо папку внутри рабочей директории.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Текущий абсолютный путь.' },
        to: { type: 'string', description: 'Новый абсолютный путь.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'update_plan',
    side: 'main',
    description:
      'Обновить план работы: список шагов со статусами. Вызывай в начале задачи, а затем после ' +
      'каждого выполненного шага — пользователь видит прогресс, а ты не теряешь нить.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Шаги плана: { text, status }, где status — pending | in_progress | done.',
          items: { type: 'object', description: 'PlanStep' },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'task',
    side: 'main',
    description:
      'Делегировать подзадачу отдельному агенту с собственным контекстом. Он исследует проект ' +
      'инструментами чтения и возвращает краткий отчёт — файлы, строки, вывод команд — а твоя ' +
      'беседа от его чтений не растёт. Зови, когда нужно перечитать много файлов ради одного ' +
      'факта: сам он этого в переписку не вываливает.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Короткое название подзадачи — попадёт в карточку.' },
        prompt: {
          type: 'string',
          description: 'Что именно исследовать: вопрос или задача. Чем конкретнее, тем полезнее отчёт.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_open',
    side: 'main',
    description:
      'Открыть адрес в браузере (свой Chromium, управляемый по CDP). Запускает браузер, если тот ' +
      'ещё не запущен, и переходит на страницу. Дальше смотри её через browser_snapshot. ' +
      'Работает только при включённой настройке «Браузер» и только с http/https.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Адрес страницы. Без схемы — значит https (локальные — http).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    side: 'main',
    description:
      'Снимок открытой страницы: заголовок, адрес, интерактивные элементы с номерами и видимый текст. ' +
      'Номера — это ссылки (ref) для browser_click и browser_type. Вызывай после каждого действия: ' +
      'страница меняется, старые номера устаревают.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    side: 'main',
    description: 'Нажать элемент страницы по номеру из снимка (browser_snapshot). Номер живёт до перезагрузки снимка.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Номер элемента из снимка, например «3».' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    side: 'main',
    description:
      'Ввести текст в поле по номеру из снимка. Для поиска и адресной строки сайта: форма отправляется ' +
      'клавишей Enter — поставь submit=true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Номер поля из снимка.' },
        text: { type: 'string', description: 'Что ввести.' },
        submit: { type: 'boolean', description: 'Нажать Enter после ввода (отправить форму).' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_evaluate',
    side: 'main',
    description:
      'Выполнить выражение JavaScript на открытой странице и вернуть результат. Для чтения состояния, ' +
      'которого нет в снимке. Результат приводится к тексту; менять так страницу можно, но клик и ввод ' +
      'надёжнее — они видимы в ленте и повторяемы.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Выражение или код JS. Возвращай значение через return.' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_close',
    side: 'main',
    description: 'Закрыть управляемый браузер: процесс и профиль удаляются. Нужен, когда просмотр закончен.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remember',
    side: 'main',
    description:
      'Записать заметку в память проекта — она переживает беседу и её сжатие. Сюда уходит то, ' +
      'о чём договорились насовсем: предпочтения пользователя, принятые решения, как собирать и ' +
      'запускать, важные договорённости. Не для разового контекста (он и так в беседе). Заметки ' +
      'видны тебе в начале каждого ответа.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Короткая заметка в одну мысль, не больше пары строк.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    side: 'main',
    description:
      'Убрать из памяти проекта заметки, в которых встречается подстрока. Нужен, когда заметка ' +
      'устарела или память переполнилась.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Подстрока, по которой узнать заметки для удаления.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_status',
    side: 'main',
    description:
      'Состояние git: текущая ветка и список изменённых файлов (индекс и рабочее дерево). ' +
      'Смотри перед тем, как коммитить или откатывать.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    side: 'main',
    description:
      'Diff файла по git: рабочее дерево против индекса, а с staged=true — индекс против HEAD. ' +
      'Контекст — 3 строки вокруг правок, независимо от настроек git.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь файла.' },
        staged: { type: 'boolean', description: 'true — сравнить индекс с HEAD.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'git_log',
    side: 'main',
    description:
      'История коммитов: последние изменения репозитория или одного файла. Read-only — ' +
      'ничего не меняет. Возвращает hash, дату, автора и заголовок каждого коммита.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Сколько последних коммитов (по умолчанию 20, максимум 100).' },
        path: { type: 'string', description: 'Ограничить историю одним файлом (абсолютный путь).' },
      },
    },
  },
  {
    name: 'git_blame',
    side: 'main',
    description:
      'Кто и когда менял строки файла: автор, коммит, его сообщение. Отвечает на «почему тут так» — ' +
      'по сообщению коммита часто виден замысел, которого в коде уже нет. startLine/endLine сужают ' +
      'вывод до нужного места. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу.' },
        startLine: { type: 'number', description: 'Первая строка диапазона (1-based). Без него — с начала.' },
        endLine: { type: 'number', description: 'Последняя строка диапазона (включительно).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'git_stage',
    side: 'main',
    description:
      'Проиндексировать файлы (git add). Пути абсолютные. Проиндексированное попадёт ' +
      'в следующий коммит. Удаления тоже индексируются.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Абсолютные пути файлов или папок.',
          items: { type: 'string', description: 'Путь.' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'git_unstage',
    side: 'main',
    description: 'Убрать файлы из индекса (git restore --staged). Правки в рабочем дереве остаются.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Абсолютные пути файлов или папок.',
          items: { type: 'string', description: 'Путь.' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'git_commit',
    side: 'main',
    description:
      'Закоммитить проиндексированное. С путями коммитит только их. Сообщение — одна ' +
      'осмысленная строка о том, что и зачем изменено. Перед коммитом посмотри git_status ' +
      'и git_diff: в коммит должно уйти то, что задумано.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Сообщение коммита.' },
        paths: {
          type: 'array',
          description: 'Если задано — коммитить только эти пути (абсолютные).',
          items: { type: 'string', description: 'Путь.' },
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_checkout',
    side: 'main',
    description:
      'Переключить ветку или создать новую. Переключение меняет файлы на диске под ' +
      'содержимое ветки; при незакоммиченных правках git может отказать — это его защита.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя ветки.' },
        create: { type: 'boolean', description: 'true — создать ветку и переключиться на неё.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'git_discard',
    side: 'main',
    description:
      'Откатить правки: отслеживаемые файлы — к последнему коммиту, новые — в корзину. ' +
      'Необратимо: незакоммиченная работа будет потеряна. Вызывай только по явной просьбе.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Абсолютные пути файлов.',
          items: { type: 'string', description: 'Путь.' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'git_fetch',
    side: 'main',
    description:
      'Забрать изменения из удалённого репозитория, не трогая рабочее дерево. Полезно, чтобы ' +
      'сверить локальное с удалённым перед работой. Сеть может быть недоступна — об этом будет ответ.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_pull',
    side: 'main',
    description:
      'Влить изменения из удалённого репозитория в текущую ветку. При расхождении путей git ' +
      'может сообщить о конфликте — тогда разбирай его вручную, а не повторяй pull.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_push',
    side: 'main',
    description:
      'Отправить коммиты в удалённый репозиторий. При первой отправке ветки upstream ставится ' +
      'сам (origin). `force` шлёт принудительно через `--force-with-lease` — только по явной просьбе.',
    inputSchema: {
      type: 'object',
      properties: {
        setUpstream: { type: 'boolean', description: 'true — привязать ветку к origin (git push -u).' },
        force: { type: 'boolean', description: 'true — принудительно (--force-with-lease).' },
      },
    },
  },
  {
    name: 'open_file',
    side: 'renderer',
    description:
      'Открыть файл в редакторе на нужной строке — чтобы пользователь сразу увидел место, ' +
      'о котором идёт речь. Вызывай, когда ссылаешься на конкретный код.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь файла.' },
        line: { type: 'number', description: 'Строка (1-based).' },
        column: { type: 'number', description: 'Столбец (1-based).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'terminal_list',
    side: 'main',
    description: 'Список открытых терминальных сессий (id, cwd, pid) — для long-running процессов.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_start',
    side: 'main',
    description:
      'Открыть НАСТОЯЩИЙ терминал (pty) и вернуть его id. В отличие от run_terminal, сессия ' +
      'живёт между шагами: можно запустить долгий процесс (сервер, watch) и позже читать его вывод. ' +
      'Команду можно не передавать и набирать потом через terminal_write.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Необязательная команда, которую наберём сразу после старта.' },
        cwd: { type: 'string', description: 'Рабочая папка (по умолчанию — корень проекта).' },
      },
    },
  },
  {
    name: 'terminal_read',
    side: 'main',
    description:
      'Прочитать НОВЫЙ вывод сессии. Передай from — смещение, полученное в прошлом ответе; ' +
      'без него прочитаешь весь буфер (до 60 000 символов).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии из terminal_start или terminal_list.' },
        from: { type: 'number', description: 'С какого смещения читать (из поля offset прошлого чтения).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_write',
    side: 'main',
    description:
      'Отправить ввод в сессию (как будто пользователь набрал в терминале). Завершай строку \\n, ' +
      'если хочешь нажать Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии.' },
        data: { type: 'string', description: 'Что написать в терминал.' },
      },
      required: ['id', 'data'],
    },
  },
  {
    name: 'terminal_stop',
    side: 'main',
    description: 'Остановить сессию терминала (kill процесса).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии.' },
      },
      required: ['id'],
    },
  },
];

/** Описание инструмента в том виде, в каком его ждёт OpenAI-совместимый API. */
export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export function toOpenAiTools(specs: readonly ExposedToolSpec[]): OpenAiFunctionTool[] {
  return specs.map((spec) => ({
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema as JsonSchema },
  }));
}

/** Разбор аргументов вызова. Битый JSON не роняет цикл — агент получает ошибку текстом. */
export function parseToolArguments(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'Аргументы инструмента должны быть JSON-объектом' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      message: `Не удалось разобрать аргументы: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
