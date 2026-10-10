/**
 * Проба карты проекта: A (карта в системном промпте) + B (инструмент project_map).
 *
 *   npm run smoke:map
 *
 * Смысл принципа «лучший способ чтения файлов — не читать их» проверяется здесь
 * буквально: агент должен узнать устройство проекта, не открыв ни одного файла.
 * Проба поднимает поддельный OpenAI-совместимый провайдер и смотрит, что уходит
 * модели в запросе, — то есть проверяет не разметку, а содержимое промпта.
 *
 * Проверяем: карта уже в системном промпте (без вызова инструмента); содержимое
 * файлов в неё не попадает; project_map предлагается и отвечает тем же скан;
 * в режиме «Вопрос» карты нет (там она только жгла бы токены); кэш по корню
 * держит числа до смены папки, а свежие даёт проект_map.
 *
 * Нужен собранный main (npm run build:main). Сеть и API-ключ не требуются.
 */
const { app } = require('electron');
const http = require('node:http');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AiService } = require('../dist/main/ai/service.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');

/** Строка, которой нет в именах файлов: по ней видно, попало ли содержимое в карту. */
const SECRET = 'chui-map-secret-marker';

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Первые строки длинного текста: в отчёте промпт целиком не нужен. */
const brief = (value, lines = 6) => String(value).split('\n').slice(0, lines).join('\n');

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

function toolCallSse(name, args) {
  const raw = JSON.stringify(args);
  return [
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw } }] } }] },
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

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-map-'));

  /** Проект-стенд: Node.js с кодом, тестами и точкой входа — как у настоящего. */
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'tests'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'index.js'), `const secret = '${SECRET}';\n`, 'utf8');
  await fs.writeFile(path.join(project, 'src', 'util.js'), 'module.exports = {};\n', 'utf8');
  await fs.writeFile(path.join(project, 'tests', 'util.test.js'), '// тест\n', 'utf8');

  /* Второй проект — другой корень: карта должна пересчитаться, а не остаться прежней. */
  const other = path.join(dir, 'py');
  await fs.mkdir(path.join(other, 'app'), { recursive: true });
  await fs.writeFile(path.join(other, 'pyproject.toml'), '[project]\nname = "p"\n', 'utf8');
  await fs.writeFile(path.join(other, 'app', 'main.py'), 'print(1)\n', 'utf8');

  let requested = { name: 'project_map', args: {} };
  const bodies = [];

  const server = http.createServer(async (req, res) => {
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test' }] }));
      return;
    }
    const body = await readBody(req);
    bodies.push(body);
    // Первый шаг — вызов запрошенного инструмента, второй — текст ответа.
    if (bodies.length === 1) {
      sendSse(res, toolCallSse(requested.name, requested.args));
      return;
    }
    sendSse(res, textSse('Готово.'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const settings = {
    ai: {
      enabled: true,
      providers: [
        { id: 'local', label: 'Локальный', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ['test'] },
      ],
      temperature: 0,
      maxTokens: 256,
      compactAtTokens: 100_000,
      systemPrompt: '',
      reasoningEffort: 'off',
      maxSteps: 8,
      confirmDangerous: true,
      webSearch: { enabled: false, provider: 'searxng', endpoint: '', hasApiKey: false },
    },
    get() {
      return this;
    },
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

  /** Один прогон агента: что ушло провайдеру и чем ответил инструмент. */
  const chat = async (useTools = true) => {
    bodies.length = 0;
    const results = [];
    const toolNames = [];
    await ai.chat(
      {
        providerId: 'local',
        model: 'test',
        messages: [{ role: 'user', content: 'что за проект?' }],
        useTools,
      },
      (event, payload) => {
        if (event === 'tool_result') results.push(payload);
      },
      new AbortController().signal,
      undefined,
    );
    const first = bodies[0] ?? {};
    const prompt = (first.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''))
      .join('\n');
    for (const tool of first.tools ?? []) toolNames.push(tool.function.name);
    const last = bodies[bodies.length - 1] ?? {};
    const toModel = (last.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content ?? ''))
      .join('\n');
    return { prompt, results, toolNames, toModel };
  };

  try {
    await workspace.open(project);

    /* A. Карта в системном промпте — без единого вызова инструмента. */
    requested = { name: 'project_map', args: {} };
    let run = await chat(true);

    check('карта проекта уже в системном промпте', run.prompt.includes('Карта проекта'), brief(run.prompt));
    check('вид проекта назван', run.prompt.includes('Проект: Node.js'), brief(run.prompt));
    check('карта сообщает число файлов и каталогов', /5 файлов в \d+ каталог/.test(run.prompt), brief(run.prompt));
    check('языки названы', run.prompt.includes('Языки: JavaScript'), brief(run.prompt));
    check('каталоги названы', run.prompt.includes('Каталоги: src, tests'), brief(run.prompt));
    check('тесты названы отдельной строкой', run.prompt.includes('Тесты: 1 файл'), brief(run.prompt));
    check('точка входа названа', run.prompt.includes('Точки входа: src/index.js'), brief(run.prompt));

    /* Принцип: карта собрана по именам файлов — содержимое в промпт не попадает. */
    check('содержимое файлов в промпт не попало', !run.prompt.includes(SECRET), brief(run.prompt));
    check(
      'в промпте сказано, что карта собрана по именам',
      run.prompt.includes('по именам файлов, содержимое не читалось'),
      brief(run.prompt, 2),
    );

    /* B. Инструмент: предлагается модели, отвечает тем же скан. */
    check('project_map предлагается модели', run.toolNames.includes('project_map'), run.toolNames);
    const detail = String(run.results[0]?.detail ?? '');
    check('project_map исполнился успешно', run.results[0]?.ok === true, run.results[0]?.summary);
    check('подробная форма называет манифест', detail.includes('Манифесты: package.json'), detail);
    check('подробная форма даёт пример теста', detail.includes('tests/util.test.js'), detail);
    check('подробная форма говорит, куда смотреть дальше', detail.includes('find_files'), detail);
    check('содержимое файлов в ответ инструмента не попало', !detail.includes(SECRET), brief(detail));
    check('ответ инструмента ушёл модели', run.toModel.includes('Проект: Node.js'), brief(run.toModel));
    check(
      'сводка инструмента называет проект',
      /Node\.js · 5 файлов/.test(run.results[0]?.summary ?? ''),
      run.results[0]?.summary,
    );

    /* Карта в промпте и ответ инструмента — один и тот же скан: не разъезжаются. */
    const sameLines = ['Проект:', 'Языки:', 'Каталоги:', 'Тесты:', 'Точки входа:'].map(
      (key) =>
        run.prompt.split('\n').find((line) => line.startsWith(key)) ===
        detail.split('\n').find((line) => line.startsWith(key)),
    );
    check('строки карты в промпте и в ответе — одни и те же', sameLines.every(Boolean), sameLines);

    /* Кэш: числа в промпте держатся до смены папки, свежие даёт project_map. */
    await fs.writeFile(path.join(project, 'src', 'extra.js'), '// новый файл\n', 'utf8');
    run = await chat(true);
    check('кэш держит карту в промпте (числа те же)', run.prompt.includes('5 файлов'), brief(run.prompt));
    check(
      'инструмент считает заново: числа свежие',
      String(run.results[0]?.detail ?? '').includes('6 файлов'),
      String(run.results[0]?.detail ?? '').split('\n')[1],
    );
    check(
      'промпт объясняет агенту, что подробности — в project_map',
      String(run.prompt.split('\n').find((line) => line.includes('project_map')) ?? '').includes('project_map'),
      run.prompt.split('\n').find((line) => line.includes('project_map')),
    );

    /* Смена папки: карта другого проекта — другая. */
    await workspace.open(other);
    run = await chat(true);
    check('карта пересчитана для нового проекта', run.prompt.includes('Проект: Python'), brief(run.prompt));
    check('чужой каталог в новой карте не остался', !run.prompt.includes('Каталоги: src'), brief(run.prompt));

    /* «Вопрос»: инструментов нет — карта только жгла бы токены. */
    run = await chat(false);
    check('в режиме «Вопрос» карты нет', !run.prompt.includes('Карта проекта'), brief(run.prompt, 2));
    check('рабочая папка всё равно названа', run.prompt.includes('Рабочая папка проекта'), brief(run.prompt, 2));
    check('инструменты в «Вопросе» не предлагаются', run.toolNames.length === 0, run.toolNames);
  } finally {
    server.close();
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(failed ? '[chui] карта проекта: есть расхождения' : '[chui] карта проекта работает');
  app.exit(failed ? 1 : 0);
});
