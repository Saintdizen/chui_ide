/**
 * Отказ по пропущенному аргументу приносит ТОЛЬКО пропущенные поля.
 *
 * Раньше в `detail` уезжала схема целиком (`argumentsShape`): промах на одном
 * аргументе стоил сотен токенов, и они оседали в истории диалога до конца.
 * Вдобавок `detail` дублировал `summary` с формой — за один промах платили
 * дважды за одно и то же знание.
 */
import { describe, expect, it } from 'vitest';
import { missingFieldsDetail, toolSpec } from '../src/shared/tool-schema';

const schemaOf = (name: string) => {
  const spec = toolSpec(name);
  if (!spec) throw new Error(`нет инструмента ${name}`);
  return spec.inputSchema;
};

describe('missingFieldsDetail', () => {
  it('перечисляет только пропущенное, с типом и допустимыми значениями', () => {
    const text = missingFieldsDetail('web', schemaOf('web'), ['action']);
    expect(text).toBe('Аргументы web: нужны action: string=search|fetch');
  });

  it('не тащит в отказ поля, о которых не спрашивали', () => {
    const text = missingFieldsDetail('lsp', schemaOf('lsp'), ['action']);
    expect(text).not.toContain('includeDeclaration');
    expect(text).not.toContain('newName');
  });

  it('доходит до полей элемента массива по пути edits[0].path', () => {
    const text = missingFieldsDetail('edit', schemaOf('edit'), ['edits[0].path']);
    expect(text).toContain('edits[0].path: string');
  });

  it('неизвестный путь показывает как есть и не врёт о типе', () => {
    // `edits[].edits[]` — альтернативная раскладка, которой нет в `properties`
    // элемента: тип не выдумываем, пусть будет голый путь.
    const text = missingFieldsDetail('edit', schemaOf('edit'), ['edits[0].edits']);
    expect(text).toBe('Аргументы edit: нужны edits[0].edits');
  });

  it('несколько пропущенных полей идут через запятую', () => {
    const text = missingFieldsDetail('edit', schemaOf('edit'), ['edits[0].path', 'edits[0].newText']);
    expect(text).toContain('edits[0].path: string, edits[0].newText: string');
  });
});
