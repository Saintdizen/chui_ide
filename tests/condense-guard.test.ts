import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyEditsHostResult } from '../src/shared/api';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { condenseAppliedCalls, isCondenseMarker } from '../src/shared/context-fit';

const MARKER = '[применено: 57 стр. — текст в файле]';
// Собираем в рантайме: в исходнике такая строка выглядит как порча, и статический
// сторож (как и сторож самой IDE) не должен спотыкаться о тест для этого сторожа.
const OLD_MARKER = ['[применено:', '3 стр.', '— текст в файле]'].join(' ');

describe('пометка сжатия в аргументе: отказ вместо порчи файла', () => {
  it('узнаёт пометку и не путает её с текстом о пометке', () => {
    expect(isCondenseMarker(MARKER)).toBe(true);
    expect(isCondenseMarker(`  ${MARKER}\n`)).toBe(true);
    // Обычный текст, даже упоминающий сжатие, — не пометка.
    expect(isCondenseMarker('export const a = 1;')).toBe(false);
    expect(isCondenseMarker(`${MARKER}\nещё строка`)).toBe(false);
  });

  it('create_file: файл не создаётся, ответ объясняет причину', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const target = join(dir, 'probe.txt');
      const r = await runTool(ctx, 'create_file', JSON.stringify({ path: target, contents: MARKER }));
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('contents');
      expect(r.summary).toContain('Повтори вызов');
      // Главное: на диске ничего не появилось.
      expect(existsSync(target)).toBe(false);
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edit: старый текст на месте, ответ — отказ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const file = join(dir, 'probe.ts');
    writeFileSync(file, 'const a = 1;\n', 'utf8');
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const args = { edits: [{ path: file, edits: [{ oldText: 'const a = 1;', newText: MARKER }] }] };
      const r = await runTool(ctx, 'edit', JSON.stringify(args));
      expect(r.ok).toBe(false);
      // Путь назван вложенно: по нему видно, какая именно правка испорчена.
      expect(r.summary).toContain('edits[0].edits[0].newText');
      expect(readFileSync(file, 'utf8')).toBe('const a = 1;\n');
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edit: пометка в oldText рядом с живым newText — правка, а не порча', async () => {
    // Так модель пишет «дописать в конец»: старый текст у неё в памяти пометкой,
    // а новый — настоящий. Отказ здесь ломал бы законную правку.
    const workspace = { rootPath: () => '/proj' } as unknown as WorkspaceService;
    const applyPatches = async () =>
      ({
        rejected: false,
        result: { reports: [{ path: '/proj/a.ts', applied: 1, version: 1 }], failed: [] },
      }) as ApplyEditsHostResult;
    const args = {
      edits: [{ path: '/proj/a.ts', edits: [{ oldText: OLD_MARKER, newText: 'export const bb = 22;' }] }],
    };
    const r = await runTool({ workspace, applyPatches }, 'edit', JSON.stringify(args));

    if (!r.ok) throw new Error(`отказ: ${r.summary}`);
    expect(r.ok).toBe(true);
  });

  it('terminal: пометка в command больше не сжимается', () => {
    // Раньше `command` входил в `CONDENSE_FIELDS`: команда длиннее 400 символов
    // (или с переносом строки) заменялась пометкой, и повтор тем же вызовом
    // был невозможен — в JSON вместо строки стоял объект. Теперь `command`
    // в истории остаётся целым, а проверка пометки его не касается.
    const message = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'terminal', arguments: JSON.stringify({ action: 'run', command: 'x'.repeat(600) }) },
      ],
    };
    const condensed = condenseAppliedCalls(message as never, new Set(['call_1']));
    const args = JSON.parse(condensed.toolCalls?.[0]?.arguments ?? '{}');
    expect(args.command).toHaveLength(600);
    expect(isCondenseMarker(args.command)).toBe(false);
  });

  it('terminal: команда-пометка всё равно не выполняется', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const r = await runTool(ctx, 'terminal', JSON.stringify({ action: 'run', command: MARKER }));
      // Модель может прислать пометку сама (из чужой истории) — это всё равно
      // не команда, её нужно остановить.
      expect(r.ok).toBe(false);
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('пометка узнаётся в старой и новой записи', () => {
  it('обе формы — пометка, обычный текст — нет', () => {
    expect(isCondenseMarker('[применено: 12 стр. — текст в файле]')).toBe(true);
    expect(isCondenseMarker('[применено: 12 стр. — текст в файле, не копировать]')).toBe(true);
    expect(isCondenseMarker('const a = 1;\n[применено: 12 стр.]')).toBe(false);
    expect(isCondenseMarker(42)).toBe(false);
  });
});

describe('сжатие аргументов не трогает команды', () => {
  const command = 'npm run typecheck 2>&1 | tail -20';
  const long = `python3 - <<'PY'\nprint(1)\nPY\n${'# комментарий\n'.repeat(40)}`;

  it('короткая команда после успеха остаётся текстом', () => {
    const message = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'call-1', name: 'terminal', arguments: JSON.stringify({ action: 'run', command }) }],
    };
    const out = condenseAppliedCalls(message, new Set(['call-1']));
    // То же сообщение по ссылке: сжимать нечего.
    expect(out).toBe(message);
  });

  it('§длинная команда с переносом строки после успеха тоже остаётся целой', () => {
    // Раньше здесь стояла пометка: команда длиннее 400 символов считалась
    // применённой, и повторять вызов было нельзя — в JSON вместо строки
    // оказывался объект, форма вызова ломалась.
    const message = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'call-2', name: 'terminal', arguments: JSON.stringify({ action: 'run', command: long }) }],
    };
    const out = condenseAppliedCalls(message, new Set(['call-2']));
    expect(out).toBe(message);
    const text = (out as { toolCalls: { arguments: string }[] }).toolCalls[0].arguments;
    expect(JSON.parse(text).command).toBe(long);
  });

  it('тела правок сжимаются по-прежнему', () => {
    const body = 'const a = 1;\n'.repeat(40);
    const message = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        {
          id: 'call-3',
          name: 'create_file',
          arguments: JSON.stringify({ edits: [{ path: '/tmp/x.ts', contents: body }] }),
        },
      ],
    };
    const out = condenseAppliedCalls(message, new Set(['call-3']));
    expect(out).not.toBe(message);
    const args = JSON.parse((out as { toolCalls: { arguments: string }[] }).toolCalls[0].arguments);
    const item = args.edits[0];
    expect(isCondenseMarker(item.contents)).toBe(true);
    expect(item.path).toBe('/tmp/x.ts');
  });
});
