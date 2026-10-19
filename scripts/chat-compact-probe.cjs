/**
 * Проба сжатия контекста: переписка остаётся лентой, а не пропадает.
 *
 *   npm run probe:chatcompact
 *
 * Зачем отдельная проба. Сжатие контекста заменяло историю резюме И очищало ленту:
 * длинная беседа в один момент превращалась в одну сводку, а после перезапуска в
 * файле оставалась только она — со стороны это выглядело как «текст ответов
 * обрезался». Чинилось разделением: переписка (`transcript`, что читают) и контекст
 * (`history`, что уходит модели). Проверяется то, что видит человек:
 *
 *   1. сжатая до перезапуска беседа показывает всю переписку;
 *   2. живое сжатие кнопкой не стирает ленту и добавляет отметку о резюме.
 *
 * Модель подменена локальным OpenAI-совместимым сервером: нужен только ответ на
 * запрос сжатия. Нужен собранный renderer (`npm run build`).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { ChatStore } = require('../dist/main/ai/chat-store.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Локальный провайдер: отвечает резюме на запрос сжатия. */
async function fakeProvider() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = { id: 'x', choices: [{ delta: { content: 'КРАТКОЕ-РЕЗЮМЕ-БЕСЕДЫ' }, index: 0 }] };
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

const TALK = [
  { role: 'user', content: 'ПЕРВЫЙ-ВОПРОС' },
  { role: 'assistant', content: 'ПЕРВЫЙ-ОТВЕТ' },
  { role: 'user', content: 'ВТОРОЙ-ВОПРОС' },
  { role: 'assistant', content: 'ВТОРОЙ-ОТВЕТ' },
];

app.whenReady().then(async () => {
  const { server, port } = await fakeProvider();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-chat-compact-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'main.py'), 'print(1)\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      ai: {
        enabled: true,
        providers: [
          {
            id: 'probe',
            label: 'Probe',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            models: ['probe-1'],
            defaultModel: 'probe-1',
            apiKey: 'key',
          },
        ],
        activeProviderId: 'probe',
        activeModel: 'probe-1',
      },
    }),
    'utf8',
  );

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const chatStore = new ChatStore(path.join(dir, 'chats'));
  registerIpc({ settings, workspace, ai, terminals, git, chatStore, host: new HostClient() });
  await workspace.open(project);

  // Беседа в файле: переписка + сжатый контекст (так пишет IDE после сжатия).
  await chatStore.save(project, {
    conversations: [
      {
        uid: 'probe',
        title: 'Сжатая беседа',
        updatedAt: Date.now(),
        messages: TALK,
        context: [{ role: 'user', content: 'Контекст сжатой беседы:\n\nКРАТКОЕ-РЕЗЮМЕ-БЕСЕДЫ' }],
      },
    ],
    activeUid: 'probe',
  });

  const ide = openIdeWindow();
  await wait(6000);

  const restored = await ide.webContents.executeJavaScript(`(async () => {
    if (!document.querySelector('.chat-panel')?.getBoundingClientRect().width) {
      document.querySelector('[title*="AI Assistant"]')?.click();
      await new Promise((r) => setTimeout(r, 600));
    }
    const thread = document.querySelector('.chat-thread');
    return { text: thread?.textContent ?? '' };
  })()`);

  let failed = false;
  const check = (label, condition, extra) => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
    if (!condition) failed = true;
  };
  check(
    'после перезапуска переписка на месте',
    restored.text.includes('ПЕРВЫЙ-ОТВЕТ') && restored.text.includes('ВТОРОЙ-ОТВЕТ'),
    restored.text.slice(0, 120),
  );

  // Живое сжатие: открываем «Информацию о сессии» и жмём «Сжать беседу».
  const before = await ide.webContents.executeJavaScript(`(async () => {
    document.querySelector('.status-ai')?.parentElement?.click();
    await new Promise((r) => setTimeout(r, 600));
    const button = document.querySelector('.session-info-compact');
    if (!button) return { error: 'нет кнопки сжатия' };
    button.click();
    await new Promise((r) => setTimeout(r, 2500));
    const thread = document.querySelector('.chat-thread');
    return {
      text: thread?.textContent ?? '',
      note: document.querySelector('.thread-summary-head')?.textContent ?? null,
    };
  })()`);

  check('кнопка сжатия нашлась и нажалась', !before.error, before.error);
  check(
    'сжатие не стёрло переписку',
    String(before.text ?? '').includes('ПЕРВЫЙ-ОТВЕТ') && String(before.text ?? '').includes('ВТОРОЙ-ОТВЕТ'),
    before.text?.slice(0, 120),
  );
  check('отметка о сжатии появилась', (before.note ?? '').includes('сжат'), before.note);

  server.close();
  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] сжатие контекста: есть расхождения' : '[проба] сжатие не стирает переписку');
  app.exit(failed ? 1 : 0);
});
