/**
 * Проверка прокси из окружения на настоящем прокси-заглушке.
 *
 *   npm run smoke:proxy
 *
 * Поднимаем два сервера: «прокси» — он пересылает запрос дальше и записывает,
 * что через него прошли, и «сайт», который просто отвечает. Дальше `netFetch` из
 * main показывает: запрос ушёл через прокси, локальный адрес прошёл мимо,
 * NO_PROXY действует, SOCKS отвергнут словами.
 *
 * Нужен собранный main (npm run build:main). Электрон не нужен.
 */
const http = require('node:http');
const { installProxyFromEnv, netFetch } = require('../dist/main/net/proxy.js');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Поднять сервер на случайном порту и дождаться адреса. */
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const main = async () => {
  const site = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`сайт ответил на ${request.url}`);
  });
  const siteUrl = await listen(site);

  /** Прокси: отвечает сам и запоминает адрес, который у него попросили. */
  const seen = [];
  const proxy = http.createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`прокси ответил на ${request.url}`);
  });
  const proxyUrl = await listen(proxy);

  /* 1. без переменных — напрямую */
  installProxyFromEnv({});
  const direct = await netFetch(`${siteUrl}/direct`);
  const directText = await direct.text();
  check('без прокси запрос идёт напрямую', directText.includes('/direct'), directText);
  check('прокси при этом не тронут', seen.length === 0, seen);

  /* 2. с HTTP_PROXY — через прокси (адрес берём не локальный: loopback идёт мимо) */
  installProxyFromEnv({ HTTP_PROXY: proxyUrl });
  const viaProxy = await netFetch('http://example.invalid/through-proxy');
  const viaText = await viaProxy.text();
  check(
    'запрос ушёл через прокси',
    seen.length === 1 && String(seen[0]).includes('example.invalid/through-proxy'),
    seen,
  );
  check('ответ пришёл от прокси', viaText.includes('прокси ответил'), viaText);

  /* 3. loopback — мимо прокси, даже когда он задан */
  const before = seen.length;
  const local = await netFetch(`${siteUrl}/local`);
  const localText = await local.text();
  check('локальный адрес прошёл мимо прокси', localText.includes('/local') && seen.length === before, {
    seenBefore: before,
    seenAfter: seen.length,
  });

  /* 4. SOCKS — понятный отказ, а не молчаливое «напрямую» */
  installProxyFromEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
  let socksError = '';
  try {
    await netFetch('http://example.invalid/x');
  } catch (error) {
    socksError = error instanceof Error ? error.message : String(error);
  }
  check('SOCKS отвергнут словами', socksError.includes('SOCKS'), socksError);

  installProxyFromEnv({});
  proxy.close();
  site.close();
  console.log(failed ? '[прокси] есть расхождения' : '[прокси] переменные окружения работают');
  process.exit(failed ? 1 : 0);
};

void main();
