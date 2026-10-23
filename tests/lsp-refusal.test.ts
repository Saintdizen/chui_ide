import { describe, expect, it } from 'vitest';
import { LspService } from '../src/main/lsp/lsp';
import type { FileSymbol } from '../src/shared/lsp-symbols';
import type { SymbolLocation } from '../src/shared/lsp-locations';

/**
 * «Не ответил» и «ответил пусто» — разные ответы языкового сервера.
 *
 * Грабля: `outline`, `references` и `definition` ловили ошибку запроса как `[]`.
 * Пустой список агент читает буквально: «объявлений в файле нет», «символ нигде
 * не встречается», «определения не нашлось». Там, где сервер упал или не поднял
 * проект, это ложный ответ, и шаг строился на нём. Теперь отказ остаётся отказом
 * (`null`), а `[]` значит ровно то, что говорит: спросили и пусто.
 *
 * Настоящий tsserver ради ответа «ошибка» поднимать незачем: проверяется
 * поведение самих методов на поддельном соединении.
 */

type Request = (method: string, params: unknown) => Promise<unknown>;

interface Outliner {
  outline(path: string, languageId: string, text: string): Promise<FileSymbol[] | null>;
  references(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<SymbolLocation[] | null>;
  definition(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<SymbolLocation[] | null>;
}

/** Методы сервиса с подменённым транспортом: сервер «есть», запрос — что дали. */
function serviceWith(request: Request): Outliner {
  const runtime = {
    language: 'typescript',
    capabilities: {
      documentSymbolProvider: true,
      referencesProvider: true,
      definitionProvider: true,
    },
    connection: { request },
  };
  // Конструктору нужны настройки и Electron-пути, а методам — только рантайм.
  const self = Object.create(LspService.prototype) as Record<string, unknown>;
  self.runtimeForDocument = async () => runtime;
  self.withDocument = async (
    _r: unknown,
    _p: string,
    _l: string,
    _t: string,
    visit: (uri: string) => Promise<unknown>,
  ) => visit('file:///x.ts');
  return self as unknown as Outliner;
}

describe('отказ сервера не притворяется пустым ответом', () => {
  it('outline: ошибка запроса — `null`, а не «объявлений нет»', async () => {
    const service = serviceWith(() => Promise.reject(new Error('No Project')));
    expect(await service.outline('/x.ts', 'typescript', 'export const a = 1;\n')).toBeNull();
  });

  it('outline: пустой список сервера остаётся пустым списком', async () => {
    const service = serviceWith(() => Promise.resolve([]));
    expect(await service.outline('/x.ts', 'typescript', '')).toEqual([]);
  });

  it('references: ошибка запроса — `null`', async () => {
    const service = serviceWith(() => Promise.reject(new Error('request failed')));
    expect(await service.references('/x.ts', 'typescript', 'a', 1, 1)).toBeNull();
  });

  it('definition: ошибка запроса — `null`', async () => {
    const service = serviceWith(() => Promise.reject(new Error('request failed')));
    expect(await service.definition('/x.ts', 'typescript', 'a', 1, 1)).toBeNull();
  });
});
