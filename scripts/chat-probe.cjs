/**
 * Замер ленты беседы на большой истории — то, без чего нельзя брать 113.
 *
 * Вопрос простой: сколько узлов реально висит в DOM при 2000 сообщениях и
 * сколько времени уходит на один кадр стрима. Лента режет ходы (`VISIBLE_TURNS`),
 * но прячет их через `data-hidden`, а не выбрасывает: скрытый ход всё равно
 * построен целиком (карточки инструментов и разметка ответа — тоже). Значит
 * потолок в 20 ходов экономит пиксели, а не память, и это надо измерить, а не
 * предполагать.
 *
 * Числа печатаются, но не валят прогон: это замер, а не проверка. Падает он
 * только тогда, когда окно не поднялось или беседа не отрисовалась — иначе
 * молчаливые нули сошли бы за «всё хорошо».
 *
 * Запуск: npm run probe:chatload
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { ChatStore } = require('../dist/main/ai/chat-store.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  const line = `  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`;
  // Вывод бывает закрыт раньше времени: `| head`, закрытый терминал или пайп,
  // у которого пропал читатель, — это EPIPE. Печатать некуда, но замеры идут
  // дальше: валить прогон из-за этого значит спрятать настоящие числа.
  try {
    console.log(line);
  } catch {
    /* здесь писать некуда; итог всё равно вернёт код выхода */
  }
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 60000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

// Размер истории, на котором меряем. Верхняя граница — не наша воля:
// `MAX_MESSAGES = 200` в `shared/chat-sanitize.ts` не пустит в файл больше,
// и всё, что сверху, отрежется при сохранении. Пишем потолок и ещё сверх
// него — замер должен это заметить, а не делать вид, что история больше.
const MESSAGES = 2400;
const MESSAGE_LIMIT = 200;

function history() {
  const messages = [];
  // Ответ делаем не одной строкой: карточки, разметка и код — это тоже узлы,
  // и мерить «пустые» сообщения значит занизить цену хода.
  const body = (i) =>
    [`Ответ номер ${i}.`, '', '- первый пункт', '- второй пункт', '', '```\nconst answer = ' + i + ';\n```'].join('\n');
  for (let i = 0; i < MESSAGES / 2; i += 1) {
    messages.push({ role: 'user', content: `Вопрос номер ${i}` });
    messages.push({ role: 'assistant', content: body(i) });
  }
  return [{ uid: 'chat_probe_big', title: 'Большая беседа', updatedAt: Date.now(), messages }];
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-chat-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  // Стрим нужен только чтобы померить кадр: много дельт подряд, как в живом
  // ответе. Провайдера у пробы нет, поэтому ответ подменён.
  ai.chat = async (_request, emit) => {
    const chunk = 'слово '.repeat(40);
    for (let i = 0; i < 60; i += 1) {
      emit('delta', { text: chunk });
      await wait(4);
    }
    return {
      text: chunk,
      agentMessages: [{ role: 'assistant', content: chunk }],
      trace: { steps: 1, toolCalls: 0, usage: {} },
    };
  };
  ai.suggestTitle = async () => ({ title: 'Большая беседа' });
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  // Беседы пишем в свой каталог: замер не трогает настоящий userData.
  // `activeUid` ставим сразу: панель откроет эту беседу без клика по списку,
  // а список бесед в UI рисуется поиском (`chat-search-item`) — лезть туда
  // ради замера незачем.
  const chatStore = new ChatStore(path.join(dir, 'chats'));
  const conversation = history();
  await chatStore.save(project, { conversations: conversation, activeUid: conversation[0].uid });
  const host = new HostClient();
  registerIpc({ settings, workspace, ai, terminals, git, chatStore, host });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Лента должна сама поднять большую беседу из `activeUid`.
  // Даём ей достроиться: 2000 сообщений — это тысячи узлов.
  await wait(6000);
  const opened = await ask(ide, `(() => document.querySelector('.chat-thread') ? 'ok' : 'нет .chat-thread')()`);
  check('лента открылась', opened === 'ok', opened);

  // Замер 1: сколько узлов в ленте. Сравниваем с числом сообщений — разница
  // и есть «цена» скрытых ходов: они в DOM, хотя их не видно.
  const nodes = await ask(
    ide,
    `(() => {
      const thread = document.querySelector('.chat-thread');
      if (!thread) return { error: 'нет .chat-thread' };
      return {
        all: thread.querySelectorAll('*').length,
        messages: thread.querySelectorAll('.msg').length,
        turns: thread.querySelectorAll('.chat-turn').length,
        hiddenTurns: thread.querySelectorAll('.chat-turn[data-hidden="true"]').length,
        cards: thread.querySelectorAll('.tool-card').length,
      };
    })()`,
  );
  check('лента найдена и отрисована', nodes && !nodes.error && nodes.messages > 0, nodes);
  if (nodes && !nodes.error) {
    console.log(`  узлов в DOM: ${nodes.all}`);
    console.log(`  сообщений: ${nodes.messages}, ходов: ${nodes.turns}, спрятано: ${nodes.hiddenTurns}`);
    console.log(`  узлов на сообщение: ${(nodes.all / nodes.messages).toFixed(1)}`);
    // Главный вывод замера: больше `MAX_MESSAGES` в ленте не бывает никогда,
    // что бы мы туда ни записали. Если это перестанет быть правдой, цифры
    // станут другими — и тогда 113 снова имеет смысл.
    const hitsLimit = nodes.messages === MESSAGE_LIMIT || nodes.messages === MESSAGE_LIMIT * 2;
    console.log(
      `  потолок истории: ${MESSAGE_LIMIT} сообщений — ${hitsLimit ? 'сработал' : 'НЕ сработал (проверь MAX_MESSAGES)'}`,
    );
  }

  // Замер 2: время кадра/прокрутки при такой ленте. Прокрутка — честнее кадра:
  // layout ленты пересчитывается на каждый сдвиг, и это то, что человек чувствует.
  const scroll = await ask(
    ide,
    `(async () => {
      const thread = document.querySelector('.chat-thread');
      if (!thread) return { error: 'нет .chat-thread' };
      const before = thread.scrollTop;
      const t0 = performance.now();
      for (let i = 0; i < 20; i += 1) {
        thread.scrollTop = before - i * 40;
        thread.getBoundingClientRect();
      }
      const scrollMs = performance.now() - t0;
      const frame = await new Promise((resolve) => {
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      });
      return { scrollMs, frameMs: Math.round(frame * 100) / 100 };
    })()`,
  );
  check('прокрутка измерена', scroll && !scroll.error, scroll);
  if (scroll && !scroll.error) {
    console.log(`  20 сдвигов ленты: ${scroll.scrollMs.toFixed(1)} мс`);
    console.log(`  кадр: ${scroll.frameMs} мс`);
  }

  // Замер 3: открытие беседы — главное, что страдает от большой истории.
  // Списка бесед в этом окне нет (он живёт в поиске, `chat-search-item`), поэтому
  // честный путь — перезагрузить окно: беседа снова поднимется из `activeUid`,
  // и это тот же путь, каким её видит человек после перезапуска IDE.
  const reopenStart = Date.now();
  await ide.webContents.executeJavaScript('location.reload()');
  let openMs = -1;
  for (let i = 0; i < 600; i += 1) {
    await wait(50);
    const ready = await ask(
      ide,
      `(() => { const t = document.querySelector('.chat-thread'); return t ? t.querySelectorAll('.msg').length : 0; })()`,
    );
    if (typeof ready === 'number' && ready > 0) {
      openMs = Date.now() - reopenStart;
      break;
    }
  }
  const reopening = { openMs };
  check('открытие беседы измерено', openMs >= 0, reopening);
  if (openMs >= 0) console.log(`  открытие беседы: ${openMs} мс`);

  // Снимок — не для красоты: по нему видно, что лента действительно на 2000
  // сообщениях, а не на пяти, и что спрятанные ходы не поехали.
  const SHOTS = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
  await fs.mkdir(SHOTS, { recursive: true });
  const image = await ide.capturePage();
  await fs.writeFile(path.join(SHOTS, 'chat-probe-big.png'), image.toPNG());

  console.log(failed ? 'ИТОГ: прогон не удался' : 'ИТОГ: замер снят');
  app.exit(failed ? 1 : 0);
});
