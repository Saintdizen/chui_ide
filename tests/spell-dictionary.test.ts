import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dictionaryCandidates, loadSpellDictionary, parseDictionary } from '../src/main/spell/dictionary';

describe('parseDictionary', () => {
  it('простой список: строка — слово', () => {
    expect(parseDictionary('cat\ndog\n')).toEqual(['cat', 'dog']);
  });

  it('hunspell: первая строка — число слов, у слова флаги через косую черту', () => {
    expect(parseDictionary('2\ncat/S\nDog\n')).toEqual(['cat', 'dog']);
  });

  it('комментарии решёткой и мусор пропускаются', () => {
    expect(parseDictionary('# список\ncat\n123\ne.g.\npython3.12\n')).toEqual(['cat']);
  });

  it('поле слова отсекается по пробелу (у простых списков бывает пометка)', () => {
    expect(parseDictionary('hello world\n')).toEqual(['hello']);
  });
});

describe('dictionaryCandidates', () => {
  it('явный путь из окружения идёт первым', () => {
    const list = dictionaryCandidates('linux', { CHUI_DICTIONARY: '/my/words' });
    expect(list[0]).toBe('/my/words');
    expect(list).toContain('/usr/share/dict/words');
  });

  it('на Windows своих мест нет — только явный путь', () => {
    expect(dictionaryCandidates('win32', {})).toEqual([]);
    expect(dictionaryCandidates('win32', { CHUI_DICTIONARY: '/my/words' })).toEqual(['/my/words']);
  });
});

describe('loadSpellDictionary', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chui-spell-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('берёт первый существующий файл и помнит источник', () => {
    const file = join(dir, 'words.txt');
    writeFileSync(file, 'cat\ndog\n', 'utf8');
    const data = loadSpellDictionary([join(dir, 'нет-такого'), file]);
    expect(data.source).toBe(file);
    expect([...data.words].sort()).toEqual(['cat', 'dog']);
  });

  it('нет ни одного файла — пустой словарь без источника', () => {
    expect(loadSpellDictionary([join(dir, 'нет-такого')])).toEqual({ words: [], source: null });
  });
});
