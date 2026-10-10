/**
 * Проверка агентного цикла: поднимаем локальный OpenAI-совместимый SSE-сервер,
 * который сначала просит вызвать инструмент, а затем отвечает текстом.
 *
 * Проверяем:
 *  1. чтение файла (read_file), события tool_start/tool_result и полный ответ;
 *  2. apply_edit — правки уходят в renderer хостовым вызовом и возвращаются в диалог;
 *  3. отказ пользователя — это решение, а не ошибка приложения;
 *  4. битый аргумент не доходит до renderer;
 *  5. без моста apply_edit и run_terminal модели не предлагаются;
 *  6. run_terminal: подтверждение, код выхода и отказ; сжатие вывода — модели
 *     уходит текст без прогресса и повторов, а человек в карточке видит полный;
 *  7. ai.test объясняет удачу и неудачу словами;
 *  8. полный доступ: без подтверждений, но необратимые команды всё равно спрашивает;
 *  9. get_diagnostics — ошибки редактора доезжают до модели текстом;
 * 10. вложения контекста уходят в промпт отдельным сообщением;
 * 11. режим «Вопрос»: инструменты не предлагаются, моделе сказано об этом;
 * 12. режим «План»: только чтение, изменения не предлагаются и не исполняются;
 * 13. права доступа меняются на лету — агент подхватывает их во время ответа.
 *
 *   npm run smoke:agent
 *
 * Нужен собранный main (npm run build:main). Сеть и API-ключ не требуются.
 */
const { app } = require('electron');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promises: fs } = require('node:fs');

const { AiService } = require('../dist/main/ai/service.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');

const MARKER = 'chui-agent-marker';

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Ответ ровно в том виде, в каком его отдаёт OpenAI-совместимый провайдер. */
function sendSse(res, payloads) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/** Что сервер «попросит» на первом шаге текущего сценария. */
let requested = { name: 'read_file', args: {} };
/** Если true — тот же вызов приходит и вторым шагом (проверка дедупликации). */
let requestTwice = false;
/** Если true — инструмент вызывается два шага подряд (проверка смены прав на лету). */
let requestTwoCalls = false;
let turn = 0;
/** Тела запросов к провайдеру: по ним видно, какие инструменты ему предложили. */
const bodies = [];

function toolCallSse(name, args) {
  const raw = JSON.stringify(args);
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }],
          },
        },
      ],
    },
    // Аргументы приходят кусками JSON — их надо склеить.
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(0, 7) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(7) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function textSse(content) {
  return [
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 11, completion_tokens: 7 } },
  ];
}

/** Размышления приходят отдельным полем, до и вместе с ответом. */
function reasoningSse(thoughts) {
  return thoughts.split(' ').map((word) => ({ choices: [{ delta: { reasoning_content: `${word} ` } }] }));
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-agent-'));
  const file = path.join(dir, 'notes.txt');
  await fs.writeFile(file, `строка один\n${MARKER}\nстрока три\n`, 'utf8');

  const server = http.createServer(async (req, res) => {
    // «Проверить подключение» — обычный GET /models.
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }

    // Веб-поиск: инструмент ходит на тот же локальный сервер, что и за моделями,
    // поэтому проверка идёт через настоящий fetch (адрес — localhost, он разрешён).
    if ((req.url ?? '').includes('/search?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            { title: 'Документация <b>scale</b>', url: 'https://docs.example/scale', content: 'фильтр <b>scale</b>' },
          ],
        }),
      );
      return;
    }

    const body = await readBody(req);
    bodies.push(body);

    // Первый шаг — вызов инструмента; второй — текст (результат уже в диалоге).
    // requestTwice заставляет сервер повторить тот же вызов и на втором шаге.
    if (turn === 0 || ((requestTwice || requestTwoCalls) && turn === 1)) {
      turn += 1;
      sendSse(res, toolCallSse(requested.name, requested.args));
      return;
    }
    sendSse(res, [...reasoningSse('Сначала прочитаю файл'), ...textSse(`Готово: ${MARKER}`)]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const settings = {
    ai: {
      enabled: true,
      providers: [{ id: 'local', label: 'Локальный', baseUrl, models: ['test'], hasApiKey: false }],
      temperature: 0,
      maxTokens: 256,
      compactAtTokens: 100_000,
      systemPrompt: '',
      reasoningEffort: 'off',
      maxSteps: 8,
      maxAutopilotSteps: 24,
      confirmDangerous: true,
      // Веб-поиск по умолчанию выключен и включается проверками ниже.
      webSearch: { enabled: false, provider: 'searxng', endpoint: '', hasApiKey: false },
    },
    get() {
      return this;
    },
    // AiService читает рядом с файлом настроек поправку к оценке токенов
    // (см. `readCalibration`): без `file()` падало уже в конструкторе.
    file() {
      return path.join(dir, 'settings.json');
    },
    resolveApiKey() {
      return undefined;
    },
    resolveWebSearchKey() {
      return undefined;
    },
  };

  const workspace = new WorkspaceService(() => undefined);
  const ai = new AiService(settings, workspace);

  /** Один прогон агента: что просили, какие события пришли, что ушло провайдеру. */
  const chat = async (host, useTools = true, autoApprove = false, attachments, extra = {}) => {
    turn = 0;
    bodies.length = 0;
    const events = [];
    let streamed = '';
    const done = await ai.chat(
      {
        providerId: 'local',
        model: 'test',
        messages: [{ role: 'user', content: 'вопрос' }],
        useTools,
        autoApprove,
        attachments,
        ...extra,
      },
      (event, payload) => {
        events.push([event, payload]);
        if (event === 'delta') streamed += payload.text;
      },
      new AbortController().signal,
      host,
    );
    return {
      streamed,
      done,
      bodies: bodies.map((body) => ({ ...body })),
      starts: events.filter(([event]) => event === 'tool_start').map(([, payload]) => payload),
      results: events.filter(([event]) => event === 'tool_result').map(([, payload]) => payload),
      reasoning: events
        .filter(([event]) => event === 'reasoning')
        .map(([, payload]) => payload.text)
        .join(''),
      toolNames: (bodies[0]?.tools ?? []).map((tool) => tool.function.name),
    };
  };

  /** Текст, который реально ушёл модели: tool-сообщения из тела последнего запроса. */
  const sentToModel = (body) =>
    (body?.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content ?? ''))
      .join('\n');

  try {
    await workspace.open(dir);

    /* 1. чтение файла */
    requested = { name: 'read_file', args: { path: file } };
    let run = await chat(undefined);
    check('модель запросила read_file', run.starts.length === 1 && run.starts[0].name === 'read_file');
    check('инструмент исполнился успешно', run.results.length === 1 && run.results[0].ok === true);
    check('содержимое файла ушло модели', String(run.results[0]?.detail ?? '').includes(MARKER));
    check('стрим склеился в полный ответ', run.streamed === run.done.text && run.streamed.includes(MARKER));
    check('usage доехал до renderer', run.done.usage?.completionTokens === 7, run.done.usage);
    check(
      'размышления пришли отдельным потоком',
      run.reasoning.includes('Сначала прочитаю файл') && run.done.reasoning === run.reasoning,
      run.reasoning,
    );

    /* 1a. read_file диапазоном: только запрошенные строки, с номерами */
    requested = { name: 'read_file', args: { path: file, startLine: 3, endLine: 3 } };
    run = await chat(undefined);
    const ranged = String(run.results[0]?.detail ?? '');
    check(
      'read_file отдал только запрошенный диапазон с номерами',
      ranged.includes('3 | строка три') && !ranged.includes('строка один'),
      ranged,
    );

    /* 1b. повторный одинаковый вызов не исполняется второй раз */
    requestTwice = true;
    requested = { name: 'read_file', args: { path: file } };
    run = await chat(undefined);
    requestTwice = false;
    check(
      'повторный одинаковый вызов помечен как повтор',
      run.results.length === 2 &&
        run.results[0]?.ok === true &&
        run.results[1]?.ok === false &&
        /повтор/i.test(String(run.results[1]?.summary)),
      run.results.map((item) => item.summary),
    );
    check('без моста apply_edit не предлагается', !run.toolNames.includes('apply_edit'), run.toolNames);

    /* 1в. codebase_search: сперва объявления символов, затем текстовые совпадения.
       Символы приходят от языкового сервера — в проверке его роль играет заглушка. */
    check('без языкового сервера codebase_search не предлагается', !run.toolNames.includes('codebase_search'));

    ai.attachSymbols({
      projectSymbols: async (query) =>
        String(query).includes('read')
          ? [
              { name: 'readFileSync', kind: 'функция', container: null, path: file, line: 9, column: 1 },
              { name: 'readFile', kind: 'функция', container: null, path: file, line: 2, column: 1 },
            ]
          : [],
    });

    requested = { name: 'codebase_search', args: { query: 'read file' } };
    run = await chat(undefined);
    const codeSearch = String(run.results[0]?.detail ?? '');
    check('codebase_search предлагается с языковым сервером', run.toolNames.includes('codebase_search'), run.toolNames);
    check('объявление символа в ответе', codeSearch.includes('функция readFile'), codeSearch);
    check(
      'точное имя идёт раньше похожего',
      codeSearch.indexOf('readFile') < codeSearch.indexOf('readFileSync'),
      codeSearch,
    );
    check('путь символа показан относительно папки', codeSearch.includes('notes.txt:2'), codeSearch);

    requested = { name: 'codebase_search', args: { query: MARKER } };
    run = await chat(undefined);
    const textSearch = String(run.results[0]?.detail ?? '');
    check('текстовые совпадения свёрнуты по файлам', textSearch.includes('Где встречается:'), textSearch);
    check('сводка по файлу: сколько и где первое', /notes\.txt — \d+ совпадение/.test(textSearch), textSearch);

    requested = { name: 'codebase_search', args: { query: 'нет-такого-имени' } };
    run = await chat(undefined);
    check(
      'пустой результат назван честно',
      /ничего не найдено/.test(String(run.results[0]?.summary ?? '')),
      run.results[0]?.summary,
    );

    /* 1г. web_search: выключен по умолчанию, включается настройкой.
       Адрес — тот же локальный сервер, поэтому проверяется настоящий fetch. */
    check('без настройки web_search не предлагается', !run.toolNames.includes('web_search'), run.toolNames);

    settings.ai.webSearch = {
      enabled: true,
      provider: 'searxng',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      hasApiKey: false,
    };
    requested = { name: 'web_search', args: { query: 'ffmpeg scale' } };
    run = await chat(undefined);
    const searchResult = String(run.results[0]?.detail ?? '');
    check('включённый web_search предлагается', run.toolNames.includes('web_search'), run.toolNames);
    check('результаты поиска дошли до модели', searchResult.includes('https://docs.example/scale'), searchResult);
    check(
      'разметка в выдаче снята, а источник назван',
      !searchResult.includes('<b>') && searchResult.includes('SearxNG'),
      searchResult,
    );

    // Brave без ключа — заведомо нерабочий инструмент: модели его не показываем.
    settings.ai.webSearch = { enabled: true, provider: 'brave', endpoint: '', hasApiKey: false };
    run = await chat(undefined);
    check('Brave без ключа не предлагается', !run.toolNames.includes('web_search'), run.toolNames);

    settings.ai.webSearch = { enabled: false, provider: 'searxng', endpoint: '', hasApiKey: false };

    /* 1д. внешние инструменты (MCP): список приходит снаружи, изменяющие требуют
       подтверждения — как команды терминала. Роль сервиса здесь играет заглушка. */
    const external = [];
    ai.attachMcp({
      list: async () => [
        {
          serverId: 'files',
          toolName: 'read',
          exposedName: 'mcp__files__read',
          description: 'Внешнее чтение',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
        },
        {
          serverId: 'files',
          toolName: 'write',
          exposedName: 'mcp__files__write',
          description: 'Внешняя запись',
          inputSchema: { type: 'object', properties: {} },
          readOnly: false,
        },
      ],
      call: async (name, args) => {
        external.push([name, args]);
        return { text: `внешний вызов ${name}`, isError: false };
      },
    });

    const externalHost = {
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand: (command) => {
        external.push(['confirm', command]);
        return Promise.resolve(true);
      },
    };

    requested = { name: 'mcp__files__read', args: { path: 'a.txt' } };
    run = await chat(externalHost);
    check('внешний инструмент предложен модели', run.toolNames.includes('mcp__files__read'), run.toolNames);
    check('чтение внешнего инструмента не спрашивает разрешения', !external.some(([kind]) => kind === 'confirm'));
    check(
      'результат внешнего вызова ушёл модели',
      String(run.results[0]?.detail ?? '').includes('внешний вызов mcp__files__read'),
      run.results[0]?.detail,
    );

    requested = { name: 'mcp__files__write', args: { note: 'x' } };
    run = await chat(externalHost);
    check(
      'изменяющий внешний вызов спрашивает подтверждение',
      external.some(([kind]) => kind === 'confirm'),
      external,
    );
    check('подтверждённый вызов исполнен', run.results[0]?.ok === true, run.results[0]?.summary);

    run = await chat({
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand: () => Promise.resolve(false),
    });
    check(
      'отказ пользователя виден модели',
      run.results[0]?.ok === false && /запретил/.test(String(run.results[0]?.summary)),
      run.results[0]?.summary,
    );

    run = await chat({ applyEdits: () => Promise.resolve({ rejected: true }) });
    check(
      'без confirmCommand изменяющий внешний инструмент не предлагается',
      !run.toolNames.includes('mcp__files__write'),
      run.toolNames,
    );

    run = await chat(externalHost, true, false, undefined, { planMode: true });
    check(
      'в режиме плана внешние инструменты не предлагаются',
      !run.toolNames.some((name) => name.startsWith('mcp__')),
      run.toolNames,
    );

    /* 2. правки приняты */
    const recorded = [];
    const accepted = {
      applyEdits(edits) {
        recorded.push(edits);
        return Promise.resolve({
          rejected: false,
          result: {
            reports: edits.map((item) => ({ path: item.path, applied: item.edits.length, version: 2 })),
            failed: [],
          },
        });
      },
    };
    requested = {
      name: 'apply_edit',
      args: {
        edits: [
          { path: file, edits: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 20, newText: 'новый текст' }] },
        ],
      },
    };
    run = await chat(accepted);
    check('с мостом apply_edit предлагается', run.toolNames.includes('apply_edit'), run.toolNames);
    check('правки ушли в renderer', recorded.length === 1 && recorded[0][0].path === file, recorded.length);
    check('позиции правки сохранились', recorded[0]?.[0]?.edits?.[0]?.startLine === 2);
    check(
      'результат правок вернулся модели',
      run.results[0]?.ok === true && run.results[0]?.summary.includes('1'),
      run.results[0]?.summary,
    );

    /* 3. правки отклонены */
    run = await chat({ applyEdits: () => Promise.resolve({ rejected: true }) });
    check(
      'отказ пользователя виден модели',
      run.results[0]?.ok === false && run.results[0]?.summary.includes('отклонил'),
      run.results[0]?.summary,
    );

    /* 4. битый аргумент не доходит до renderer */
    const touched = [];
    const guard = {
      applyEdits(edits) {
        touched.push(edits);
        return Promise.resolve({ rejected: true });
      },
    };
    const oneEdit = (overrides) => ({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      newText: 'x',
      ...overrides,
    });

    requested = { name: 'apply_edit', args: { edits: [{ path: 'notes.txt', edits: [oneEdit({})] }] } };
    run = await chat(guard);
    check(
      'относительный путь отклонён',
      run.results[0]?.ok === false && run.results[0]?.summary.includes('абсолютный'),
      run.results[0]?.summary,
    );

    requested = { name: 'apply_edit', args: { edits: [{ path: file, edits: [oneEdit({ startLine: 0 })] }] } };
    run = await chat(guard);
    check(
      'нулевая строка отклонена',
      run.results[0]?.ok === false && run.results[0]?.summary.includes('≥ 1'),
      run.results[0]?.summary,
    );
    check('renderer не тронут битыми аргументами', touched.length === 0);

    /* 5. запуск команды */
    const commands = [];
    const shellHost = {
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand(command) {
        commands.push(command);
        return Promise.resolve(true);
      },
    };

    requested = { name: 'run_terminal', args: { command: 'echo chui-cmd-ok' } };
    run = await chat(shellHost);
    check('с мостом run_terminal предлагается', run.toolNames.includes('run_terminal'), run.toolNames);
    check('команда выполнена успешно', run.results[0]?.ok === true, run.results[0]?.summary);
    check(
      'вывод команды ушёл модели',
      String(run.results[0]?.detail ?? '').includes('chui-cmd-ok'),
      run.results[0]?.detail,
    );
    check('команда дошла до подтверждения', commands[0] === 'echo chui-cmd-ok', commands);
    check('вывод доходит до модели без потерь', sentToModel(run.bodies[1]).includes('chui-cmd-ok'));

    /* 6а. сжатие вывода: модели уходит текст без оформления, человеку — как есть.
       Команда нарочно печатает прогресс-полосу и повтор строки. На Windows здесь
       cmd.exe без printf, поэтому проверяем под POSIX-шелл. */
    if (process.platform !== 'win32') {
      requested = {
        name: 'run_terminal',
        args: { command: "printf '[####>  ] 45%%\\nwarn\\nwarn\\nwarn\\nитог-сжатия\\n'" },
      };
      run = await chat(shellHost);
      const sent = sentToModel(run.bodies[1]);
      // Эхо самой команды (`$ printf '…'`) — не вывод: проверяем строки вывода.
      const output = sent.split('\n').filter((line) => !line.startsWith('$ '));
      check('полоса прогресса не ушла модели', !output.some((line) => line.includes('[####')), output);
      check('повтор строки схлопнут', sent.includes('повторена'), sent);
      check('содержание вывода сохранено', sent.includes('итог-сжатия'), sent);
      check(
        'человеку в карточке — полный вывод',
        String(run.results[0]?.detail ?? '').includes('[####>  ] 45%'),
        run.results[0]?.detail,
      );

      settings.ai.compressOutput = false;
      run = await chat(shellHost);
      check('сжатие выключено — вывод уходит как есть', sentToModel(run.bodies[1]).includes('[####>  ] 45%'));
      delete settings.ai.compressOutput;
    }

    requested = { name: 'run_terminal', args: { command: 'exit 3' } };
    run = await chat(shellHost);
    check(
      'ненулевой код возврата виден',
      run.results[0]?.ok === false && String(run.results[0]?.summary).includes('3'),
      run.results[0]?.summary,
    );

    /* 6. отказ в выполнении */
    const denied = [];
    requested = { name: 'run_terminal', args: { command: 'rm -rf /' } };
    run = await chat({
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand(command) {
        denied.push(command);
        return Promise.resolve(false);
      },
    });
    check(
      'отказ виден модели',
      run.results[0]?.ok === false && String(run.results[0]?.summary).includes('запретил'),
      run.results[0]?.summary,
    );
    check('отказ дошёл до подтверждения', denied.length === 1, denied);

    /* 7. без confirmCommand запуск команд не предлагается */
    requested = { name: 'read_file', args: { path: file } };
    run = await chat({ applyEdits: () => Promise.resolve({ rejected: true }) });
    check('без confirmCommand run_terminal не предлагается', !run.toolNames.includes('run_terminal'), run.toolNames);

    /* 8. пустая команда не доходит до подтверждения */
    const blank = [];
    requested = { name: 'run_terminal', args: { command: '   ' } };
    run = await chat({
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand(command) {
        blank.push(command);
        return Promise.resolve(true);
      },
    });
    check(
      'пустая команда отклонена',
      run.results[0]?.ok === false && String(run.results[0]?.summary).includes('command'),
      run.results[0]?.summary,
    );
    check('пустая команда не дошла до подтверждения', blank.length === 0);

    /* 9. проверка подключения */
    const tested = await ai.testConnection({ baseUrl, providerId: 'local' });
    check('ai.test находит модели', tested.ok && tested.models.length === 2, tested.message);

    const noKey = await ai.testConnection({ baseUrl: 'https://example.invalid/v1' });
    check('ai.test просит ключ для внешнего адреса', !noKey.ok && noKey.message.includes('ключ'), noKey.message);

    const refused = await ai.testConnection({ baseUrl: 'http://127.0.0.1:59999/v1' });
    check(
      'ai.test объясняет недоступный сервер',
      !refused.ok && refused.message.includes('не отвечает'),
      refused.message,
    );

    /* 10. полный доступ */
    const autoCalls = [];
    const autoHost = {
      applyEdits(edits, autoApprove) {
        autoCalls.push({ kind: 'edits', autoApprove });
        return Promise.resolve({
          rejected: false,
          result: {
            reports: edits.map((item) => ({ path: item.path, applied: item.edits.length, version: 2 })),
            failed: [],
          },
        });
      },
      confirmCommand(command) {
        autoCalls.push({ kind: 'confirm', command });
        return Promise.resolve(true);
      },
    };

    requested = { name: 'run_terminal', args: { command: 'echo полный-доступ' } };
    run = await chat(autoHost, true, true);
    check('полный доступ выполняет рядовую команду', run.results[0]?.ok === true, run.results[0]?.summary);
    check(
      'полный доступ не спрашивает про рядовую команду',
      autoCalls.filter((c) => c.kind === 'confirm').length === 0,
      autoCalls,
    );

    requested = { name: 'run_terminal', args: { command: 'rm -rf /' } };
    run = await chat(autoHost, true, true);
    check(
      'полный доступ всё равно спрашивает про необратимую команду',
      autoCalls.some((c) => c.kind === 'confirm'),
      autoCalls,
    );

    requested = {
      name: 'apply_edit',
      args: { edits: [{ path: file, edits: [oneEdit({})] }] },
    };
    run = await chat(autoHost, true, true);
    check(
      'полный доступ применяет правки без ревью',
      autoCalls.some((c) => c.kind === 'edits' && c.autoApprove === true),
      autoCalls,
    );
    check('результат правок вернулся модели при полном доступе', run.results[0]?.ok === true, run.results[0]?.summary);

    /* 11. режим «План»: только чтение, изменения не исполняются */
    requested = { name: 'apply_edit', args: { edits: [{ path: file, edits: [oneEdit({})] }] } };
    run = await chat({ applyEdits: () => Promise.resolve({ rejected: true }) }, true, false, undefined, {
      planMode: true,
    });
    check(
      'в режиме «План» инструменты изменения не предлагаются',
      !run.toolNames.includes('apply_edit') && !run.toolNames.includes('run_terminal'),
      run.toolNames,
    );
    check(
      'в режиме «План» чтение предлагается',
      run.toolNames.includes('read_file') && run.toolNames.includes('update_plan'),
      run.toolNames,
    );
    check(
      'в режиме «План» изменение не исполняется',
      run.results[0]?.ok === false && /план/i.test(String(run.results[0]?.summary)),
      run.results[0]?.summary,
    );

    /* 12. права доступа можно менять на лету: кнопка в композере */
    requestTwoCalls = true;
    requested = { name: 'run_terminal', args: { command: 'echo раз' } };
    const permLog = [];
    run = await chat(
      {
        applyEdits: () => Promise.resolve({ rejected: true }),
        confirmCommand(command) {
          permLog.push(command);
          // Пользователь включает полный доступ, пока агент ещё работает.
          ai.setAutoApprove(true);
          return Promise.resolve(true);
        },
      },
      true,
      false,
    );
    requestTwoCalls = false;
    check('первое действие спросило разрешение', permLog.length === 1, permLog);
    check('после включения прав второе действие не спрашивает', permLog.length === 1, permLog);
    check(
      'оба действия выполнились',
      run.results.length === 2 && run.results.every((item) => item.ok === true),
      run.results.map((item) => item.summary),
    );

    /* 11. диагностика */
    const diagHost = {
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand: () => Promise.resolve(true),
      getDiagnostics: () =>
        Promise.resolve({
          items: [
            {
              path: file,
              line: 3,
              column: 5,
              severity: 'error',
              message: 'Тип string не присваивается number',
              source: 'ts',
            },
            {
              path: file,
              line: 8,
              column: 1,
              severity: 'warning',
              message: 'Переменная не используется',
              source: 'eslint',
            },
          ],
        }),
    };

    requested = { name: 'get_diagnostics', args: {} };
    run = await chat(diagHost);
    check('get_diagnostics предлагается с мостом', run.toolNames.includes('get_diagnostics'), run.toolNames);
    check(
      'диагностика вернулась модели',
      run.results[0]?.ok === true && String(run.results[0]?.summary).includes('ошибок: 1'),
      run.results[0]?.summary,
    );
    check('в выводе есть текст ошибки', String(run.results[0]?.detail ?? '').includes('не присваивается'));

    requested = { name: 'read_file', args: { path: file } };
    run = await chat({ applyEdits: () => Promise.resolve({ rejected: true }) });
    check('без моста get_diagnostics не предлагается', !run.toolNames.includes('get_diagnostics'), run.toolNames);

    /* 12. вложения контекста */
    requested = { name: 'read_file', args: { path: file } };
    await chat(undefined, true, false, [
      { kind: 'selection', label: 'выделение', title: 'Выделение из notes.txt', text: '```\nconst a = 1;\n```' },
    ]);
    const first = bodies[0]?.messages ?? [];
    check(
      'вложение уехало отдельным системным сообщением',
      first.some((m) => m.role === 'system' && String(m.content).includes('Контекст, который приложил пользователь')),
      first.map((m) => m.role),
    );
    check(
      'текст вложения дошёл до провайдера',
      first.some((m) => m.role === 'system' && String(m.content).includes('const a = 1;')),
    );

    /* 13. усилие размышления — только тем моделям, которые его понимают */
    requested = { name: 'read_file', args: { path: file } };
    run = await chat(undefined, false, false, undefined, { model: 'o3-mini', reasoningEffort: 'high' });
    check(
      'reasoning_effort доехал до провайдера',
      run.bodies[0]?.reasoning_effort === 'high',
      run.bodies[0]?.reasoning_effort,
    );
    check(
      'модели с фиксированным размышлением temperature не отправляется',
      run.bodies[0]?.temperature === undefined,
      run.bodies[0]?.temperature,
    );

    run = await chat(undefined, false, false, undefined, { model: 'deepseek-reasoner', reasoningEffort: 'high' });
    check(
      'deepseek-reasoner не получает ни усилия, ни температуры',
      run.bodies[0]?.reasoning_effort === undefined && run.bodies[0]?.temperature === undefined,
      { effort: run.bodies[0]?.reasoning_effort, temperature: run.bodies[0]?.temperature },
    );

    run = await chat(undefined, false, false, undefined, { model: 'gpt-4o-mini', reasoningEffort: 'high' });
    check('обычной модели reasoning_effort не уходит', run.bodies[0]?.reasoning_effort === undefined);
    check('обычной модели temperature уходит', run.bodies[0]?.temperature === 0, run.bodies[0]?.temperature);

    run = await chat(undefined, false, false, undefined, { model: 'o3-mini', reasoningEffort: 'off' });
    check(
      '«без размышлений» ничего не отправляет',
      run.bodies[0]?.reasoning_effort === undefined,
      run.bodies[0]?.reasoning_effort,
    );

    check('в режиме «Вопрос» инструменты не предлагаются', run.bodies[0]?.tools === undefined);
    check(
      'в режиме «Вопрос» модели сказано, что инструменты выключены',
      (run.bodies[0]?.messages ?? []).some((m) => m.role === 'system' && /выключены/i.test(String(m.content))),
    );

    /* 6. изображения: уходят частями последнего сообщения пользователя */
    const shot = 'data:image/png;base64,iVBORw0KGgo=';
    run = await chat(undefined, false, false, [
      { kind: 'image', label: 'shot.png', title: 'Изображение shot.png', text: '', dataUrl: shot, bytes: 42 },
      { kind: 'file', label: 'a.js', title: 'Файл a.js', text: 'const a = 1;' },
    ]);
    const wire = run.bodies[0]?.messages ?? [];
    const lastUser = [...wire].reverse().find((message) => message.role === 'user');
    const parts = Array.isArray(lastUser?.content) ? lastUser.content : [];
    check(
      'картинка стала частью сообщения пользователя',
      parts.some((part) => part.type === 'image_url' && part.image_url?.url === shot),
      JSON.stringify(lastUser?.content)?.slice(0, 160),
    );
    check(
      'текст вопроса остался рядом с картинкой',
      parts.some((part) => part.type === 'text' && part.text === 'вопрос'),
    );
    check(
      'файл-вложение по-прежнему едет системным текстом',
      wire.some((message) => message.role === 'system' && String(message.content).includes('const a = 1;')),
    );
    check(
      'модель видит, какие изображения приложили',
      wire.some((message) => message.role === 'system' && String(message.content).includes('shot.png')),
    );

    // Вложение с чужим типом — отказ, а не тихая отправка: data-URL с текстом
    // вместо картинки провайдер отвергнет уже своим ответом, и в чате будет
    // непонятная ошибка вместо внятной причины.
    let rejected = false;
    let rejectedBodies = 0;
    try {
      const bad = await chat(undefined, false, false, [
        {
          kind: 'image',
          label: 'big.png',
          title: 'Изображение big.png',
          text: '',
          dataUrl: 'data:text/plain;base64,AAAA',
        },
      ]);
      rejectedBodies = bad.bodies.length;
    } catch {
      rejected = true;
    }
    check('не изображение в data-URL отклонено', rejected && rejectedBodies === 0);
  } catch (error) {
    failed = true;
    console.error('[chui] исключение:', error);
  } finally {
    server.close();
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    console.log(failed ? '[chui] агентный цикл НЕ прошёл' : '[chui] агентный цикл работает');
    app.exit(failed ? 1 : 0);
  }
});
