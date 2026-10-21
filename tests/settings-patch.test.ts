import { describe, expect, it } from 'vitest';
import { PROJECT_SETTINGS_SECTIONS } from '../src/shared/project-config';
import { hasEntries, isProjectSection, splitSettingsPatch } from '../src/renderer/core/settings-patch';

describe('splitSettingsPatch', () => {
  it('проектные секции — в файл проекта, прочие — в общие', () => {
    const { project, global } = splitSettingsPatch({ editor: { tabSize: 2 }, ai: { enabled: true } });
    expect(Object.keys(project)).toEqual(['editor']);
    expect(Object.keys(global)).toEqual(['ai']);
  });

  it('каждая проектная секция действительно уходит в проект — список не разъехался', () => {
    for (const key of PROJECT_SETTINGS_SECTIONS) {
      expect(isProjectSection(key)).toBe(true);
    }
  });

  it('неизвестное имя секции уходит в общие: ошибиться в сторону userData не так дорого', () => {
    expect(isProjectSection('нет-такой')).toBe(false);
  });

  it('половина секции — законный случай, содержимое не режем', () => {
    const patch = { editor: { tabSize: 2 } };
    expect(splitSettingsPatch(patch).project.editor).toEqual({ tabSize: 2 });
  });

  it('пустая правка — пусто с обеих сторон', () => {
    expect(splitSettingsPatch({})).toEqual({ project: {}, global: {} });
  });
});

describe('hasEntries', () => {
  it('не пускает пустой запрос в main', () => {
    expect(hasEntries({})).toBe(false);
    expect(hasEntries({ ai: {} })).toBe(true);
  });
});
