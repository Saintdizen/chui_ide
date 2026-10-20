/**
 * Проба предпросмотра документов Office (.docx, .xlsx).
 *
 *   npm run probe:office
 *
 * Чего не видно юнит-тестами: там нет ни окна, ни дерева, ни вкладок. Проверяем:
 *
 *  1. двойной клик по .docx открывает вкладку, а полотно уступает экрану документа;
 *  2. в теле есть заголовок, абзац и таблица из файла — то есть main распаковал
 *     архив и разобрал XML, а не показал бинарь;
 *  3. в статусбаре у документа формат (DOCX), а не «plaintext»;
 *  4. у книги .xlsx есть переключатель листов, и нажатие показывает другой лист;
 *  5. обычный файл после этого открывается текстом — экран документа уступил.
 *
 * Снимок — `.chui_ide/probe-shots/office-preview.png`.
 * Нужен собранный код: `npm run build` (скрипт делает это сам).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
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

registerAppScheme();
app.on('window-all-closed', () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const ask = (win, expression, timeoutMs = 20000) =>
  Promise.race([
    win.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Собрать zip так, как его пишет Office: локальные записи, оглавление, EOCD. */
function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const DOCX = {
  'word/document.xml': `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Договор поставки</w:t></w:r></w:p>
    <w:p><w:r><w:t>Поставщик обязуется передать товар.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Товар</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Молоко</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>80</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body></w:document>`,
};

const XLSX = {
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="Товары" r:id="rId1"/><sheet name="Итоги" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Молоко</t></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>80</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Итого</t></is></c><c r="B1"><v>80</v></c></row></sheetData></worksheet>',
};

/** Что видно на экране: экран документа, его содержимое, листы и формат в статусбаре. */
const STATE = `(() => {
  const island = document.querySelector('.editor-island');
  const view = document.querySelector('.doc-view');
  return {
    вДокументе: island ? island.classList.contains('is-doc') : null,
    документВиден: view ? !view.hidden : false,
    заголовок: document.querySelector('.doc-title')?.textContent ?? null,
    заголовки: [...document.querySelectorAll('.doc-heading')].map((node) => node.textContent),
    абзацы: [...document.querySelectorAll('.doc-paragraph')].map((node) => node.textContent),
    строки: document.querySelectorAll('.doc-table tr').length,
    ячейки: [...document.querySelectorAll('.doc-cell')].map((node) => node.textContent),
    листы: [...document.querySelectorAll('.doc-sheet')].map((node) => node.textContent),
    активныйЛист: document.querySelector('.doc-sheet.is-active')?.textContent ?? null,
    статусы: [...document.querySelectorAll('.status-item')].map((node) => node.textContent),
  };
})()`;

const openFile = (win, name) =>
  ask(
    win,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет строки';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return 'открыт';
    })()`,
  );

const clickSheet = (win, name) =>
  ask(
    win,
    `(() => {
      const button = [...document.querySelectorAll('.doc-sheet')].find(
        (item) => item.textContent === ${JSON.stringify(name)},
      );
      if (!button) return 'нет кнопки';
      button.click();
      return 'нажата';
    })()`,
  );

app.whenReady().then(async () => {
  step('старт');
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-office-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'Договор.docx'), zipOf(DOCX));
  await fs.writeFile(path.join(project, 'Отчёт.xlsx'), zipOf(XLSX));
  await fs.writeFile(path.join(project, 'note.txt'), 'обычный текст\n', 'utf8');

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
  await wait(6000);

  step('открываю Договор.docx');
  const opened = await openFile(ide, 'Договор.docx');
  check('документ открыт', opened === 'открыт', opened);
  const doc = await ask(ide, STATE);
  check('полотно уступило экрану документа', doc.вДокументе === true && doc.документВиден === true, doc);
  check('в шапке имя файла', doc.заголовок === 'Договор.docx', doc.заголовок);
  check('заголовок из файла на месте', doc.заголовки.includes('Договор поставки'), doc.заголовки);
  check(
    'абзац прочитан',
    (doc.абзацы ?? []).some((line) => line.includes('Поставщик')),
    doc.абзацы,
  );
  check('таблица собрана', doc.строки === 2 && (doc.ячейки ?? []).includes('Молоко'), doc.ячейки);
  check('в статусбаре формат DOCX', (doc.статусы ?? []).includes('DOCX'), doc.статусы);

  step('открываю Отчёт.xlsx');
  check('книга открыта', (await openFile(ide, 'Отчёт.xlsx')) === 'открыт');
  const book = await ask(ide, STATE);
  check('листы видны кнопками', JSON.stringify(book.листы) === JSON.stringify(['Товары', 'Итоги']), book.листы);
  check('показан первый лист', book.активныйЛист === 'Товары', book.активныйЛист);
  check('ячейки первого листа', (book.ячейки ?? []).includes('Молоко'), book.ячейки);

  step('переключаю лист');
  check('кнопка листа нажата', (await clickSheet(ide, 'Итоги')) === 'нажата');
  await wait(400);
  const second = await ask(ide, STATE);
  check('показан второй лист', (second.ячейки ?? []).includes('Итого'), second.ячейки);

  const shot = await ide.capturePage();
  await fs.writeFile(path.join(SHOTS, 'office-preview.png'), shot.toPNG());

  step('обычный файл после документа');
  await openFile(ide, 'note.txt');
  await wait(400);
  const plain = await ask(ide, STATE);
  check('экран документа уступил', plain.вДокументе === false && plain.документВиден === false, plain);

  console.log(failed === 0 ? '\nпредпросмотр документов Office работает' : `\nпровалов: ${failed}`);
  console.log(`Снимок: ${path.join(SHOTS, 'office-preview.png')}`);
  app.exit(failed === 0 ? 0 : 1);
});
