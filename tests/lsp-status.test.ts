import { describe, expect, it } from 'vitest';
import {
  describeServerVersion,
  lspChipFor,
  lspOriginLabel,
  NO_LSP_STATUS,
  type LspStatus,
} from '../src/shared/lsp-status';

describe('состояние языковых серверов', () => {
  const status: LspStatus = {
    running: ['python'],
    servers: [{ language: 'python', label: 'Pyright', origin: 'bundled' }],
    failed: [{ language: 'go', reason: 'сервер не найден' }],
  };

  it('причина — словами сервера, а не наше «не поднялся»', () => {
    // Так пришёл настоящий отказ tsserver: виды «не поднялся» виноватого не называют.
    const refused: LspStatus = {
      running: [],
      servers: [],
      failed: [
        {
          language: 'typescript',
          reason: 'Request initialize failed with message: The TypeScript of the workspace provides no tsserver.js.',
        },
      ],
    };
    expect(lspChipFor('typescript', refused)?.failed).toContain('no tsserver.js');
  });

  it('подпись источника — словами', () => {
    expect(lspOriginLabel('bundled')).toBe('поставка IDE');
    expect(lspOriginLabel('python')).toBe('окружение проекта');
    expect(lspOriginLabel('settings')).toBe('свой путь');
    expect(lspOriginLabel('path')).toBe('PATH');
  });

  it('чип показывает запущенный сервер и его источник', () => {
    expect(lspChipFor('python', status)).toEqual({
      language: 'python',
      label: 'Pyright',
      origin: 'bundled',
      failed: null,
    });
  });

  it('упавший сервер показываем с причиной: это и есть ответ «почему нет»', () => {
    expect(lspChipFor('go', status)).toEqual({
      language: 'go',
      label: 'go',
      origin: null,
      failed: 'сервер не найден',
    });
  });

  it('про язык без сервера и без отказа молчим', () => {
    expect(lspChipFor('rust', status)).toBeNull();
    expect(lspChipFor(null, status)).toBeNull();
  });

  it('пустое состояние — пустой чип', () => {
    expect(lspChipFor('python', NO_LSP_STATUS)).toBeNull();
  });
});

describe('версия сервера в попапе', () => {
  it('имя и версия — одной строкой', () => {
    expect(describeServerVersion({ name: 'pyright', version: '1.1.380' })).toBe('pyright 1.1.380');
  });

  it('сервер без версии не превращается в хвостик с пробелом', () => {
    expect(describeServerVersion({ name: 'tsserver' })).toBe('tsserver');
  });

  it('только версия тоже годится', () => {
    expect(describeServerVersion({ version: '2.0' })).toBe('2.0');
  });

  it('пустое и отсутствующее — не строка с прочерком, а ничего', () => {
    expect(describeServerVersion({ name: '  ', version: '' })).toBeUndefined();
    expect(describeServerVersion(null)).toBeUndefined();
  });
});
