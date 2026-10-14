import { describe, expect, it } from 'vitest';
import {
  expandStructural,
  literalTemplate,
  parseTemplate,
  structuralFind,
  structuralReplace,
  structuralReplaceEdit,
  tokenizeCode,
} from '../src/shared/structural-search';

/** Образец — сразу разобранный: чаще всего он один на тест. */
function template(source: string) {
  return parseTemplate(source);
}

describe('tokenizeCode: из чего состоит код', () => {
  it('имена, числа и знаки — отдельные куски', () => {
    const kinds = tokenizeCode('a = 1 + 2').map((token) => `${token.kind}:${token.text}`);
    expect(kinds).toEqual(['ident:a', 'punct:=', 'number:1', 'punct:+', 'number:2']);
  });

  it('строка с пробелами внутри — ОДИН кусок', () => {
    const tokens = tokenizeCode('"a b c"');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'string', text: '"a b c"' });
  });

  it('число с точкой и порядком читается целиком', () => {
    expect(tokenizeCode('3.14e-2')[0]).toMatchObject({ kind: 'number', text: '3.14e-2' });
    expect(tokenizeCode('0xff')[0]).toMatchObject({ kind: 'number', text: '0xff' });
  });

  it('комментарии узнаются, а строки нет', () => {
    const kinds = tokenizeCode('a // хвост\n/* блок */ b').map((token) => `${token.kind}:${token.text}`);
    expect(kinds).toEqual(['ident:a', 'comment:// хвост', 'comment:/* блок */', 'ident:b']);
  });

  it('решётка — комментарий по умолчанию и не комментарий, если выключить', () => {
    expect(tokenizeCode('#fff')[0]).toMatchObject({ kind: 'comment' });
    expect(tokenizeCode('#fff', { hashComments: false })[0]).toMatchObject({ kind: 'punct', text: '#' });
  });

  it('кириллица в именах — часть имени', () => {
    expect(tokenizeCode('значение')[0]).toMatchObject({ kind: 'ident', text: 'значение' });
  });
});

describe('parseTemplate: чтение образца', () => {
  it('одиночная подстановка и последовательность', () => {
    const items = template('foo($x, $y...)').items;
    expect(items.map((item) => item.type)).toEqual(['token', 'token', 'meta', 'token', 'seq', 'token']);
    expect(items[2]).toEqual({ type: 'meta', name: 'x' });
    expect(items[4]).toEqual({ type: 'seq', name: 'y' });
  });

  it('двойной доллар — буквальный доллар', () => {
    expect(template('$$x').items).toEqual([
      { type: 'token', token: { kind: 'punct', text: '$' } },
      { type: 'token', token: { kind: 'ident', text: 'x' } },
    ]);
  });

  it('пробелы и комментарии в образце не участвуют', () => {
    const texts = template('a  /* тут */  b').items.map((item) => (item.type === 'token' ? item.token.text : '?'));
    expect(texts).toEqual(['a', 'b']);
  });

  it('пустой образец — это ошибка', () => {
    expect(template('   ').error).toBeTruthy();
    expect(template('   ').items).toEqual([]);
  });

  it('literalTemplate прячет доллары, чтобы они не стали подстановкой', () => {
    const types = template(literalTemplate('$5 + x')).items.map((item) => item.type);
    expect(types.every((type) => type === 'token')).toBe(true);
  });
});

describe('structuralFind: что с чем совпало', () => {
  it('находит вызов независимо от пробелов и переводов строк', () => {
    const text = 'foo( a,\n\tb )\nfoo(1)';
    const found = structuralFind(text, template('foo($x, $y)'));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe('foo( a,\n\tb )');
    expect(found[0]!.captures).toEqual({ x: 'a', y: 'b' });
  });

  it('число доводов важно: `foo($x)` не совпадёт с двумя', () => {
    expect(structuralFind('foo(a, b)', template('foo($x)'))).toHaveLength(0);
  });

  it('подстановка ловит любой один кусок — имя, число, строку', () => {
    expect(structuralFind('user.name', template('$a.$b'))[0]!.captures).toEqual({ a: 'user', b: 'name' });
    expect(structuralFind('total = 42;', template('$name = $value;'))[0]!.captures).toEqual({
      name: 'total',
      value: '42',
    });
  });

  it('строка — цельный кусок: содержимое сверяется буквально', () => {
    expect(structuralFind('foo("a b")', template('foo("a b")'))).toHaveLength(1);
    expect(structuralFind('foo("a  b")', template('foo("a b")'))).toHaveLength(0);
  });

  it('последовательность забирает несколько доводов', () => {
    const found = structuralFind('foo(a, b, c)', template('foo($args...)'));
    expect(found[0]!.captures.args).toBe('a, b, c');
  });

  it('последовательность не выходит из своей пары скобок', () => {
    // Образец ищет вызов `f(` — «хвост» обязан закрыться на его же скобке, а не на внешней.
    const found = structuralFind('g(f(a), b)', template('f($x...)'));
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe('f(a)');
  });

  it('совпадения не перекрываются', () => {
    expect(structuralFind('a b c', template('$x'))).toHaveLength(3);
  });

  it('комментарии в сопоставлении не участвуют', () => {
    expect(structuralFind('a /* пояснение */ b', template('a b'))).toHaveLength(1);
  });

  it('пустой образец ничего не находит', () => {
    expect(structuralFind('a b', template('   '))).toEqual([]);
  });
});

describe('expandStructural: подстановка в замену', () => {
  it('подставляет пойманные куски', () => {
    expect(expandStructural('bar($x, $y)', { x: 'a', y: 'b' })).toBe('bar(a, b)');
  });

  it('двойной доллар даёт доллар, неизвестное имя остаётся как есть', () => {
    expect(expandStructural('$$$x', { x: 'v' })).toBe('$v');
    expect(expandStructural('$unknown', {})).toBe('$unknown');
  });
});

describe('structuralReplace: замена по структуре', () => {
  it('меняет форму и считает замены', () => {
    const result = structuralReplace('foo(a, b)\nfoo( c,\n d )', template('foo($x, $y)'), 'bar($y, $x)');
    expect(result.text).toBe('bar(b, a)\nbar(d, c)');
    expect(result.count).toBe(2);
  });

  it('нет совпадений — текст не тронут', () => {
    const result = structuralReplace('foo(a)', template('baz($x)'), 'x');
    expect(result).toEqual({ text: 'foo(a)', count: 0, matches: [] });
  });
});

describe('structuralReplaceEdit: одна правка на весь диапазон', () => {
  it('правка охватывает от первого совпадения до последнего', () => {
    const text = 'foo(a);\nконстанта;\nfoo(b);';
    const edit = structuralReplaceEdit(text, template('foo($x)'), 'baz($x)');
    expect(edit).not.toBeNull();
    expect(text.slice(edit!.start, edit!.end)).toBe('foo(a);\nконстанта;\nfoo(b)');
    expect(edit!.inserted).toBe('baz(a);\nконстанта;\nbaz(b)');
    expect(edit!.count).toBe(2);
  });

  it('нечего менять — правки нет', () => {
    expect(structuralReplaceEdit('foo(a)', template('baz($x)'), 'x')).toBeNull();
  });
});
