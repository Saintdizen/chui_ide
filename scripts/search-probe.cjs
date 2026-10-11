/**
 * Проба поиска по проекту: одинаковый ли результат дают ripgrep и собственный обход.
 *
 *   ./node_modules/.bin/electron scripts/search-probe.cjs
 *
 * Окно здесь не нужно: проверяем сам сервис. Смысл пробы в том, что путь поиска —
 * деталь: панель и агент должны получать одно и то же, есть ли в системе ripgrep
 * или нет. Если ripgrep не установлен, проба честно скажет об этом и покажет
 * результат собственного обхода — то, что работает в любом случае.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { isOnPath } = require('../dist/main/lsp/detect.js');

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-search-probe-'));
  const project = path.join(dir, 'demo-project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(
    path.join(project, 'src', 'a.ts'),
    ['const needle = 1;', '// needle в комментарии', 'const other = 2;'].join('\n') + '\n',
    'utf8',
  );
  await fs.writeFile(path.join(project, 'src', 'b.py'), 'needle = "строка"\n', 'utf8');
  // Служебный каталог: в поиск попадать не должен — как и у ripgrep.
  await fs.writeFile(path.join(project, 'node_modules', 'pkg', 'index.js'), 'needle\n', 'utf8');

  const workspace = new WorkspaceService(() => undefined);
  await workspace.open(project);

  const rg = await isOnPath('rg');
  console.log(`[проба] ripgrep в системе: ${rg ? 'есть' : 'нет — работает собственный обход'}`);

  for (const options of [
    { query: 'needle' },
    { query: 'needle', caseSensitive: true },
    { query: 'NEEDLE' },
    { query: 'needle', filesOnly: true },
    { query: 'const\\s+needle', isRegex: true },
    { query: 'needle', glob: '*.py' },
    { query: 'needle', context: 1 },
  ]) {
    const result = await workspace.search(options);
    const label = JSON.stringify(options);
    const hits = result.hits.map((hit) => `${path.relative(project, hit.path)}:${hit.line}:${hit.column}`).join(' ');
    console.log(`[проба] ${label} → ${hits || '(пусто)'}`);
  }

  // Служебные каталоги в результат попадать не должны ни одним путём.
  const all = await workspace.search({ query: 'needle' });
  const leaked = all.hits.filter((hit) => hit.path.includes('node_modules'));
  console.log(`[проба] совпадений из node_modules: ${leaked.length}`);

  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
