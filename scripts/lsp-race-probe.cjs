/**
 * Проба: правка, ушедшая серверу РАНЬШЕ его готовности, не теряется.
 *
 * Сценарий как в жизни: файл открывается, и пока сервер стартует, в нём уже есть
 * другая правка (первый `change`). Если сервер увидит СТАРЫЙ текст, диагностика
 * будет про код, которого на экране уже нет, — «подчёркнуто то, что исправлено».
 *
 *   npm run probe:lsprace
 *   ./node_modules/.bin/electron scripts/lsp-race-probe.cjs /проект контроль
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectLspSources } = require('../dist/main/lsp/detect.js');

const ROOT = process.argv[2] || process.cwd();
const MODE = process.argv[3] || 'гонка';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BAD = 'def f() -> int:\n    return "tekst"\n';
const GOOD = 'def f() -> int:\n    return 1\n';

app.whenReady().then(async () => {
  const sources = (await detectLspSources(ROOT, process.platform)).flat().filter((s) => s.language === 'python');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-race-'));
  const file = path.join(dir, 'race.py');
  await fs.writeFile(file, BAD, 'utf8');

  const seen = [];
  let latest = null;
  const lsp = new LspService(
    () => dir,
    () => ({ enabled: true, servers: sources }),
    (_topic, payload) => {
      if (!payload || payload.path !== file) return;
      latest = payload.diagnostics;
      seen.push(payload.diagnostics.length);
    },
    () => null,
    async () => ({}),
    async (language) => sources.filter((s) => s.language === language),
  );

  void lsp.open(file, 'python', BAD);
  if (MODE === 'гонка') {
    // Правка уходит, пока сервер ещё поднимается (в приложении так и бывает).
    lsp.change(file, GOOD);
  }
  await wait(20000);

  const shown = MODE === 'гонка' ? GOOD : BAD;
  const problems = latest ?? [];
  console.log(`[режим] ${MODE}`);
  console.log(`[текст на экране] ${JSON.stringify(shown)}`);
  console.log(`[публикаций] ${seen.length}, последняя: ${problems.length}`);
  for (const d of problems) console.log(`  [${d.severity}] ${d.line}:${d.column} ${d.message}`);

  const failures = [];
  const ok = (label, condition, extra = '') => {
    console.log(`  ${condition ? 'ok  ' : 'ПЛОХО'} ${label}${extra ? `: ${extra}` : ''}`);
    if (!condition) failures.push(label);
  };

  if (MODE === 'контроль') {
    // Контроль: ошибочный текст должен быть замечен — иначе проба ничего не проверяет.
    ok('сервер увидел ошибочный текст без правок', problems.length > 0, `пометок: ${problems.length}`);
  } else {
    // Гонка: правка до готовности сервера не теряется — сервер видит актуальный текст.
    ok('правка до готовности сервера не потерялась', problems.length === 0, `пометок: ${problems.length}`);
  }

  lsp.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failures.length === 0 ? '[chui] гонка открытия/правки безопасна' : `[chui] ошибок: ${failures.length}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
