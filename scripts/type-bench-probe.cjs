/**
 * Замер: сколько стоит нажатие в редакторе на большом файле.
 *
 *   node scripts/type-bench-probe.cjs
 *
 * Юнит-тесты проверяют арифметику раскладки, но не отвечают на вопрос
 * «печатать не тормозит ли». Здесь поднимается настоящее окно IDE и
 * замеряется время от нажатия до кадра.
 *
 * Меры:
 * 1. Открытие документа — до первой отрисовки строк.
 * 2. Ввод символа в середине файла — каретка, декорации, разметка.
 * 3. Enter и Backspace — пересборка раскладки.
 * 4. Прокрутка — виртуализация (в DOM только видимые строки).
 *
 * Отчёт — в stdout и в `.chui_ide/probe-type-bench.txt`.
 */
const { app } = require('electron');
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

registerAppScheme();

const PROJECT = path.join(__dirname, '..');
const REPORT = path.join(PROJECT, '.chui_ide', 'probe-type-bench.txt');
const LINES = 10000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bigSource(lines) {
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    const mod = i % 5;
    if (mod === 0) out.push(`export function handler${i}(input: string): number {`);
    else if (mod === 1) out.push(`  const value${i} = input.length + ${i};`);
    else if (mod === 2) out.push(`  if (value${i} > ${i * 3}) return value${i};`);
    else if (mod === 3) out.push(`  // шаг ${i}: обычный комментарий для раскладки`);
    else out.push(`  return ${i};`);
  }
  return out.join('\n') + '\n';
}

const ask = (w, expression, t = 30000) =>
  Promise.race([w.webContents.executeJavaScript(expression), wait(t).then(() => null)]);

function stats(values) {
  if (!values.length) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(1),
    med: +at(0.5).toFixed(1),
    p90: +at(0.9).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
  };
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-type-bench-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'big.ts'), bigSource(LINES), 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((t, p) => pushToRenderers(t, p));
  const git = new GitService(
    () => workspace.rootPath(),
    (t, p) => pushToRenderers(t, p),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((t, p) => pushToRenderers(t, p));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  const report = [`Замер ввода: файл ${LINES} строк`, ''];

  const tOpen = Date.now();
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'big.ts');
      if (!row) return 'нет узла';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'открыт';
    })()`,
  );
  let domLines = 0;
  for (let i = 0; i < 100; i += 1) {
    await wait(100);
    const n = await ask(ide, `document.querySelectorAll('.own-editor-line').length`);
    if (typeof n === 'number' && n > 0) {
      domLines = n;
      break;
    }
  }
  report.push(`Открытие до первой отрисовки: ${Date.now() - tOpen} мс`);
  const virtualOk = domLines > 0 && domLines < LINES / 4;
  report.push(`Строк в DOM: ${domLines} из ${LINES} — виртуализация ${virtualOk ? 'работает' : 'ПОД ВОПРОСОМ'}`);
  report.push('');

  await ask(ide, `document.querySelector('.own-editor-input')?.focus(); 'ok'`);

  const gesture = async (events, settle = 60) => {
    await ask(
      ide,
      `(() => {
        window.__t0 = performance.now();
        window.__long = 0;
        try {
          window.__obs?.disconnect();
          window.__obs = new PerformanceObserver((l) => {
            for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration);
          });
          window.__obs.observe({ entryTypes: ['longtask'] });
        } catch {}
        return 'ok';
      })()`,
    );
    for (const e of events) ide.webContents.sendInputEvent(e);
    // Ждём не фиксированное время, а кадр: два rAF подряд значат «отрисовано».
    // Фиксированный settle складывался бы в результат: при settle=40 минимум
    // выходил ровно 40.4 — мерили собственное ожидание, а не работу редактора.
    await ask(
      ide,
      `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r('кадр'))))`,
      5000,
    );
    await wait(settle > 0 && process.env.SETTLE ? settle : 0);
    return ask(
      ide,
      `(() => {
        const d = performance.now() - window.__t0;
        window.__obs?.disconnect();
        return { ms: +d.toFixed(1), long: +window.__long.toFixed(1) };
      })()`,
    );
  };

  const key = (keyCode, modifiers = []) => [
    { type: 'keyDown', keyCode, modifiers },
    { type: 'keyUp', keyCode, modifiers },
  ];

  await gesture(key('Home', ['control']), 80);
  for (let i = 0; i < 60; i += 1) await gesture(key('PageDown'), 25);

  const typeTimes = [];
  const typeLong = [];
  for (let i = 0; i < 30; i += 1) {
    const r = await gesture([{ type: 'char', keyCode: 'x' }], 40);
    if (r && typeof r.ms === 'number') {
      typeTimes.push(r.ms);
      if (r.long > 0) typeLong.push(r.long);
    }
  }
  report.push(`Ввод символа в середине (30), мс: ${JSON.stringify(stats(typeTimes))}`);
  report.push(`  длинных задач(>50мс): ${typeLong.length}${typeLong.length ? `, худшая ${Math.max(...typeLong)} мс` : ''}`);

  const lineTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const r = await gesture(key('Return'), 60);
    if (r && typeof r.ms === 'number') lineTimes.push(r.ms);
  }
  report.push(`Enter — пересборка раскладки (15), мс: ${JSON.stringify(stats(lineTimes))}`);

  const backTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const r = await gesture(key('Backspace'), 60);
    if (r && typeof r.ms === 'number') backTimes.push(r.ms);
  }
  report.push(`Backspace (15), мс: ${JSON.stringify(stats(backTimes))}`);

  const scrollTimes = [];
  for (let i = 0; i < 15; i += 1) {
    const r = await gesture(key('PageDown'), 60);
    if (r && typeof r.ms === 'number') scrollTimes.push(r.ms);
  }
  report.push(`Прокрутка PageDown (15), мс: ${JSON.stringify(stats(scrollTimes))}`);

  const decor = await ask(
    ide,
    `(() => ({
      строк_в_dom: document.querySelectorAll('.own-editor-line').length,
      подсветок: document.querySelectorAll('.own-editor-highlight-rect').length,
      декораций: document.querySelectorAll('.own-editor-decoration').length,
    }))()`,
  );
  report.push(`DOM после всех шагов: ${JSON.stringify(decor)}`);

  const errors = await ask(ide, `window.__errors ?? null`).catch(() => null);
  if (Array.isArray(errors) && errors.length) report.push(`ОШИБКИ СТРАНИЦЫ: ${JSON.stringify(errors)}`);

  const text = report.join('\n');
  console.log('\n' + text + '\n');
  await fs.mkdir(path.dirname(REPORT), { recursive: true });
  await fs.writeFile(REPORT, text + '\n', 'utf8');

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
