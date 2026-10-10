/**
 * Проба ряда изменённых файлов в ленте чата.
 *
 *   npm run probe:chat-files
 *
 * Агент правит файлы — под строкой вызова должен появиться ряд чипов: что именно
 * тронул инструмент и что с этим сделал. Ряд проверяется на живом ответе: проба
 * поднимает поддельный OpenAI-совместимый провайдер (`scripts/agent-smoke.cjs`
 * делает так же), просит у агента создать файл и смотрит, что получилось в ленте.
 *
 * Проверяем: чип появился, назван файлом (а не путём), подписан видом операции,
 * ряд не спрятан в свёрнутой группе и клик по чипу открывает файл в редакторе.
 *
 * Нужен собранный main и renderer (npm run build). Сеть и API-ключ не требуются.
 */
const { app } = require('electron');
const http = require('node:http');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { McpService } = require('../dist/main/mcp/mcp.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 30000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

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
    req.on('end', () => resolve(raw));
  });
}

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-chat-files-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'console.log(1);\n', 'utf8');
  const created = path.join(project, 'src', 'fresh.txt');

  /* Провайдер: первый шаг агента — создать файл, второй — сказать «готово». */
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    if ((req.url ?? '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    await readBody(req);
    turn += 1;
    if (turn === 1) {
      sendSse(res, toolCallSse('create_file', { path: created, contents: 'привет из пробы\n' }));
      return;
    }
    sendSse(res, textSse('Готово.'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  settings.update({
    ai: {
      enabled: true,
      provider: {
        id: 'fake',
        label: 'Проба',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: ['fake-model'],
        defaultModel: 'fake-model',
      },
      activeProviderId: 'fake',
      activeModel: 'fake-model',
    },
  });
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const mcp = new McpService(
    () => settings.get().ai.mcpServers,
    () => workspace.rootPath(),
  );
  registerIpc({ settings, workspace, ai, terminals, git, mcp, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  /* Режим «Агент»: в «Вопросе» инструменты модели не предлагаются. */
  const mode = await ask(
    ide,
    `(async () => {
      const select = document.querySelector('.composer-select');
      if (!select) return 'переключателя режима нет';
      select.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const option = [...document.querySelectorAll('.select-popup [role="option"]')].find(
        (node) => (node.textContent || '').includes('Агент'),
      );
      if (!option) return 'режима «Агент» нет';
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return 'агент';
    })()`,
  );
  check('режим «Агент» включён', mode === 'агент', mode);

  const sent = await ask(
    ide,
    `(async () => {
      const input = document.querySelector('.chat-input');
      if (!input) return 'поля ввода нет';
      input.value = 'создай файл fresh.txt в src';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'отправлено';
    })()`,
  );
  check('вопрос отправлен', sent === 'отправлено', sent);

  /* Ждём ряд чипов: ответ идёт шагами, агент сперва вызывает инструмент. */
  const row = await ask(
    ide,
    `(async () => {
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const chip = document.querySelector('.tool-file-chip');
        if (chip) {
          const row = chip.closest('.tool-files');
          return {
            чипов: document.querySelectorAll('.tool-file-chip').length,
            имя: (chip.querySelector('.tool-file-name') || {}).textContent ?? null,
            вид: (chip.querySelector('.tool-file-kind') || {}).textContent ?? null,
            title: chip.getAttribute('title'),
            строкаВЛенте: Boolean(chip.closest('.chat-thread')),
            высота: row ? Math.round(row.getBoundingClientRect().height) : 0,
            группа: Boolean(chip.closest('.tool-group')),
          };
        }
      }
      return 'чипа нет';
    })()`,
  );
  check('ряд файлов появился под вызовом', typeof row === 'object', row);
  check('в ряду один чип', row.чипов === 1, row.чипов);
  check('чип назван именем файла, а не путём', row.имя === 'fresh.txt', row.имя);
  check('вид операции подписан', row.вид === 'создан', row.вид);
  check('в подсказке чипа — полный путь', (row.title ?? '').includes(created), row.title);
  check('ряд стоит в ленте беседы', row.строкаВЛенте === true);
  check('ряд виден, а не спрятан в свёрнутой группе', row.высота > 0, row.высота);

  /* Клик по чипу открывает файл: это и есть смысл ряда — не искать файл в дереве. */
  const opened = await ask(
    ide,
    `(async () => {
      const chip = document.querySelector('.tool-file-chip');
      chip.click();
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const labels = [...document.querySelectorAll('.tab-label')].map((node) => node.textContent);
        if (labels.includes('fresh.txt')) return labels;
      }
      return 'файл не открылся';
    })()`,
  );
  check('клик по чипу открывает файл в редакторе', Array.isArray(opened), opened);

  server.close();
  workspace.dispose();
  terminals.dispose();
  mcp.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[chui] ряд изменённых файлов: есть расхождения' : '[chui] ряд изменённых файлов работает');
  app.exit(failed ? 1 : 0);
});
