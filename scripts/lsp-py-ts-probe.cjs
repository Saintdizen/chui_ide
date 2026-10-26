/**
 * Проба «Python и Node по отдельности»: каждый сервер в своём сервисе.
 *
 * Зачем отдельно от `lsp-bundled-probe`: та поднимает ОДИН `LspService` на все
 * серверы и зовёт `projectSymbols('config')` — запрос по workspace. Ответ тогда
 * не разобрать: у Python, JSON, CSS, HTML и YAML он выходил 49/50 объявлений,
 * то есть число чужое у половины строк. Здесь у каждого языка свой сервис и
 * вопросы, различимые по языку:
 *
 *   • определение символа в файле — `x = 1` в py и `const x = 1` в ts. Ответ про
 *     ЧУЖОЙ язык получить нельзя, и это главное;
 *   • семантика — сколько токенов на одном и том же коде.
 *
 * Печатает состояние, а не ok/FAIL, как прочие «пробники».
 *
 *   npm run build:main && ./node_modules/.bin/electron scripts/lsp-py-ts-probe.cjs
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectBundledServers } = require('../dist/main/lsp/bundled.js');

const CASES = {
  python: {
    ext: 'py',
    text: 'value = 1\n\ndef config() -> int:\n    return value\n\nclass Settings:\n    total = config()\n',
    expected: ['config', 'Settings'],
  },
  typescript: {
    ext: 'ts',
    text: 'const value: number = 1;\n\nexport function config(): number {\n  return value;\n}\n\nexport class Settings {\n  total = config();\n}\n',
    expected: ['config', 'Settings'],
  },
  javascript: {
    ext: 'js',
    text: 'const value = 1;\n\nexport function config() {\n  return value;\n}\n\nexport class Settings {\n  total = config();\n}\n',
    expected: ['config', 'Settings'],
  },
};

async function probe(language, caseInfo, server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lsp-${language}-`));
  const file = path.join(dir, `sample.${caseInfo.ext}`);
  fs.writeFileSync(file, caseInfo.text);

  // Сервис с ОДНИМ сервером: иначе ответ соседа не отличить от своего.
  const lsp = new LspService(
    () => dir,
    () => ({ enabled: true, servers: [server] }),
    () => {},
    () => null,
    async () => ({}),
  );

  const startedAt = Date.now();
  await lsp.open(file, language, caseInfo.text).catch(() => undefined);
  const outline = await lsp.outline(file, language, caseInfo.text).catch((error) => ({ error: String(error) }));
  const upMs = Date.now() - startedAt;

  const semantic = await lsp.semanticTokens(file).catch((error) => ({ error: String(error) }));
  const status = lsp.status();
  lsp.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  return { upMs, outline, semantic, status };
}

app.whenReady().then(async () => {
  const bundled = await detectBundledServers();
  const byLang = new Map(bundled.map((server) => [server.language, server]));
  console.log(`серверов в поставке: ${bundled.length}`);

  for (const [language, caseInfo] of Object.entries(CASES)) {
    const server = byLang.get(language);
    if (!server) {
      console.log(`${language.padEnd(12)} сервера нет — пропуск`);
      continue;
    }
    // Сервис ровно с одним сервером: так ответ нельзя спутать с ответом соседа.
    const result = await probe(language, caseInfo, server);
    const names = Array.isArray(result.outline) ? result.outline.map((symbol) => symbol.name) : null;
    const found = names !== null && caseInfo.expected.every((name) => names.includes(name));
    const outlineText =
      names === null
        ? `ошибка: ${result.outline.error}`
        : `${names.length} (${names.join(', ')}), ждали ${caseInfo.expected.join(', ')}`;
    const semanticText = Array.isArray(result.semantic)
      ? `${result.semantic.length}`
      : `ошибка: ${result.semantic.error}`;
    console.log(
      `${language.padEnd(12)} ${server.label}\n` +
        `  скелет за ${result.upMs} мс: ${outlineText}  ${found ? 'OK' : 'ПЛОХО'}\n` +
        `  семантика: ${semanticText}\n` +
        `  статус: ${JSON.stringify(result.status).slice(0, 300)}`,
    );
  }
  app.quit();
});
