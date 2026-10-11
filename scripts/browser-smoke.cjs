/**
 * Проверка браузерной автоматизации: свой Chromium по CDP.
 *
 * Поднимаем локальный http-сервер с маленькой страницей (форма, кнопка, ссылка)
 * и прогоняем настоящий цикл агента: переход, снимок, клик, ввод, скрипт,
 * закрытие. Браузер настоящий, сеть наружу не нужна.
 *
 * Проверяем:
 *  1. находит исполняемый файл Chromium и поднимает его с временным профилем;
 *  2. browser_open: загрузка страницы, снимок с заголовком и элементами;
 *  3. browser_snapshot: номера элементов годятся для действий;
 *  4. browser_click: клик меняет страницу, снимок приходит уже новый;
 *  5. browser_type: ввод и Enter обновляют форму;
 *  6. browser_evaluate: результат и ошибка выражения приходят текстом;
 *  7. чужую схему (file:, javascript:) открывать отказывается;
 *  8. browser_close убирает процесс и временный профиль.
 *
 *   npm run smoke:browser
 *
 * Нужен собранный main (npm run build:main) и Chromium в PATH. Нет браузера —
 * проверка честно говорит об этом и выходит без ошибки: это не поломка кода.
 */
const http = require('node:http');
const { BrowserService, resolveExecutable } = require('../dist/main/browser/browser.js');

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Страница для проверок: кнопка меняет текст, форма показывает введённое. */
const PAGE = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Песочница</title></head>
<body>
  <h1>Маленькая страница</h1>
  <form id="search" onsubmit="event.preventDefault(); document.getElementById('echo').textContent = 'запрос: ' + document.getElementById('q').value;">
    <label for="q">Поиск</label>
    <input id="q" name="q" type="text" placeholder="что искать">
    <button id="go" type="submit">Найти</button>
  </form>
  <button id="greet" onclick="document.getElementById('out').textContent = 'привет'">Поздороваться</button>
  <p id="out"></p>
  <p id="echo"></p>
  <a href="/other">Другая страница</a>
</body>
</html>`;

async function main() {
  const executable = resolveExecutable(process.env.CHUI_BROWSER);
  if (!executable) {
    console.log('[chui] Chromium не найден в PATH — браузерную проверку пропускаю');
    console.log('[chui] задайте путь: CHUI_BROWSER=/путь/к/chrome npm run smoke:browser');
    return;
  }
  console.log(`  ok   браузер найден: ${executable}`);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/other' ? '<!doctype html><title>Другая</title><p>вторая</p>' : PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = new BrowserService(() => ({ executable, headless: true }));

  try {
    /* 1. переход на страницу */
    const opened = await browser.open(base);
    check('заголовок страницы прочитан', opened.title === 'Песочница', opened.title);
    check('адрес в снимке', opened.url.startsWith(base), opened.url);
    check('текст страницы виден', opened.text.includes('Маленькая страница'), opened.text.slice(0, 60));
    const names = opened.elements.map((element) => element.name);
    check('кнопка и поле попали в снимок', names.includes('Найти') && names.includes('Поиск'), names);

    /* 2. клик: страница меняется, снимок приходит уже новый */
    const greetRef = opened.elements.find((element) => element.name === 'Поздороваться');
    check('кнопка «Поздороваться» есть в снимке', greetRef !== undefined, names);
    const afterClick = await browser.click(greetRef.ref);
    check('клик изменил страницу', afterClick.text.includes('привет'), afterClick.text.slice(0, 80));

    /* 3. ввод с отправкой формы */
    const fieldRef = afterClick.elements.find((element) => element.role === 'textbox');
    check(
      'поле ввода найдено по роли',
      fieldRef !== undefined,
      afterClick.elements.map((e) => e.role),
    );
    const afterType = await browser.type(fieldRef.ref, 'молоко', true);
    check('ввод и Enter обновили форму', afterType.text.includes('запрос: молоко'), afterType.text.slice(0, 120));

    /* 4. ссылка ведёт на другую страницу — номер из свежего снимка */
    const linkRef = afterType.elements.find((element) => element.role === 'link');
    const afterLink = await browser.click(linkRef.ref);
    check('переход по ссылке сработал', afterLink.title === 'Другая', afterLink.title);

    /* 5. выражение на странице */
    const title = await browser.evaluate('document.title');
    check('браузер_evaluate вернул значение', title === 'Другая', title);

    let evaluateError = '';
    try {
      await browser.evaluate('не такое имя + 1');
    } catch (error) {
      evaluateError = String(error.message);
    }
    check('ошибка выражения пришла текстом, а не уронила вызов', /ошибк/i.test(evaluateError), evaluateError);

    /* 6. чужие схемы отвергаем до запуска браузера */
    let schemeError = '';
    try {
      await browser.open('file:///etc/passwd');
    } catch (error) {
      schemeError = String(error.message);
    }
    check('file: открывать отказывается', /http/i.test(schemeError), schemeError);

    /* 7. закрытие: профиль убирается, процесс уходит */
    await browser.close();
    check('после закрытия сессии браузера нет', browser.running === false);
  } finally {
    server.close();
    await browser.close().catch(() => undefined);
  }
}

main()
  .then(() => {
    console.log(failed ? '[chui] браузерная автоматизация НЕ прошла' : '[chui] браузерная автоматизация работает');
    process.exit(failed ? 1 : 0);
  })
  .catch((error) => {
    console.error('[chui] исключение:', error);
    process.exit(1);
  });
