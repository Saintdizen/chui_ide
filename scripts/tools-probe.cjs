#!/usr/bin/env node
/**
 * Живой прогон всех инструментов агента на настоящем маленьком дереве.
 *
 * Зачем отдельно от тестов: тесты проверяют каждый инструмент по одиночке и
 * на подделках, а этот скрипт зовёт все через настоящие runTool + WorkspaceService
 * и смотрит одно: не упал ли кто и ответил ли по делу. Инструмент без ответной
 * строки — дыра в ростере, даже если его собственный тест зелёный.
 *
 *   node scripts/tools-probe.cjs
 */
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Аргументы под конкретное действие — руками, потому что схема знает только
 * тип и имя поля, но не смысл. Ключ — `имя:действие`; без действия — `имя`.
 * Нет ключа — берём требуемые поля схемы с безопасными значениями.
 *
 * Пути абсолютные: относительный — не «не найдено», а «вне рабочей папки».
 */
const ARGS = (root) => {
  const file = path.join(root, 'a.txt');
  const script = path.join(root, 'src', 'b.ts');
  // Разрушающие действия берут по своему файлу: иначе move уносит a.txt,
  // а copy за ним падает на ENOENT — и весь прогон врёт про инструмент.
  const movable = path.join(root, 'movable.txt');
  const copyable = path.join(root, 'copyable.txt');
  return {
    list: { path: root },
    'list:deep': { path: root, depth: '2' },
    read: { path: file },
    'read:range': { path: file, startLine: '1', endLine: '1' },
    search: { query: 'hello' },
    'search:text': { action: 'text', query: 'hello' },
    'search:code': { action: 'code', query: 'hello' },
    'search:docs': { action: 'docs', query: 'hello' },
    'search:limit': { query: 'hello', limit: '5' },
    edit: { path: file, oldText: 'hello', newText: 'world' },
    project_map: {},
    open_files: {},
    read_image: { path: file },
    run_tests: {},
    run: { script: 'true' },
    skill: {},
    file: { action: 'mkdir', path: path.join(root, 'made') },
    'file:move': { action: 'move', from: movable, to: path.join(root, 'moved.txt') },
    'file:copy': { action: 'copy', from: copyable, to: path.join(root, 'copied.txt') },
    'file:mkdir': { action: 'mkdir', path: path.join(root, 'dir2') },
    'file:delete': { action: 'delete', path: path.join(root, 'copied.txt') },
    'file:format': { action: 'format', path: script },
    'file:organizeImports': { action: 'organizeImports', path: script },
    'git:status': { action: 'status' },
    'git:diff': { action: 'diff' },
    'git:log': { action: 'log' },
    'git:blame': { action: 'blame', path: file },
    'git:show': { action: 'show', ref: 'HEAD' },
    'history:sessions': { action: 'sessions' },
    'history:trace': { action: 'trace' },
    todo: {},
    terminal: { command: 'true' },
    terminalList: {},
    terminalOpen: { command: 'true' },
    terminalOutput: { id: 'x' },
    terminalWrite: { id: 'x', data: 'x' },
    terminalStop: { id: 'x' },
    'checks:diagnostics': { action: 'diagnostics' },
    'checks:problems': { action: 'problems' },
    'checks:lint': { action: 'lint' },
    'lsp:outline': { action: 'outline', path: script },
    'lsp:references': { action: 'references', path: script, line: '1', column: '1', symbol: 'b' },
    'lsp:definition': { action: 'definition', path: script, line: '1', column: '1' },
    'lsp:rename': { action: 'rename', path: script, line: '1', column: '1', symbol: 'b', newName: 'c' },
    'debug:stop': { action: 'stop' },
    'debug:pause': { action: 'pause' },
    'debug:continue': { action: 'continue' },
    'debug:stepOver': { action: 'stepOver' },
    'debug:stepInto': { action: 'stepInto' },
    'debug:stepOut': { action: 'stepOut' },
    'debug:status': { action: 'status' },
    'debug:stack': { action: 'stack' },
    'debug:evaluate': { action: 'evaluate', expression: '1+1' },
    'debug:breakpoints': { action: 'breakpoints', path: script, line: '1' },
    'debug:start': { action: 'start', program: script },
    'debug:variables': { action: 'variables' },
    'debug:set': { action: 'set', expression: 'x', value: '1' },
    'browser:open': { action: 'open', url: 'about:blank' },
    'browser:close': { action: 'close' },
    'browser:screenshot': { action: 'screenshot' },
    'browser:snapshot': { action: 'snapshot' },
    'browser:click': { action: 'click', ref: 'e1' },
    'browser:type': { action: 'type', ref: 'e1', text: 'x' },
    'browser:evaluate': { action: 'evaluate', expression: '1+1' },
    'browser:zoom': { action: 'zoom', mode: 'in' },
    'web:search': { action: 'search', query: 'test' },
    'web:fetch': { action: 'fetch', url: 'https://example.com' },
    'mind:notes': { action: 'notes' },
    'mind:remember': { action: 'remember', text: 'x' },
    'mind:forget': { action: 'forget', query: 'x' },
    'mind:ask': { action: 'ask', question: 'x' },
    'mind:steps': { action: 'steps' },
    'mind:goal': { action: 'goal', goal: 'x' },
    'mind:exit_plan': { action: 'exit_plan' },
    'show:open': { action: 'open', path: file },
    'show:present': { action: 'present', path: file },
    'mcp:list': { action: 'list' },
    'mcp:read': { action: 'read', uri: 'test://x' },
  };
};

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chui-probe-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'hello\nworld\n');
  await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  // Каждый разрушающий инструмент — на своём файле (см. комментарий в ARGS).
  await writeFile(path.join(root, 'movable.txt'), 'x\n');
  await writeFile(path.join(root, 'copyable.txt'), 'x\n');

  // Загружаем собранный main: скрипт не умеет TS напрямую — сборка обязательна.
  const { runTool } = require('../dist/main/ai/agent-tools.js');
  const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
  const ws = new WorkspaceService(() => undefined);
  await ws.open(root);

  const failures = [];
  const unverified = [];
  const rows = [];
  const argsByName = ARGS(root);
  try {
    for (const [key, args] of Object.entries(argsByName)) {
      // Ключ таблицы — `имя` или `имя:ярлык`; в диспетчер уходит только имя.
      const name = key.split(':')[0];
      const ctx = { workspace: ws, signal: new AbortController().signal };
      const started = Date.now();
      let verdict;
      try {
        const result = await runTool(ctx, name, JSON.stringify(args));
        const ms = Date.now() - started;
        // Отказ «нет такой возможности» — не падение: важно, что инструмент
        // ответил. Различаем два случая: чего-то нет в этом окружении (норма,
        // включая «не репозиторий git» — temp-корень его и не должен иметь)
        // и инструмент не смог сделать то, что должен (беда).
        const text = String(result.error ?? result.summary ?? '');
        const noEnv =
          /не поддерж|недоступ|не подключ|не настроен|нет доступа|нет хранилищ|не репозиторий|нечего|не включён|нет$/i.test(
            text,
          );
        const kind = result.ok ? 'ok' : `${noEnv ? 'нет окружения' : 'ОТКАЗ'}: ${text.slice(0, 60)}`;
        verdict = `${kind} (${ms} мс)`;
        if (!result.ok && !noEnv) {
          failures.push(`${key}: неожиданный отказ — ${text}`);
        }
      } catch (error) {
        verdict = `УПАЛ: ${error.message}`;
        failures.push(`${key}: ${error.message}`);
      }
      rows.push([key, verdict]);
    }

    // Сверка с ростером: инструмент или действие без вызова — дыра в пробе.
    // toolActions — единственный источник правды о под-действиях (та же
    // таблица, по которой строится описание для модели).
    const { AGENT_TOOLS, toolActions } = require('../dist/shared/tools.js');
    // В чистом Node нет electron.shell — удаление в корзину не проверить.
    // Это не провал и не «всё хорошо»: просто не проверено здесь.
    const ONLY_IN_APP = new Set(['file:delete']);
    for (const key of ONLY_IN_APP) {
      const verdict = String(rows.find(([n]) => n === key)?.[1] ?? '');
      if (verdict.includes('нет окружения')) unverified.push(key);
    }
    const coveredNames = new Set(Object.keys(argsByName).map((k) => k.split(':')[0]));
    for (const schema of AGENT_TOOLS) {
      if (!coveredNames.has(schema.name)) {
        failures.push(`${schema.name}: нет ни одного вызова в пробе`);
        continue;
      }
      for (const action of toolActions(schema.name)) {
        if (!(`${schema.name}:${action}` in argsByName)) {
          failures.push(`${schema.name}: действие ${action} не проверено`);
        }
      }
    }
  } finally {
    ws.dispose();
    await rm(root, { recursive: true, force: true });
  }

  for (const [name, verdict] of rows) {
    console.log(`${name.padEnd(12)} ${verdict}`);
  }
  if (unverified.length > 0) {
    console.log(`\nНе проверено здесь (нужен Electron): ${unverified.join(', ')}`);
  }
  if (failures.length > 0) {
    console.log(`\nПровалов: ${failures.length}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  // Имён меньше, чем вызовов: у семейств с action проверилось каждое действие.
  const names = new Set(rows.map(([n]) => n.split(':')[0]));
  console.log(`\nВсе ${rows.length} вызовов ответили (${names.size} имён).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
