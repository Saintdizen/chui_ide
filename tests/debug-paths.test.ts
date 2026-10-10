import { describe, expect, it } from 'vitest';
import { debugPathKey, PathAliases } from '../src/shared/debug-paths';

/**
 * Карта написаний пути. Две стороны важны одинаково: отладчику нужен настоящий
 * путь (иначе точка останова не встанет), а редактору — свой (иначе кадр не
 * откроется). Проверяем именно это, а не наличие записей.
 */
const posix = () => new PathAliases(false);
const windows = () => new PathAliases(true);

describe('debugPathKey', () => {
  it('разделители приводятся к одному виду', () => {
    expect(debugPathKey('C:\\proj\\app.py', true)).toBe(debugPathKey('C:/proj/app.py', true));
  });

  it('регистр важен только там, где он не важен системе', () => {
    expect(debugPathKey('A.py', false)).not.toBe(debugPathKey('a.py', false));
    expect(debugPathKey('C:\\A.py', true)).toBe(debugPathKey('c:\\a.py', true));
  });
});

describe('PathAliases', () => {
  it('macOS-симлинк: кадр возвращается в написание клиента', () => {
    const aliases = posix();
    aliases.remember('/var/proj/app.py', '/private/var/proj/app.py');

    expect(aliases.resolve('/private/var/proj/app.py')).toBe('/var/proj/app.py');
    expect(aliases.canonicalFor('/var/proj/app.py')).toBe('/private/var/proj/app.py');
  });

  it('чужой путь остаётся как есть', () => {
    const aliases = posix();
    aliases.remember('/var/proj/app.py', '/private/var/proj/app.py');

    expect(aliases.resolve('/opt/other.py')).toBe('/opt/other.py');
    expect(aliases.canonicalFor('/opt/other.py')).toBe('/opt/other.py');
  });

  it('совпадающие написания не попадают в карту', () => {
    const aliases = posix();
    aliases.remember('/proj/app.py', '/proj/app.py');

    expect(aliases.size).toBe(0);
    expect(aliases.canonicalFor('/proj/app.py')).toBe('/proj/app.py');
  });

  it('неразрешившийся путь (нет файла) не ломает карту', () => {
    const aliases = posix();
    aliases.remember('/proj/нет.py', null);

    expect(aliases.size).toBe(0);
    expect(aliases.resolve('/proj/нет.py')).toBe('/proj/нет.py');
  });

  it('Windows: короткое имя файла — это другое написание', () => {
    // `RUNNER~1` и полное имя в CI расходятся не только регистром, поэтому связь
    // нужна: отладчик доложит одно, редактор открыт по другому.
    const aliases = windows();
    aliases.remember('C:\\Users\\RUNNER~1\\app.py', 'C:\\Users\\runneradmin\\app.py');

    expect(aliases.resolve('c:/users/RUNNERADMIN/app.py')).toBe('C:\\Users\\RUNNER~1\\app.py');
    expect(aliases.canonicalFor('C:\\Users\\RUNNER~1\\app.py')).toBe('C:\\Users\\runneradmin\\app.py');
  });

  it('Windows: различие только в регистре — тот же файл, связь не нужна', () => {
    // Файловая система регистр не различает, поэтому и подменять написание
    // нечего: редактор откроет файл по любому из них.
    const aliases = windows();
    aliases.remember('C:\\PROJ\\app.py', 'C:\\proj\\app.py');

    expect(aliases.size).toBe(0);
    expect(aliases.resolve('C:/PROJ/app.py')).toBe('C:/PROJ/app.py');
  });

  it('повторное запоминание того же файла не оставляет старую связь', () => {
    const aliases = posix();
    aliases.remember('/var/proj/app.py', '/private/var/proj/app.py');
    // Проект переоткрыли по другому пути: прежнее написание больше не наше.
    aliases.remember('/var/proj/app.py', '/real/var/proj/app.py');

    expect(aliases.resolve('/private/var/proj/app.py')).toBe('/private/var/proj/app.py');
    expect(aliases.resolve('/real/var/proj/app.py')).toBe('/var/proj/app.py');
    expect(aliases.size).toBe(1);
  });

  it('путь, ставший совпадающим, вычищается из карты', () => {
    const aliases = posix();
    aliases.remember('/var/app.py', '/private/var/app.py');
    aliases.remember('/private/var/app.py', '/private/var/app.py');

    expect(aliases.size).toBe(0);
  });

  it('clear забывает всё', () => {
    const aliases = posix();
    aliases.remember('/var/app.py', '/private/var/app.py');
    aliases.clear();

    expect(aliases.size).toBe(0);
    expect(aliases.resolve('/private/var/app.py')).toBe('/private/var/app.py');
  });
});
