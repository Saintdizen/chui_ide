import { describe, expect, it } from 'vitest';
import {
  PROFILE_KIND,
  PROFILE_VERSION,
  buildProfile,
  parseProfile,
  profilePatch,
} from '../src/shared/profile';

const settings = {
  editor: { fontSize: 15 },
  appearance: { theme: 'dark' },
  layout: { sidebarSize: 300 },
  ai: { model: 'x' },
  recent: ['/tmp/a'],
  roots: ['/tmp/a'],
  workspace: { activeRoot: '/tmp/a' },
  update: { channel: 'stable' },
  somethingUnknown: { x: 1 },
};

describe('профиль рабочего окружения', () => {
  it('собирает только то, что принадлежит человеку', () => {
    const profile = buildProfile(settings, new Date('2026-01-02T03:04:05Z'));
    expect(profile.kind).toBe(PROFILE_KIND);
    expect(profile.version).toBe(PROFILE_VERSION);
    expect(profile.exportedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(Object.keys(profile.settings).sort()).toEqual(
      ['ai', 'appearance', 'editor', 'layout'].sort(),
    );
  });

  it('не тащит машинное и незнакомое в файл', () => {
    const profile = buildProfile(settings);
    expect(profile.settings).not.toHaveProperty('recent');
    expect(profile.settings).not.toHaveProperty('roots');
    expect(profile.settings).not.toHaveProperty('workspace');
    expect(profile.settings).not.toHaveProperty('update');
    expect(profile.settings).not.toHaveProperty('somethingUnknown');
  });

  it('снимает и разбирает без потерь', () => {
    const profile = buildProfile(settings);
    const parsed = parseProfile(JSON.stringify(profile));
    expect(parsed.ok).toBe(true);
    expect(parsed.applied?.sort()).toEqual(['ai', 'appearance', 'editor', 'layout'].sort());
    expect(parsed.patch).toEqual({
      editor: { fontSize: 15 },
      appearance: { theme: 'dark' },
      layout: { sidebarSize: 300 },
      ai: { model: 'x' },
    });
  });

  it('машинные ключи отбрасываются, даже если есть в файле', () => {
    const patch = profilePatch({
      kind: PROFILE_KIND,
      version: PROFILE_VERSION,
      exportedAt: '',
      settings: { editor: {}, recent: [], roots: [], workspace: {}, activeRoot: '/x' },
    });
    expect(patch).toEqual({ editor: {} });
  });

  it('чужой файл не выдаёт себя за профиль', () => {
    expect(parseProfile('не json').ok).toBe(false);
    expect(parseProfile('{"kind":"что-то"}').error).toBe('Это не файл профиля');
    expect(parseProfile('null').ok).toBe(false);
    expect(parseProfile({ kind: PROFILE_KIND, version: PROFILE_VERSION }).error).toBe(
      'В профиле нет настроек',
    );
  });

  it('профиль из будущей версии не применяется молча', () => {
    const parsed = parseProfile({
      kind: PROFILE_KIND,
      version: PROFILE_VERSION + 1,
      settings: { editor: {} },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('более новой версии');
    expect(parsed.patch).toBeUndefined();
  });
});
