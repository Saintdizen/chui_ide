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
 *  6. run_terminal: подтверждение, код выхода и отказ;
 *  7. ai.test объясняет удачу и неудачу словами;
 *  8. автопилот: без подтверждений, но необратимые команды всё равно спрашивает;
 *  9. get_diagnostics — ошибки редактора доезжают до модели текстом;
 * 10. вложения контекста уходят в промпт отдельным сообщением.
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

    const body = await readBody(req);
    bodies.push(body);

    // Первый шаг — вызов инструмента; второй — текст (результат уже в диалоге).
    // requestTwice заставляет сервер повторить тот же вызов и на втором шаге.
    if (turn === 0 || (requestTwice && turn === 1)) {
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
      providers: [{ id: 'local', label: 'Локальный', baseUrl, models: ['test'], hasApiKey: false }],
      temperature: 0,
      maxTokens: 256,
      systemPrompt: '',
      reasoningEffort: 'off',
    },
    get() {
      return this;
    },
    resolveApiKey() {
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
      reasoning: events.filter(([event]) => event === 'reasoning').map(([, payload]) => payload.text).join(''),
      toolNames: (bodies[0]?.tools ?? []).map((tool) => tool.function.name),
    };
  };

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
      run.results.length === 2 && run.results[0]?.ok === true && run.results[1]?.ok === false && /повтор/i.test(String(run.results[1]?.summary)),
      run.results.map((item) => item.summary),
    );
    check('без моста apply_edit не предлагается', !run.toolNames.includes('apply_edit'), run.toolNames);

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
    const oneEdit = (overrides) => ({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, newText: 'x', ...overrides });

    requested = { name: 'apply_edit', args: { edits: [{ path: 'notes.txt', edits: [oneEdit({})] }] } };
    run = await chat(guard);
    check(
      'относительный путь отклонён',
      run.results[0]?.ok === false && run.results[0]?.summary.includes('абсолютный'),
      run.results[0]?.summary,
    );

    requested = { name: 'apply_edit', args: { edits: [{ path: file, edits: [oneEdit({ startLine: 0 })] }] } };
    run = await chat(guard);
    check('нулевая строка отклонена', run.results[0]?.ok === false && run.results[0]?.summary.includes('≥ 1'), run.results[0]?.summary);
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
    check('вывод команды ушёл модели', String(run.results[0]?.detail ?? '').includes('chui-cmd-ok'), run.results[0]?.detail);
    check('команда дошла до подтверждения', commands[0] === 'echo chui-cmd-ok', commands);

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
    check('ai.test объясняет недоступный сервер', !refused.ok && refused.message.includes('не отвечает'), refused.message);

    /* 10. автопилот */
    const autoCalls = [];
    const autoHost = {
      applyEdits(edits, autoApprove) {
        autoCalls.push({ kind: 'edits', autoApprove });
        return Promise.resolve({
          rejected: false,
          result: { reports: edits.map((item) => ({ path: item.path, applied: item.edits.length, version: 2 })), failed: [] },
        });
      },
      confirmCommand(command) {
        autoCalls.push({ kind: 'confirm', command });
        return Promise.resolve(true);
      },
    };

    requested = { name: 'run_terminal', args: { command: 'echo автопилот' } };
    run = await chat(autoHost, true, true);
    check('автопилот выполняет рядовую команду', run.results[0]?.ok === true, run.results[0]?.summary);
    check('автопилот не спрашивает про рядовую команду', autoCalls.filter((c) => c.kind === 'confirm').length === 0, autoCalls);

    requested = { name: 'run_terminal', args: { command: 'rm -rf /' } };
    run = await chat(autoHost, true, true);
    check('автопилот всё равно спрашивает про необратимую команду', autoCalls.some((c) => c.kind === 'confirm'), autoCalls);

    requested = {
      name: 'apply_edit',
      args: { edits: [{ path: file, edits: [oneEdit({})] }] },
    };
    run = await chat(autoHost, true, true);
    check('автопилот применяет правки без ревью', autoCalls.some((c) => c.kind === 'edits' && c.autoApprove === true), autoCalls);
    check('результат правок вернулся модели и в автопилоте', run.results[0]?.ok === true, run.results[0]?.summary);

    /* 11. диагностика */
    const diagHost = {
      applyEdits: () => Promise.resolve({ rejected: true }),
      confirmCommand: () => Promise.resolve(true),
      getDiagnostics: () =>
        Promise.resolve({
          items: [
            { path: file, line: 3, column: 5, severity: 'error', message: 'Тип string не присваивается number', source: 'ts' },
            { path: file, line: 8, column: 1, severity: 'warning', message: 'Переменная не используется', source: 'eslint' },
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
    check('reasoning_effort доехал до провайдера', run.bodies[0]?.reasoning_effort === 'high', run.bodies[0]?.reasoning_effort);
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
    check('«без размышлений» ничего не отправляет', run.bodies[0]?.reasoning_effort === undefined, run.bodies[0]?.reasoning_effort);

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
    check('текст вопроса остался рядом с картинкой', parts.some((part) => part.type === 'text' && part.text === 'вопрос'));
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
        { kind: 'image', label: 'big.png', title: 'Изображение big.png', text: '', dataUrl: 'data:text/plain;base64,AAAA' },
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
