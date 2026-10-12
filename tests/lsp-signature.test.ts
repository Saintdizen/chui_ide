import { describe, expect, it } from 'vitest';
import { signatureParts, signatureTrigger, toSignatureHelp } from '../src/shared/lsp-signature';

/** Ответ сервера с одной подписью и парой параметров — обычный случай. */
function oneSignature(parameters: unknown[], activeParameter = 0) {
  return {
    signatures: [{ label: 'greet(name, greeting)', parameters }],
    activeSignature: 0,
    activeParameter,
  };
}

describe('разбор подсказки о параметрах', () => {
  it('разбирает одну подпись с метками-смещениями', () => {
    const help = toSignatureHelp(oneSignature([{ label: [6, 10] }, { label: [12, 20] }], 1));
    expect(help).not.toBeNull();
    expect(help!.activeSignature).toBe(0);
    expect(help!.activeParameter).toBe(1);
    expect(help!.signatures[0]!.parameters).toEqual([
      { text: 'name', start: 6, end: 10 },
      { text: 'greeting', start: 12, end: 20 },
    ]);
  });

  it('метку-строку ищет в подписи и получает смещения', () => {
    const help = toSignatureHelp(oneSignature([{ label: 'name' }]));
    expect(help!.signatures[0]!.parameters[0]).toEqual({ text: 'name', start: 6, end: 10 });
  });

  it('повторяющиеся имена находит по очереди, а не все на первом месте', () => {
    const help = toSignatureHelp({
      signatures: [{ label: 'f(a, a)', parameters: [{ label: 'a' }, { label: 'a' }] }],
      activeSignature: 0,
      activeParameter: 1,
    });
    expect(help!.signatures[0]!.parameters).toEqual([
      { text: 'a', start: 2, end: 3 },
      { text: 'a', start: 5, end: 6 },
    ]);
  });

  it('документация берётся из строки и из MarkupContent', () => {
    const help = toSignatureHelp({
      signatures: [
        { label: 'f()', documentation: 'просто строка' },
        { label: 'g()', documentation: { kind: 'markdown', value: '**жирный**' } },
      ],
      activeSignature: 1,
      activeParameter: 0,
    });
    expect(help!.signatures[0]!.documentation).toBe('просто строка');
    expect(help!.signatures[1]!.documentation).toBe('**жирный**');
  });

  it('чужие индексы подрезаются по границам', () => {
    const help = toSignatureHelp({
      signatures: [{ label: 'f(a)' }, { label: 'g()' }],
      activeSignature: 7,
      activeParameter: 9,
    });
    expect(help!.activeSignature).toBe(1);
    expect(help!.activeParameter).toBe(-1); // у `g()` параметров нет
  });

  it('индекс параметра подрезается до последнего у активной подписи', () => {
    const help = toSignatureHelp(oneSignature([{ label: [6, 10] }, { label: [12, 20] }], 5));
    expect(help!.activeParameter).toBe(1);
  });

  it('без подписей и на мусоре отвечает «нечего показывать»', () => {
    expect(toSignatureHelp(null)).toBeNull();
    expect(toSignatureHelp({})).toBeNull();
    expect(toSignatureHelp({ signatures: [] })).toBeNull();
    expect(toSignatureHelp('строка')).toBeNull();
  });

  it('подпись без метки пропускается, но остальные остаются', () => {
    const help = toSignatureHelp({ signatures: [{ parameters: [] }, { label: 'f()' }] });
    expect(help!.signatures.map((item) => item.label)).toEqual(['f()']);
  });
});

describe('нарезка подписи по активному параметру', () => {
  it('активный параметр отделяется от остального текста', () => {
    const help = toSignatureHelp(oneSignature([{ label: [6, 10] }, { label: [12, 20] }], 1))!;
    expect(signatureParts(help.signatures[0]!, 1)).toEqual([
      { text: 'greet(', active: false },
      { text: 'name', active: false },
      { text: ', ', active: false },
      { text: 'greeting', active: true },
      { text: ')', active: false },
    ]);
  });

  it('без активного параметра подпись остаётся целой', () => {
    const help = toSignatureHelp(oneSignature([{ label: [6, 10] }], 0))!;
    expect(signatureParts(help.signatures[0]!, -1).every((part) => !part.active)).toBe(true);
  });

  it('подпись без параметров — одна часть', () => {
    const help = toSignatureHelp({ signatures: [{ label: 'f()' }] })!;
    expect(signatureParts(help.signatures[0]!, -1)).toEqual([{ text: 'f()', active: false }]);
  });
});

describe('знак, запускающий подсказку', () => {
  it('открывает скобка и запятая, закрывает закрывающая', () => {
    expect(signatureTrigger('(')).toBe('request');
    expect(signatureTrigger(',')).toBe('request');
    expect(signatureTrigger(')')).toBe('dismiss');
    expect(signatureTrigger('a')).toBeNull();
    expect(signatureTrigger('')).toBeNull();
  });
});
