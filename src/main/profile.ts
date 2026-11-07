import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildProfile, parseProfile, PROFILE_EXTENSION, type ProfileImport } from '../shared/profile';
import type { Settings } from '../shared/api';

/**
 * Профиль рабочего окружения на диске: собрать и наложить обратно.
 *
 * Сам формат и его проверка — в `shared/profile.ts` (чистый модуль, там же тесты).
 * Здесь только ввод-вывод: чтение и запись выбранного человеком файла.
 *
 * Настройки принимаются функциями, а не хранилищем: модулю всё равно, откуда они,
 * и в тестах не надо поднимать весь `SettingsStore`.
 */
export class ProfileService {
  constructor(
    private readonly read: () => Settings,
    private readonly write: (patch: Record<string, unknown>) => Settings,
  ) {}

  /** Записать текущее окружение в файл. Возвращает путь — его показывает уведомление. */
  async exportTo(target: string): Promise<{ ok: boolean; path: string; sections: readonly string[] }> {
    const file = target.endsWith(PROFILE_EXTENSION) ? target : `${target}${PROFILE_EXTENSION}`;
    const profile = buildProfile(this.read() as unknown as Record<string, unknown>);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    return { ok: true, path: file, sections: Object.keys(profile.settings) };
  }

  /**
   * Наложить профиль из файла. Импорт — всегда частичный: чего в файле нет,
   * остаётся как было, а не сбрасывается в заводское. Ошибки — исключением,
   * как у прочих RPC.
   */
  async importFrom(source: string): Promise<ProfileImport & { path: string }> {
    const raw = await fs.readFile(source, 'utf8');
    const parsed = parseProfile(raw);
    if (!parsed.ok) throw new Error(parsed.error ?? 'Это не файл профиля');
    this.write(parsed.patch ?? {});
    return { ...parsed, path: source };
  }
}
