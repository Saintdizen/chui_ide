/**
 * Проверка исключений обхода: `.gitignore` и `.ai_ignore`.
 *
 *   npm run smoke:ignore
 *
 * Настоящий `WorkspaceService` и настоящее дерево во временной папке. Проверяем
 * обе стороны: исключённого не видно ни в поиске, ни в списке файлов, а `!`
 * действительно возвращает файл обратно. Отдельно — счётчик прочитанных файлов:
 * исключение должно экономить работу, а не просто прятать результат.
 *
 * Нужен собранный main (npm run build:main).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
};

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ignore-'));
  const workspace = new WorkspaceService(() => undefined);

  try {
    /* Дерево: часть должна находиться, часть — исчезнуть. */
    const MARK = 'needle-marker';
    await write(path.join(dir, 'src/app.ts'), `// ${MARK}\nexport const app = 1;\n`);
    await write(path.join(dir, 'src/app.test.ts'), `// ${MARK} тест\n`);
    await write(path.join(dir, 'build/out.js'), `// ${MARK} сборка\n`);
    await write(path.join(dir, 'logs/run.log'), `${MARK} лог\n`);
    await write(path.join(dir, 'vendor/lib.js'), `// ${MARK} чужое\n`);
    await write(path.join(dir, '.gitignore'), 'build/\n*.log\nvendor/\n');
    await write(path.join(dir, '.ai_ignore'), '# свои правила\n');

    await workspace.open(dir);
    check('правила из двух файлов сложились', workspace.ignoreRuleCount() === 3, workspace.ignoreRuleCount());

    const rel = (hit) => path.relative(dir, hit.path).split(path.sep).join('/');
    const searchAll = async () => (await workspace.search({ query: MARK, maxResults: 100 })).hits;

    const hits = (await searchAll()).map(rel).sort();
    check('обычные файлы находятся', hits.includes('src/app.ts') && hits.includes('src/app.test.ts'), hits);
    check('исключённая папка не найдена', !hits.some((file) => file.startsWith('build/')), hits);
    check('исключение по маске работает', !hits.includes('logs/run.log'), hits);
    check('чужое дерево не найдено', !hits.some((file) => file.startsWith('vendor/')), hits);

    /* Список файлов: тот же обход кормит быстрый открыватель и find_files. */
    const listed = await workspace.listFiles();
    check('listFiles не показывает исключённое', !listed.some((file) => file.startsWith('build/')), listed);
    const found = await workspace.findFiles('**/*.ts');
    check(
      'findFiles не показывает исключённое',
      found.every((file) => !file.startsWith('build/')),
      found,
    );
    check('findFiles находит остальное', found.includes('src/app.ts'), found);

    /* Возврат обратно. Тут же — поведение, унаследованное от git: одним
       `!vendor/keep.js` файл не вернуть, потому что родительская папка уже
       исключена (`git check-ignore` подтверждает). Сначала возвращаем папку,
       внутри исключаем всё, потом возвращаем нужный файл. */
    await write(path.join(dir, 'vendor/keep.js'), `// ${MARK} вернули\n`);
    await write(path.join(dir, '.ai_ignore'), '!vendor/keep.js\n');
    await workspace.open(dir);
    const insideIgnoredDir = (await searchAll()).map(rel);
    check(
      'внутри исключённой папки файл вернуть нельзя (как в git)',
      !insideIgnoredDir.includes('vendor/keep.js'),
      insideIgnoredDir,
    );

    await write(path.join(dir, '.ai_ignore'), '!vendor/\nvendor/*\n!vendor/keep.js\n');
    await workspace.open(dir);
    const afterNegate = (await searchAll()).map(rel);
    check('идиома с возвратом папки возвращает файл', afterNegate.includes('vendor/keep.js'), afterNegate);
    check('остальное в той же папке остаётся исключённым', !afterNegate.includes('vendor/lib.js'), afterNegate);

    /* Правка правил на лету: файлы правил наблюдаются, правила перечитываются. */
    await write(path.join(dir, '.ai_ignore'), '!vendor/\nvendor/*\n!vendor/keep.js\nsrc/app.test.ts\n');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterEdit = (await searchAll()).map(rel);
    check('правка .ai_ignore подействовала без переоткрытия', !afterEdit.includes('src/app.test.ts'), afterEdit);

    /* Экономия: исключение обязано уменьшать работу, а не только прятать вывод.
       Папка нарочно не упомянута в `.gitignore` — иначе исключать было бы нечего
       и замер ничего не показал. */
    const bulk = path.join(dir, 'generated');
    for (let index = 0; index < 40; index += 1) {
      await write(path.join(bulk, `file${index}.txt`), `${MARK} сгенерированное ${index}\n`);
    }
    await write(path.join(dir, '.ai_ignore'), '');
    await workspace.open(dir);
    const before = (await workspace.search({ query: MARK, maxResults: 100 })).scanned;
    await write(path.join(dir, '.ai_ignore'), 'generated/\n');
    await workspace.open(dir);
    const after = (await workspace.search({ query: MARK, maxResults: 100 })).scanned;
    check('исключения уменьшают число прочитанных файлов', after < before, { было: before, стало: after });

    /* Кэш содержимого: повторный поиск по тому же дереву не перечитывает файлы.
       Счётчики накопительные, поэтому смотрим их разницу между двумя поисками. */
    await workspace.open(dir);
    await workspace.search({ query: MARK, maxResults: 100 });
    const beforeCache = workspace.cacheStats();
    await workspace.search({ query: MARK, maxResults: 100 });
    const afterCache = workspace.cacheStats();
    const readAgain = afterCache.misses - beforeCache.misses;
    const fromCache = afterCache.hits - beforeCache.hits;
    check('первый поиск наполняет кэш', beforeCache.entries > 0, beforeCache);
    check('повторный поиск не перечитывает файлы', readAgain === 0 && fromCache > 0, {
      из_кэша: fromCache,
      перечитано: readAgain,
    });
    check('в памяти держим разумный объём', afterCache.bytes < 8 * 1024 * 1024, afterCache.bytes);

    /* Главное: кэш не должен отдавать устаревший текст. */
    const changed = path.join(dir, 'src/app.ts');
    await write(changed, `// ${MARK} новая версия\n`);
    const outsideEdit = (await workspace.search({ query: `${MARK} новая версия`, maxResults: 100 })).hits.map(rel);
    check('правка файла снаружи видна поиску сразу', outsideEdit.includes('src/app.ts'), outsideEdit);

    const stale = path.join(dir, 'src/stale.ts');
    await write(stale, `// ${MARK} старое содержимое\n`);
    await workspace.search({ query: MARK, maxResults: 100 });
    await workspace.writeFile(stale, `// ${MARK} новое содержимое\n`);
    const newText = (await workspace.search({ query: `${MARK} новое содержимое`, maxResults: 100 })).hits.map(rel);
    const oldText = (await workspace.search({ query: `${MARK} старое содержимое`, maxResults: 100 })).hits.map(rel);
    check('запись через IDE сразу видна поиску', newText.includes('src/stale.ts'), newText);
    check('старое содержимое больше не находится', !oldText.includes('src/stale.ts'), oldText);

    /* Переименование: под старым путём содержимого быть не должно. */
    const moved = path.join(dir, 'src/moved.ts');
    await workspace.rename(stale, moved);
    const afterRenameOld = (await workspace.search({ query: `${MARK} новое содержимое`, maxResults: 100 })).hits.map(
      rel,
    );
    check(
      'после переименования старый путь не находится, новый — находится',
      !afterRenameOld.includes('src/stale.ts') && afterRenameOld.includes('src/moved.ts'),
      afterRenameOld,
    );
  } catch (error) {
    failed = true;
    console.error('[chui] ошибка проверки:', error.message);
  } finally {
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    console.log(failed ? '[chui] исключения обхода: есть расхождения' : '[chui] исключения обхода работают');
    app.exit(failed ? 1 : 0);
  }
});
