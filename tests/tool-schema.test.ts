import { describe, expect, it } from 'vitest';
import { missingArguments, toolSpec } from '../src/shared/tool-schema';

/**
 * Проверка обязательных полей до исполнения. Поводом была живая ошибка: модель
 * присылала `apply_patch` без `path` внутри элемента массива — схема такую форму
 * и разрешала (у массива было описание, но не было полей элемента), а разбор
 * аргументов ждал `path` и отвечал отказом из глубины.
 */

describe('toolSpec', () => {
  it('находит схему по имени', () => {
    expect(toolSpec('read_file')?.name).toBe('read_file');
  });

  it('чужое имя (MCP) не находит', () => {
    expect(toolSpec('mcp__foo__bar')).toBeUndefined();
  });
});

describe('missingArguments', () => {
  it('пустые аргументы — все обязательные поля перечислены', () => {
    const spec = toolSpec('read_file')!;
    expect(missingArguments(spec.inputSchema, {})).toEqual(['path']);
  });

  it('на месте — пустой список', () => {
    const spec = toolSpec('read_file')!;
    expect(missingArguments(spec.inputSchema, { path: '/a.ts' })).toEqual([]);
  });

  it('null считается пропуском, пустая строка — нет', () => {
    // Пустую строку разбор понимает по-своему (например, «весь файл»), и
    // отвергать её здесь значило бы разойтись с ним.
    const spec = toolSpec('read_file')!;
    expect(missingArguments(spec.inputSchema, { path: null })).toEqual(['path']);
    expect(missingArguments(spec.inputSchema, { path: '' })).toEqual([]);
  });

  it('вложенный элемент массива называется с индексом', () => {
    // Та самая ошибка: `patches[0].path` — не «path», и по такому ответу
    // видно, какой именно элемент формы забыл поле.
    const spec = toolSpec('apply_patch')!;
    const missing = missingArguments(spec.inputSchema, { patches: [{ patches: [] }] });
    expect(missing).toEqual(['patches[0].path']);
  });

  it('полная форма apply_patch проходит', () => {
    const spec = toolSpec('apply_patch')!;
    const args = { patches: [{ path: '/a.ts', patches: [{ oldText: 'a', newText: 'b' }] }] };
    expect(missingArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('вложенный объект в правке тоже проверяется', () => {
    const spec = toolSpec('apply_edit')!;
    const missing = missingArguments(spec.inputSchema, {
      edits: [{ path: '/a.ts', edits: [{ startLine: 1 }] }],
    });
    expect(missing).toEqual([
      'edits[0].edits[0].startColumn',
      'edits[0].edits[0].endLine',
      'edits[0].edits[0].endColumn',
      'edits[0].edits[0].newText',
    ]);
  });

  it('не-объект вместо элемента не роняет проверку', () => {
    const spec = toolSpec('apply_patch')!;
    expect(missingArguments(spec.inputSchema, { patches: ['строка'] })).toEqual([]);
  });
});
