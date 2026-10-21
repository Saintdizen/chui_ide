import { describe, expect, it } from 'vitest';
import {
  deleteManyPrompt,
  deletePrompt,
  movedNotice,
  renamedNotice,
  trashedNotice,
} from '../src/renderer/core/file-notices';

/** Заглушка склонения: важно не «объекта», а то, что число и слово вместе. */
const plural = (n: number) => (n === 1 ? 'объект' : 'объектов');

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

describe('deleteManyPrompt', () => {
  it('один вопрос на пачку — и число с склонением', () => {
    expect(deleteManyPrompt(3, plural).message).toBe('Переместить в корзину 3 объектов?');
    expect(deleteManyPrompt(1, plural).message).toBe('Переместить в корзину 1 объект?');
  });
});

describe('trashedNotice', () => {
  it('ноль не показываем вовсе', () => {
    expect(trashedNotice(0, plural)).toBeNull();
  });

  it('хотя бы один — показываем', () => {
    expect(trashedNotice(2, plural)).toBe('В корзине: 2 объектов');
  });
});

describe('movedNotice', () => {
  it('одного называем по имени, а не «1 объект»', () => {
    expect(movedNotice(1, 'api.ts', plural)).toBe('Перенесено: api.ts');
  });

  it('пачку — числом', () => {
    expect(movedNotice(4, null, plural)).toBe('Перенесено: 4 объектов');
  });
});
