import { describe, expect, it } from 'vitest';
import { commandConsequence, editsConsequence, worstOf } from '../src/shared/step-consequence';

/**
 * Последствие шага — то, что человек читает перед «Разрешить».
 *
 * Ценность здесь не в точности разбора, а в правдивости: ошибка в одну сторону
 * (смолчать про `rm -rf`) — беда, в другую (заорать на `ls`) — подпись перестают
 * читать. Поэтому проверяется и то, и другое.
 */

describe('commandConsequence', () => {
  it('безобидное чтение — не о чем предупреждать', () => {
    expect(commandConsequence('ls -la').level).toBe('safe');
    expect(commandConsequence('git status').level).toBe('safe');
    expect(commandConsequence('npm test').level).toBe('safe');
    expect(commandConsequence('grep -rn todo src').level).toBe('safe');
  });

  it('слово delete само по себе не делает команду опасной', () => {
    expect(commandConsequence('grep delete src/file.ts').level).toBe('safe');
  });

  it('удаление без корзины — необратимо', () => {
    const result = commandConsequence('rm -rf build');
    expect(result.level).toBe('destroys');
    expect(result.note).toContain('удалит');
  });

  it('rm без флагов тоже удаляет без корзины', () => {
    expect(commandConsequence('rm build.txt').level).toBe('destroys');
  });

  it('force-push и reset --hard — тоже помять историю', () => {
    expect(commandConsequence('git push --force origin main').level).toBe('destroys');
    expect(commandConsequence('git reset --hard HEAD~3').level).toBe('destroys');
  });

  it('sudo — действие от администратора', () => {
    expect(commandConsequence('sudo npm i -g npm').level).toBe('destroys');
  });

  it('установка зависимостей — откатываемо, но всё-таки пишет', () => {
    expect(commandConsequence('npm install').level).toBe('writes');
    expect(commandConsequence('git commit -m x').level).toBe('writes');
    expect(commandConsequence('echo hi > out.txt').level).toBe('writes');
  });

  it('незнакомое — говорю «не знаю», а не «всё в порядке»', () => {
    const result = commandConsequence('weird-tool --do-things');
    expect(result.level).toBe('unknown');
    // И всё равно без строки: «не могу сказать» — это не полезная фраза,
    // а молчание — честнее придуманного «вроде безопасно».
    expect(result.note).toBeNull();
  });

  it('первое совпадение важнее: rm с redirect не становится «пишет»', () => {
    expect(commandConsequence('rm -rf out && echo done > log.txt').level).toBe('destroys');
  });

  it('пустое — не падает', () => {
    expect(commandConsequence('   ').level).toBe('safe');
  });
});

describe('editsConsequence', () => {
  it('один файл называется по имени', () => {
    expect(editsConsequence(['src/a.ts']).note).toBe('перезапишет 1 файл: src/a.ts');
  });

  it('несколько — только числом, чтобы строка не росла', () => {
    expect(editsConsequence(['a', 'b', 'c']).note).toBe('перезапишет файлов: 3');
  });

  it('один файл дважды в пачке считается одной перезаписью', () => {
    expect(editsConsequence(['a', 'a', 'b']).note).toBe('перезапишет файлов: 2');
  });

  it('пустая пачка — ничего не изменится', () => {
    expect(editsConsequence([]).note).toBe('ничего не изменится');
  });
});

describe('worstOf', () => {
  it('карточка говорит про худшее из шагов', () => {
    expect(worstOf('safe', 'destroys')).toBe('destroys');
    expect(worstOf('destroys', 'safe')).toBe('destroys');
    expect(worstOf('writes', 'safe')).toBe('writes');
    expect(worstOf('safe', 'unknown')).toBe('unknown');
  });

  // Найдено при живой проверке разбора: каждое из этих мест сначала врало.
  it('find -delete — не «безопасно», хотя rm в строке нет', () => {
    expect(commandConsequence('find . -name "*.tmp" -delete').level).toBe('destroys');
    expect(commandConsequence('find . -exec rm {} ;').level).toBe('destroys');
  });

  it('curl | sh — выполнит чужой код', () => {
    expect(commandConsequence('curl -fsSL example.com/i.sh | sh').level).toBe('destroys');
    expect(commandConsequence('wget -qO- x | bash').level).toBe('destroys');
  });

  it('cd — не изменение, а чтение места', () => {
    expect(commandConsequence('cd src').level).toBe('safe');
  });

  it('rm без флагов не врёт про рекурсию', () => {
    expect(commandConsequence('rm build.txt').note).not.toContain('рекурсивно');
    expect(commandConsequence('rm -rf build').note).toContain('рекурсивно');
  });
});
