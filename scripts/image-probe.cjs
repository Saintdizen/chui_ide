/**
 * Проба вьюера изображений: открываем картинки РАЗНЫХ форматов в настоящем окне IDE.
 *
 *   npx electron scripts/image-probe.cjs
 *
 * Картинки пробник делает сам: оттенки рисует `canvas` в скрытом окне (png, jpeg,
 * webp), svg пишет текстом, gif берёт готовым, bmp собирает байтами. Так в
 * репозиторий не тащим двоичные образцы, а проба не зависит от картинок под рукой.
 *
 * Для каждого формата проба открывает файл двойным кликом по дереву, читает
 * состояние вьюера (виден ли он, что в шапке, какой размер у картинки) и кладёт
 * снимок — `.chui_ide/probe-shots/image-<формат>.png`.
 */
const { app, BrowserWindow } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

const PROJECT = path.join(__dirname, '..');
const SHOTS = path.join(PROJECT, '.chui_ide', 'probe-shots');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

registerAppScheme();

// Проба сама решает, когда выходить: вспомогательное окно для рисования образцов
// закрывается раньше окна IDE, а Electron без окон завершает приложение.
app.on('window-all-closed', () => {});

/** 1×1 gif: самый короткий настоящий GIF, чтобы не держать образец файлом. */
const GIF_BASE64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

/** 24-битный BMP без сжатия: формат простой, собираем байтами. */
function encodeBmp(width, height, [r, g, b]) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixels = rowSize * height;
  const buffer = Buffer.alloc(54 + pixels);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(54 + pixels, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixels, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
  return buffer;
}

/** Нарисовать образцы canvas'ом и вернуть data-URL по форматам. */
async function drawSamples() {
  const win = new BrowserWindow({ show: false, width: 300, height: 200 });
  await win.loadURL('about:blank');
  const dataUrls = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 240, 160);
    grad.addColorStop(0, '#0a63e6');
    grad.addColorStop(1, '#30d158');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 240, 160);
    ctx.strokeStyle = '#ffd600';
    ctx.lineWidth = 6;
    ctx.strokeRect(12, 12, 216, 136);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 30px sans-serif';
    ctx.fillText('chui', 22, 92);
    // Квадрат для avif/tiff-подобных проверок размера.
    const square = document.createElement('canvas');
    square.width = 96;
    square.height = 96;
    const sctx = square.getContext('2d');
    sctx.fillStyle = '#db34f2';
    sctx.fillRect(0, 0, 96, 96);
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(24, 24, 48, 48);
    return {
      png: canvas.toDataURL('image/png'),
      jpeg: canvas.toDataURL('image/jpeg', 0.9),
      webp: canvas.toDataURL('image/webp'),
      avif: square.toDataURL('image/avif'),
    };
  })()`);
  win.destroy();
  return dataUrls;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect width="240" height="160" fill="#27272c"/>
  <circle cx="120" cy="80" r="52" fill="#0091ff"/>
  <text x="120" y="92" font-family="sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">SVG</text>
</svg>
`;

/** Минимальный ICO со встроенным PNG: 6 байт шапки + 16 байт каталога + сам PNG. */
function encodeIco(png, width, height) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // тип: значок
  header.writeUInt16LE(1, 4); // одна картинка
  header.writeUInt8(width > 255 ? 0 : width, 6);
  header.writeUInt8(height > 255 ? 0 : height, 7);
  header.writeUInt8(0, 8); // цветов в палитре нет
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // бит на пиксель
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // смещение картинки
  return Buffer.concat([header, png]);
}

/** Записать образцы в проект. */
async function writeSamples(dir) {
  const dataUrls = await drawSamples();
  const bytesOf = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

  const png = bytesOf(dataUrls.png);
  await fs.writeFile(path.join(dir, 'sample.png'), png);
  // JFIF — тот же JPEG, APNG — тот же PNG: другой ярлык, те же байты.
  await fs.writeFile(path.join(dir, 'sample.jfif'), bytesOf(dataUrls.jpeg));
  await fs.writeFile(path.join(dir, 'sample.apng'), png);
  await fs.writeFile(path.join(dir, 'sample.jpeg'), bytesOf(dataUrls.jpeg));
  await fs.writeFile(path.join(dir, 'sample.webp'), bytesOf(dataUrls.webp));
  await fs.writeFile(path.join(dir, 'sample.svg'), SVG, 'utf8');
  await fs.writeFile(path.join(dir, 'sample.gif'), Buffer.from(GIF_BASE64, 'base64'));
  await fs.writeFile(path.join(dir, 'sample.bmp'), encodeBmp(120, 80, [0x30, 0xd1, 0x58]));
  await fs.writeFile(path.join(dir, 'sample.ico'), encodeIco(png, 240, 160));
  // Форматы, которые движок НЕ рисует: байты не важны — вьюер даже не пробует
  // декодировать, а сразу показывает заглушку.
  await fs.writeFile(path.join(dir, 'sample.tiff'), png);
  await fs.writeFile(path.join(dir, 'sample.heic'), png);
  // А это проверка обратного случая: расширение обещает PNG, а в файле мусор —
  // вьюер обязан поймать ошибку декодирования и тоже показать заглушку.
  await fs.writeFile(path.join(dir, 'broken.png'), Buffer.from('не картинка, а текст\n', 'utf8'));
  await fs.writeFile(path.join(dir, 'note.txt'), 'обычный текст рядом\n', 'utf8');

  const written = [];
  // avif добавляем только если движок его кодирует (иначе data-URL окажется png'ом).
  if (dataUrls.avif.startsWith('data:image/avif')) {
    await fs.writeFile(path.join(dir, 'sample.avif'), bytesOf(dataUrls.avif));
    written.push('sample.avif');
  }
  return written;
}

const ask = (win, expression, timeoutMs = 30000) =>
  Promise.race([
    win.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Открыть файл двойным кликом по строке дерева (как это делает человек). */
const openFile = (win, name) =>
  ask(
    win,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет строки';
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return 'открыт';
    })()`,
  );

const STATE = `(() => {
  const view = document.querySelector('.image-view');
  const img = document.querySelector('.image-picture');
  const island = document.querySelector('.editor-island');
  return {
    вьюер: view ? !view.hidden : false,
    полотно: island ? island.classList.contains('is-image') : false,
    заголовок: document.querySelector('.image-title')?.textContent ?? null,
    подпись: document.querySelector('.image-meta')?.textContent ?? null,
    ширина: img?.naturalWidth ?? 0,
    высота: img?.naturalHeight ?? 0,
    вкладка: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
    режим: document.querySelector('.image-zoom-label')?.textContent ?? null,
    заглушка: document.querySelector('.image-placeholder-title')?.textContent ?? null,
    пояснение: document.querySelector('.image-placeholder-hint')?.textContent ?? null,
  };
})()`;

app.whenReady().then(async () => {
  step('старт');
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-image-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });

  const extra = await writeSamples(project);
  step('образцы записаны');
  // Случаи: что открываем и что ждём увидеть. `отрисован` — настоящая картинка,
  // `заглушка` — объяснение вместо неё (формат не по зубам движку или файл битый).
  const cases = [
    ['sample.png', 'отрисован'],
    ['sample.jpeg', 'отрисован'],
    ['sample.jfif', 'отрисован'],
    ['sample.webp', 'отрисован'],
    ['sample.svg', 'отрисован'],
    ['sample.gif', 'отрисован'],
    ['sample.bmp', 'отрисован'],
    ['sample.ico', 'отрисован'],
    ['sample.apng', 'отрисован'],
    ...extra.map((name) => [name, 'отрисован']),
    ['sample.tiff', 'заглушка'],
    ['sample.heic', 'заглушка'],
    ['broken.png', 'заглушка'],
  ];
  step(`образцы: ${cases.map(([name]) => name).join(', ')}`);

  serveRenderer();

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(3500);

  const rows = [];
  let failed = 0;
  for (const [name, expected] of cases) {
    step(`открываем ${name}`);
    await openFile(ide, name);
    await ide.webContents
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
      .catch(() => undefined);
    const state = await ask(ide, STATE);
    const shot = await ide.capturePage();
    await fs.writeFile(path.join(SHOTS, `image-${name.replace(/\./g, '-')}.png`), shot.toPNG());
    // Отрисованный — значит вьюер виден и картинка получила настоящие размеры;
    // заглушка — значит вместо картинки объяснение, а размеров нет.
    const rendered = state.вьюер === true && state.ширина > 0 && !state.заглушка;
    const placeholder = state.вьюер === true && state.ширина === 0 && Boolean(state.заглушка);
    const ok = expected === 'отрисован' ? rendered : placeholder;
    if (!ok) failed += 1;
    rows.push({ name, expected, ok, ...state });
  }

  // Возврат к тексту: вьюер обязан уступить место редактору.
  await openFile(ide, 'note.txt');
  const backToText = await ask(ide, STATE);

  console.log('\nфайл             ждали       вышло    размер      подпись                 режим   заглушка');
  for (const row of rows) {
    const verdict = row.ok ? (row.expected === 'отрисован' ? 'картинка' : 'заглушка') : 'НЕ ТАК';
    console.log(
      `${String(row.name).padEnd(16)} ${String(row.expected).padEnd(11)} ${verdict.padEnd(8)} ` +
        `${`${row.ширина}×${row.высота}`.padEnd(11)} ${String(row.подпись).padEnd(23)} ` +
        `${String(row.режим ?? '—').padEnd(7)} ${row.заглушка ?? '—'}`,
    );
  }
  console.log(`\nвсего случаев: ${rows.length}, не сошлось: ${failed}`);
  console.log(`после возврата к тексту: ${JSON.stringify(backToText)}`);
  console.log(`Снимки: ${SHOTS}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
