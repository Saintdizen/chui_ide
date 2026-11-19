import { describe, expect, it } from 'vitest';
import type { ReleaseAsset } from '../src/shared/update';
import { pickAsset, isCheckDue } from '../src/main/update/check';

function asset(name: string): ReleaseAsset {
  return { name, url: `https://example.test/${name}`, size: 10 };
}

describe('pickAsset', () => {
  it('на Windows берёт установщик под свою архитектуру', () => {
    const assets = [asset('chui-ide-0.5.0-x64.exe'), asset('chui-ide-0.5.0-arm64.exe')];
    expect(pickAsset(assets, 'win32', 'arm64')?.name).toBe('chui-ide-0.5.0-arm64.exe');
  });

  it('на macOS предпочитает dmg архиву', () => {
    const assets = [asset('chui-ide-0.5.0-arm64.zip'), asset('chui-ide-0.5.0-arm64.dmg')];
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('chui-ide-0.5.0-arm64.dmg');
  });

  it('на Linux AppImage важнее deb при равной архитектуре', () => {
    const assets = [asset('chui-ide-0.5.0-arm64.deb'), asset('chui-ide-0.5.0-arm64.AppImage')];
    expect(pickAsset(assets, 'linux', 'arm64')?.name).toBe('chui-ide-0.5.0-arm64.AppImage');
  });

  it('чужую архитектуру не подсовывает: точная сборка важнее расширения', () => {
    const assets = [asset('chui-ide-0.5.0-arm64.deb'), asset('chui-ide-0.5.0-x64.AppImage')];
    expect(pickAsset(assets, 'linux', 'arm64')?.name).toBe('chui-ide-0.5.0-arm64.deb');
  });

  it('универсальная сборка без архитектуры подходит, если точной нет', () => {
    const assets = [asset('chui-ide-0.5.0.dmg')];
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('chui-ide-0.5.0.dmg');
  });

  // Имена взяты из настоящего релиза 0.4.0: electron-builder пишет архитектуру
  // по-разному на Linux (`amd64`, `x86_64`) и на Windows (`x64`). Тесты на
  // придуманных именах этого не ловили.
  describe('имена из настоящего релиза', () => {
    const RELEASE = [
      asset('latest-linux.yml'),
      asset('builder-debug.yml'),
      asset('chui_iDE-0.4.0-linux-x86_64.AppImage'),
      asset('chui_iDE-0.4.0-linux-amd64.deb'),
      asset('chui_iDE-0.4.0-mac-arm64.dmg'),
      asset('chui_iDE-0.4.0-mac-arm64.zip'),
      asset('chui_iDE-0.4.0-win-x64.exe'),
    ];

    // В релизе 0.4.0 для x64 есть только `.deb` (AppImage собран под `x86_64`).
    // Расширение важнее архитектуры — берём `deb`, а не выдумываем AppImage.
    it('linux x64 — deb под amd64', () => {
      expect(pickAsset(RELEASE, 'linux', 'x64')?.name).toBe('chui_iDE-0.4.0-linux-amd64.deb');
    });

    it('linux arm64 — файла нет, не подсовываем amd64', () => {
      expect(pickAsset(RELEASE, 'linux', 'arm64')).toBeNull();
    });

    it('macOS arm64 — dmg важнее zip', () => {
      expect(pickAsset(RELEASE, 'darwin', 'arm64')?.name).toBe('chui_iDE-0.4.0-mac-arm64.dmg');
    });

    it('macOS x64 — файла нет: сборки под Intel в релизе не собрано', () => {
      expect(pickAsset(RELEASE, 'darwin', 'x64')).toBeNull();
    });

    it('Windows x64 — установщик exe', () => {
      expect(pickAsset(RELEASE, 'win32', 'x64')?.name).toBe('chui_iDE-0.4.0-win-x64.exe');
    });
  });

  it('amd64 не считается универсальной сборкой: чужая архитектура не подходит', () => {
    const assets = [asset('chui-ide-0.5.0-mac-amd64.dmg')];
    expect(pickAsset(assets, 'darwin', 'arm64')).toBeNull();
  });

  it('чужая платформа — null, без выдумок', () => {
    expect(pickAsset([asset('chui-ide-0.5.0-x64.exe')], 'freebsd', 'x64')).toBeNull();
  });

  it('нет подходящего файла — null', () => {
    expect(pickAsset([asset('latest.yml')], 'linux', 'x64')).toBeNull();
  });
});

describe('пора ли проверять снова', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('без отметки — пора: старый профиль не должен ждать сутки', () => {
    expect(isCheckDue(undefined, Date.now())).toBe(true);
  });

  it('полчаса назад — рано, в сеть не идём', () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    expect(isCheckDue('2026-11-19T11:30:00.000Z', now)).toBe(false);
  });

  it('сутки и больше прошли — пора', () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    expect(isCheckDue(new Date(now - DAY).toISOString(), now)).toBe(true);
  });

  // Часы могли перевести назад или отметка битая: `NaN` не должен запирать
  // проверку навсегда — иначе после одного сбоя настроек она больше не случится.
  it('битая отметка — пора, а не вечное молчание', () => {
    const now = Date.now();
    expect(isCheckDue('не дата', now)).toBe(true);
    expect(isCheckDue(new Date(now + DAY).toISOString(), now)).toBe(true);
  });
});
