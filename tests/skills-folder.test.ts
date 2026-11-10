import { describe, expect, it } from 'vitest';
import { byFolderThenName, findSkill, formatSkillCatalog, joinFolder, type SkillEntry } from '../src/shared/skills';

/**
 * Навык из `src/.chui/skills` — сценарий для `src`. Если показать его везде, он
 * начнёт спорить с навыками корня; если не показать нигде, его как будто нет.
 * Сторож держит границу: в своей папке и ниже виден, выше — нет.
 */

function skill(name: string, folder: string, description = 'когда нужен'): SkillEntry {
  return { name, description, path: `/p/${folder}/.chui/skills/${name}/SKILL.md`, scope: 'workspace', folder };
}

const all = [skill('release', ''), skill('lint-rules', 'src'), skill('deep', 'src/core'), skill('tests', 'tests')];

describe('навыки подпапок', () => {
  it('в корне — только корневые', () => {
    const catalog = formatSkillCatalog(all, { folder: '' });
    expect(catalog).toContain('release');
    expect(catalog).not.toContain('lint-rules');
    expect(catalog).not.toContain('deep');
  });

  it('в папке — свои и корневые, но не соседские', () => {
    const catalog = formatSkillCatalog(all, { folder: 'src/core' });
    expect(catalog).toContain('release');
    expect(catalog).toContain('lint-rules');
    expect(catalog).toContain('deep');
    expect(catalog).not.toContain('tests —');
  });

  it('навык подпапки подписан папкой: имя у него не единственное', () => {
    expect(formatSkillCatalog(all, { folder: 'src' })).toContain('- lint-rules (src) — когда нужен');
  });

  it('без подходящих навыков блока нет вовсе', () => {
    expect(formatSkillCatalog([skill('deep', 'src/core')], { folder: 'tests' })).toBeNull();
    expect(formatSkillCatalog([], { folder: 'src' })).toBeNull();
  });

  it('корень раньше подпапок: навык с тем же именем побеждает предсказуемо', () => {
    const ordered = [skill('x', 'src'), skill('x', ''), skill('y', 'src')].sort(byFolderThenName);
    expect(ordered.map((item) => item.folder)).toEqual(['', 'src', 'src']);
    // Поиск по имени берёт первого в этом порядке — корневого.
    expect(findSkill(ordered, 'X')?.folder).toBe('');
  });

  it('путь подпапки собирается без лишних слэшей', () => {
    expect(joinFolder('', 'src')).toBe('src');
    expect(joinFolder('src', 'core')).toBe('src/core');
  });
});
