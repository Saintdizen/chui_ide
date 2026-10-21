import { describe, expect, it } from 'vitest';
import { deletePrompt, renamedNotice } from '../src/renderer/core/file-notices';

describe('renamedNotice', () => {
  it('без правок ссылок — коротко', () => {
    expect(renamedNotice({ name: 'api.ts', touched: 0 })).toBe('Переименовано: api.ts');
  });

  it('с правками — видно, сколько файлов поправлено: человек об этом и спрашивает', () => {
    expect(renamedNotice({ name: 'api.ts', touched: 7 })).toBe('Переименовано: api.ts · обновлено ссылок: 7');
  });

  it('ноль ссылок не показываем: «обновлено ссылок: 0» читается как сбой', () => {
    expect(renamedNotice({ name: 'a.ts', touched: 0 })).not.toContain('0');
  });
});

describe('deletePrompt', () => {
  it('надпись компактна, путь — отдельно во второй строке', () => {
    const prompt = deletePrompt('api.ts', 'src/api.ts');
    expect(prompt.message).toBe('Переместить api.ts в корзину?');
    expect(prompt.detail).toContain('src/api.ts');
  });

  it('в detail сказано, что удаление обратимо', () => {
    expect(deletePrompt('a.ts', 'a.ts').detail).toContain('корзин');
  });
});
