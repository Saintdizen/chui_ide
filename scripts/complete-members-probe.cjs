/**
 * Проба: члены МНОГОУРОВНЕВОГО вложения (`self.browser.driver.`) и что бывает при
 * рассинхроне документа.
 *
 * Случай с экрана: человек набирает `self.browser.dri`, а попап подсовывает
 * `BaseWebDriver · класс` — имя КЛАССА вместо членов драйвера. Проба отвечает, откуда
 * это берётся, и стережёт обе половины починки:
 *
 *   1. при синхронном тексте сервер членов даёт — многоуровневое вложение ему по силам;
 *   2. на неполном имени (`dri`) сервер ФИЛЬТРУЕТ список сам и лишнего не шлёт —
 *      значит мусор приходит не «от жадности сервера», а с чужого места;
 *   3. запрос в строку аннотации типа возвращает объект, а НЕ класс: члены приходят,
 *      только когда позиция и текст сервера совпадают.
 *
 *   npm run probe:members
 *   ./node_modules/.bin/electron scripts/complete-members-probe.cjs
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectLspSources } = require('../dist/main/lsp/detect.js');

const ROOT = process.argv[2] || process.cwd();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Иерархия как в жизни: базовый драйвер, наследник, страница с полем-драйвером. */
const SOURCE = [
  'class WebDriver:',
  '    def find_elements_by_xpath(self, xpath: str) -> list:',
  '        return []',
  '',
  '    def get(self, url: str) -> None:',
  '        pass',
  '',
  '',
  'class BaseWebDriver(WebDriver):',
  '    driver = WebDriver()',
  '',
  '    def quit(self) -> None:',
  '        pass',
  '',
  '',
  'class BasePage:',
  '    def __init__(self, browser: BaseWebDriver) -> None:',
  '        self.browser = browser',
  '',
  '    def get_links(self, browser: BaseWebDriver, xpath: str) -> list:',
  '        links = []',
  '        self.browser.dri',
  '        return links',
  '',
].join('\n');

app.whenReady().then(async () => {
  const sources = (await detectLspSources(ROOT, process.platform)).flat().filter((s) => s.language === 'python');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-members-'));
  const file = path.join(dir, 'page.py');
  await fs.writeFile(file, SOURCE, 'utf8');

  const lsp = new LspService(
    () => dir,
    () => ({ enabled: true, servers: sources }),
    () => undefined,
    () => null,
    async () => ({}),
    async (language) => sources.filter((s) => s.language === language),
  );

  await lsp.open(file, 'python', SOURCE);
  // Сервер поднимается и разбирает файл: без паузы первые ответы пустые.
  await wait(10000);

  /** Запрос в позицию: строку и столбец ищем ПО ТЕКСТУ, а не считаем руками. */
  const ask = async (marker, extraLines = 0, extraChars = 0) => {
    const lines = SOURCE.split('\n');
    const line = lines.findIndex((text) => text.includes(marker));
    const result = await lsp.request(file, 'textDocument/completion', {
      textDocument: { uri: pathToFileURL(file).toString() },
      position: {
        line: line + extraLines,
        character: lines[line].indexOf(marker) + marker.length + extraChars,
      },
    });
    return Array.isArray(result) ? result : (result && result.items) || [];
  };

  const failures = [];
  const ok = (label, condition, extra = '') => {
    console.log(`  ${condition ? 'ok  ' : 'ПЛОХО'} ${label}${extra ? `: ${extra}` : ''}`);
    if (!condition) failures.push(label);
  };
  const names = (items) => items.map((entry) => entry.label);

  console.log('\n[1] текст синхронен: self.browser. — члены драйвера');
  const members = await ask('self.browser.');
  ok('сервер отдал членов типа поля', names(members).includes('driver'), `${members.length} шт.`);
  ok('членов чужого класса нет', !names(members).includes('get_links'), names(members).slice(0, 6).join(', '));

  console.log('\n[2] текст синхронен: неполное имя self.browser.dri');
  const partial = await ask('self.browser.dri');
  ok(
    'сервер фильтрует сам — лишнего не присылает',
    partial.length === 0 || names(partial).every((name) => name.toLowerCase().startsWith('dri')),
    `${partial.length} шт.: ${names(partial).slice(0, 6).join(', ')}`,
  );

  console.log('\n[3] ответ приходит с того места, куда спросили — по совпадению текста и позиции');
  // Позиция в аннотации типа — это область, где честный ответ сервера и есть КЛАСС.
  // Ровно так выглядит подсказка на экране, когда правка не доехала и позиция уехала.
  const annotation = await ask(': BaseWebDriver', 0, 0);
  ok(
    'в аннотации типа сервер называет класс, а не члены',
    names(annotation).length > 0 && !names(annotation).includes('driver'),
    names(annotation).slice(0, 4).join(', ') || 'пусто',
  );

  lsp.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failures.length === 0 ? '\n[chui] члены по типу приёмника работают' : `\n[chui] ошибок: ${failures.length}`,
  );
  app.exit(failures.length === 0 ? 0 : 1);
});
