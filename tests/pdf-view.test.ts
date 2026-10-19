import { describe, expect, it } from 'vitest';
import { MAX_VIEW_PDF_BYTES, fileUrlFor, isPdfPath, pathFromFileUrl, pdfTabTitle } from '../src/shared/pdf';

/**
 * PDF вкладкой-страницей: правила, по которым файл становится вкладкой.
 *
 * Проверяем то, из-за чего вкладка ломается молча: не узнали PDF по имени, собрали
 * `file:`-адрес с неэкранированным `#` (движок открыл бы другой файл), потеряли
 * букву диска Windows или пустили в браузер чужой адрес.
 */
describe('какой файл считается PDF', () => {
  it('по расширению, в любом регистре', () => {
    expect(isPdfPath('/p/docs/тз.pdf')).toBe(true);
    expect(isPdfPath('/p/ОТЧЁТ.PDF')).toBe(true);
    expect(isPdfPath('C:\\docs\\отчёт.Pdf')).toBe(true);
  });

  it('остальное — не PDF, даже если похоже', () => {
    for (const other of ['/p/a.txt', '/p/a.pdf.txt', '/p/pdf', '/p/a.png', '/p/a']) {
      expect(isPdfPath(other), other).toBe(false);
    }
  });
});

describe('file-адрес из пути', () => {
  it('кириллица и пробелы кодируются, а не ломают адрес', () => {
    expect(fileUrlFor('/p/docs/тз на печать.pdf')).toBe(
      'file:///p/docs/%D1%82%D0%B7%20%D0%BD%D0%B0%20%D0%BF%D0%B5%D1%87%D0%B0%D1%82%D1%8C.pdf',
    );
  });

  it('решётка и вопрос в имени файла остаются частью имени, а не адреса', () => {
    const url = fileUrlFor('/p/docs/отчёт #1?.pdf');
    expect(url).not.toContain('#');
    expect(url).not.toContain('?');
    expect(pathFromFileUrl(url)).toBe('/p/docs/отчёт #1?.pdf');
  });

  it('буква диска Windows остаётся буквой', () => {
    expect(fileUrlFor('C:\\docs\\отчёт.pdf')).toBe('file:///C:/docs/%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf');
    expect(pathFromFileUrl('file:///C:/docs/report.pdf')).toBe('C:/docs/report.pdf');
  });

  it('круг «путь → адрес → путь» сходится', () => {
    for (const path of ['/p/a.pdf', '/p/док 1.pdf', 'C:\\p\\a b.pdf']) {
      expect(pathFromFileUrl(fileUrlFor(path))).toBe(path.replace(/\\/g, '/'));
    }
  });
});

describe('обратный разбор адреса', () => {
  it('сетевой адрес — не файл', () => {
    expect(pathFromFileUrl('https://example.com/a.pdf')).toBeNull();
    expect(pathFromFileUrl('не адрес')).toBeNull();
  });

  it('битое кодирование и чужой хозяин — не файл проекта', () => {
    // Битая последовательность в адресе — это не файл, а мусор: decodeURIComponent бросает.
    expect(pathFromFileUrl('file:///p/%zz.pdf')).toBeNull();
    expect(pathFromFileUrl('file://host/share/a.pdf')).toBeNull();
    // `localhost` — та же машина: такой адрес принимаем.
    expect(pathFromFileUrl('file://localhost/p/a.pdf')).toBe('/p/a.pdf');
  });
});

describe('подпись вкладки и предел', () => {
  it('в полосе имя файла, а не путь целиком', () => {
    expect(pdfTabTitle('/p/docs/тз.pdf')).toBe('тз.pdf');
    expect(pdfTabTitle('C:\\docs\\тз.pdf')).toBe('тз.pdf');
    // Без имени вкладка не должна оставаться безымянной.
    expect(pdfTabTitle('/p/docs/')).toBe('Документ.pdf');
  });

  it('предел просмотра задан и он в мегабайтах', () => {
    expect(MAX_VIEW_PDF_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_VIEW_PDF_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024);
  });
});
