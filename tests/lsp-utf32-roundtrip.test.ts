import { removeTemp } from './temp';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';

/**
 * п.81 в обе стороны: сервер объявил `positionEncoding: 'utf-32'`. Наши колонки —
 * `utf-16`. Фейк логирует `метод character` и отвечает Location с заданной колонкой.
 */
const services: LspService[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await removeTemp(dirs);
});

const FAKE = [
  "const { appendFileSync } = require('node:fs');",
  'const LOG = process.argv[2];',
  'const URI = process.argv[3];',
  'let buffer = Buffer.alloc(0);',
  'function send(m){const b=JSON.stringify(m);process.stdout.write("Content-Length: "+Buffer.byteLength(b)+"\\r\\n\\r\\n"+b);}',
  'function handle(m){',
  "  if(m.method==='initialize'){ send({jsonrpc:'2.0',id:m.id,result:{capabilities:{positionEncoding:'utf-32',textDocumentSync:{openClose:true,change:1},definitionProvider:true}}}); return; }",
  "  if(m.method==='textDocument/definition'){",
  "    appendFileSync(LOG,'def character='+m.params.position.character+'\\n');",
  "    return send({jsonrpc:'2.0',id:m.id,result:[{uri:URI,range:{start:{line:0,character:1},end:{line:0,character:1}}}]});",
  '  }',
  '  if(m.method){ appendFileSync(LOG,m.method+"\\n"); return; }',
  '  if(m.id!==undefined) send({jsonrpc:"2.0",id:m.id,result:null});',
  '}',
  "process.stdin.on('data',(c)=>{buffer=Buffer.concat([buffer,c]);for(;;){const s=buffer.indexOf('\\r\\n\\r\\n');if(s<0)return;const len=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,s).toString())?.[1]??0);if(buffer.length<s+4+len)return;const body=buffer.subarray(s+4,s+4+len).toString();buffer=buffer.subarray(s+4+len);try{handle(JSON.parse(body));}catch{}}});",
  '',
].join('\n');

async function until(check: () => Promise<boolean>, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

describe('positionEncoding utf-32: колонки в обе стороны', () => {
  it('входящая уходит в код-поинтах, исходящая возвращается в utf-16', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-utf32-')));
    dirs.push(base);
    // Строка с эмодзи: 🙂 = 2 utf-16 единицы, но 1 код-поинт. 'a' — колонка 2 (utf-16).
    const file = path.join(base, 'x.ts');
    const text = '🙂ab';
    await fs.writeFile(file, text, 'utf8');
    const uri = pathToFileURL(file).href;
    const script = path.join(base, 'fake.cjs');
    await fs.writeFile(script, FAKE, 'utf8');
    const log = path.join(base, 'calls.log');
    await fs.writeFile(log, '', 'utf8');

    const lsp = new LspService(
      () => base,
      () =>
        ({
          enabled: true,
          servers: [{ language: 'typescript', command: process.execPath, args: [script, log, uri], enabled: true }],
        }) as never,
      () => {},
      () => {},
      () => null,
      async () => ({}),
      async () => [],
      () => null,
    );
    services.push(lsp);

    lsp.open(file, 'typescript', text);
    // Позиция в формате LSP (0-based): символ 'a' после эмодзи = character 2 (utf-16).
    const result = await lsp.request(file, 'textDocument/definition', { position: { line: 0, character: 2 } });
    const locs = result as Array<{ range: { start: { character: number } } }>;

    // Входящая: сервер (utf-32) получил character=1 (код-поинт), а не 2.
    await until(async () => (await fs.readFile(log, 'utf8')).includes('def character='));
    expect(await fs.readFile(log, 'utf8')).toContain('def character=1');
    // Исходящая: ответ с character=1 (utf-32) вернулся как 2 (utf-16).
    expect(locs[0]?.range.start.character).toBe(2);
  });
});
