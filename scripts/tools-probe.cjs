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

// Настоящие git/rg/lsp не запускаем — скрипт только обходит диспетчер.
// Пути абсолютные: инструменты работают с путями от корня рабочей папки,
// относительный путь — не «не найдено», а отказ «вне рабочей папки».
const CALLS = (root) => [
  ['list', { path: root }],
  ['list', { path: root, depth: '2' }],
  ['read', { path: path.join(root, 'a.txt') }],
  ['search', { query: 'hello' }],
  ['search', { query: 'hello', limit: '5' }],
  ['edit', { path: path.join(root, 'a.txt'), oldText: 'hello', newText: 'world' }],
  ['file', { action: 'mkdir', path: path.join(root, 'made') }],
  ['git', { action: 'status' }],
  ['history', { action: 'sessions' }],
  ['project_map', {}],
  ['open_files', {}],
  ['todo', {}],
  ['terminal', { action: 'run', command: 'true' }],
  ['run', { command: 'true' }],
  ['run_tests', {}],
  ['checks', { action: 'diagnostics' }],
  ['lsp', { action: 'outline', path: path.join(root, 'src', 'b.ts') }],
  ['debug', { action: 'stop' }],
  ['browser', { action: 'open', url: 'about:blank' }],
  ['web', { action: 'search', query: 'test' }],
  ['mind', { action: 'notes' }],
  ['show', { action: 'open', path: path.join(root, 'a.txt') }],
  ['read_image', { path: path.join(root, 'a.txt') }],
  ['skill', {}],
  ['mcp', { action: 'list' }],
];

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chui-probe-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'hello\nworld\n');
  await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');

  // Загружаем собранный main: скрипт не умеет TS напрямую — сборка обязательна.
  const { runTool } = require('../dist/main/ai/agent-tools.js');
  const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
  const ws = new WorkspaceService(() => undefined);
  await ws.open(root);

  const failures = [];
  const rows = [];
  try {
    for (const [name, args] of CALLS(root)) {
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
        const noEnv = /не поддерж|недоступ|не подключ|не настроен|нет доступа|нет хранилищ|не репозиторий|нет$/i.test(
          text,
        );
        const kind = result.ok ? 'ok' : `${noEnv ? 'нет окружения' : 'ОТКАЗ'}: ${text.slice(0, 60)}`;
        verdict = `${kind} (${ms} мс)`;
        if (!result.ok && !noEnv) {
          failures.push(`${name}: неожиданный отказ — ${text}`);
        }
      } catch (error) {
        verdict = `УПАЛ: ${error.message}`;
        failures.push(`${name}: ${error.message}`);
      }
      rows.push([name, verdict]);
    }
  } finally {
    ws.dispose();
    await rm(root, { recursive: true, force: true });
  }

  for (const [name, verdict] of rows) {
    console.log(`${name.padEnd(12)} ${verdict}`);
  }
  if (failures.length > 0) {
    console.log(`\nПровалов: ${failures.length}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  // rows — это вызовы, а не имена: list и search зовутся дважды, чтобы
  // проверить оба режима. Считаем в вызовах, чтобы не врать в итоге.
  console.log(`\nВсе ${rows.length} вызовов ответили (${new Set(rows.map(([n]) => n)).size} инструментов).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
