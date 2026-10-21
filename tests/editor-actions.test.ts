import { describe, expect, it } from 'vitest';
import { editorActionCommand, editorActionCommands } from '../src/renderer/core/editor-actions';

describe('editorActionCommand', () => {
  it('пункт заведён под префиксом editor., чтобы не спорить с командами окна', () => {
    const command = editorActionCommand({ id: 'foldAll', label: 'Свернуть всё' });
    expect(command.id).toBe('editor.foldAll');
    expect(command.title).toBe('Свернуть всё');
    expect(command.category).toBe('Редактор');
  });

  it('ключевые слова — id и псевдоним: ищут латиницей, а подпись русская', () => {
    expect(editorActionCommand({ id: 'foldAll', label: 'Свернуть', alias: 'fold' }).keywords).toEqual([
      'foldAll',
      'fold',
    ]);
  });

  it('пустой псевдоним в поиск не попадает', () => {
    const command = editorActionCommand({ id: 'foldAll', label: 'Свернуть', alias: null });
    expect(command.keywords).toEqual(['foldAll']);
  });

  it('отсутствующий псевдоним — тоже', () => {
    expect(editorActionCommand({ id: 'x', label: 'X' }).keywords).toEqual(['x']);
  });
});

describe('editorActionCommands', () => {
  it('порядок редактора сохраняется', () => {
    const commands = editorActionCommands([
      { id: 'a', label: 'А' },
      { id: 'b', label: 'Б' },
    ]);
    expect(commands.map((c) => c.id)).toEqual(['editor.a', 'editor.b']);
  });

  it('пустой список — пустой результат', () => {
    expect(editorActionCommands([])).toEqual([]);
  });
});
