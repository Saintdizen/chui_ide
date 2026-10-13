import { describe, expect, it } from 'vitest';
import { abbreviationBefore, emmetSyntaxFor, expandEmmet } from '../src/shared/emmet';

/**
 * Emmet: раскрытие сокращений в разметку и в свойства стиля. Проверяем и разбор
 * дерева (`>`, `+`, `^`, `*`), и вывод (отступы, нумерация, атрибуты), и стили.
 * Отдельно — отбор слова перед кареткой и то, что чужой язык Emmet не берёт.
 */

const html = (abbr: string, indent?: string) => expandEmmet(abbr, 'markup', indent ? { indent } : {})?.text ?? null;
const caret = (abbr: string, indent?: string) => expandEmmet(abbr, 'markup', indent ? { indent } : {})?.caret ?? null;
const css = (abbr: string) => expandEmmet(abbr, 'style')?.text ?? null;

describe('emmetSyntaxFor', () => {
  it('разметка и стили разводятся по языкам', () => {
    expect(emmetSyntaxFor('html')).toBe('markup');
    expect(emmetSyntaxFor('vue')).toBe('markup');
    expect(emmetSyntaxFor('css')).toBe('style');
    expect(emmetSyntaxFor('scss')).toBe('style');
    expect(emmetSyntaxFor('typescript')).toBeNull();
    expect(emmetSyntaxFor(null)).toBeNull();
  });
});

describe('abbreviationBefore', () => {
  it('берёт слово перед кареткой целиком', () => {
    expect(abbreviationBefore('ul>li*3', 7)).toBe('ul>li*3');
    expect(abbreviationBefore('  div.foo', 9)).toBe('div.foo');
  });

  it('останавливается на разделителе', () => {
    expect(abbreviationBefore('const x = ul>li', 16)).toBe('ul>li');
    expect(abbreviationBefore('текст. ', 7)).toBe(null);
  });

  it('пробелы внутри скобок не рвут слово', () => {
    expect(abbreviationBefore('[title=Hello World]', 20)).toBe('[title=Hello World]');
  });

  it('внутри написанного тега сокращения нет', () => {
    // После `<` идёт уже готовая разметка: `li>` здесь — не сокращение, а текст тега.
    expect(abbreviationBefore('<li>', 4)).toBeNull();
    expect(abbreviationBefore('</div>', 6)).toBeNull();
  });

  it('пусто — null', () => {
    expect(abbreviationBefore('', 0)).toBeNull();
  });
});

describe('разметка: элементы и оформление', () => {
  it('одиночный тег раскрывается с закрывающим', () => {
    expect(html('div')).toBe('<div></div>');
  });

  it('без имени тега — div', () => {
    expect(html('.box')).toBe('<div class="box"></div>');
    expect(html('#main')).toBe('<div id="main"></div>');
  });

  it('классы и идентификатор идут вместе', () => {
    expect(html('div#app.root.wide')).toBe('<div id="app" class="root wide"></div>');
  });

  it('атрибуты: со значением, без значения и с пробелом в нём', () => {
    expect(html('a[href=#][target]')).toBe('<a href="#" target></a>');
    expect(html('input[type=email]')).toBe('<input type="email">');
  });

  it('текст в фигурных скобках', () => {
    expect(html('a{Ссылка}')).toBe('<a href="">Ссылка</a>');
  });

  it('теги без содержимого закрывающего не пишут', () => {
    expect(html('img')).toBe('<img src="" alt="">');
    expect(html('br')).toBe('<br>');
  });
});

describe('разметка: вложенность, соседство, подъём', () => {
  it('вложенность `>` строит дерево с отступами', () => {
    expect(html('ul>li')).toBe('<ul>\n  <li></li>\n</ul>');
  });

  it('соседство `+` ставит элементы рядом', () => {
    expect(html('div+p')).toBe('<div></div>\n<p></p>');
  });

  it('подъём `^` возвращает на уровень выше', () => {
    expect(html('div>p>span^bq')).toBe('<div>\n  <p>\n    <span></span>\n  </p>\n  <blockquote></blockquote>\n</div>');
  });

  it('повтор `*N` и нумерация `$`', () => {
    expect(html('li.item$*3')).toBe('<li class="item1"></li>\n<li class="item2"></li>\n<li class="item3"></li>');
  });

  it('`$$` дополняет номер нулём', () => {
    expect(html('div$$*2')).toBe('<div01></div01>\n<div02></div02>');
  });

  it('отступ настраивается', () => {
    expect(html('ul>li', '\t')).toBe('<ul>\n\t<li></li>\n</ul>');
  });
});

describe('разметка: каретка и скелет', () => {
  it('каретка встаёт внутрь первого листа', () => {
    const text = html('ul>li')!;
    expect(caret('ul>li')).toBe(text.indexOf('<li>') + '<li>'.length);
  });

  it('`!` даёт скелет HTML5, каретка — в теле', () => {
    const text = html('!')!;
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('<title>Document</title>');
    expect(caret('!')).toBeGreaterThan(text.indexOf('<body>'));
  });
});

describe('разметка: чужое не раскрываем', () => {
  it('группы не поддержаны — null, а не мусор', () => {
    expect(html('(a+b)>c')).toBeNull();
  });

  it('пустое сокращение — null', () => {
    expect(expandEmmet('', 'markup')).toBeNull();
  });
});

describe('стили', () => {
  it('свойство с размером получает px', () => {
    expect(css('m10')).toBe('margin: 10px;');
    expect(css('w100')).toBe('width: 100px;');
  });

  it('сокращённое имя разбирается по самому длинному префиксу', () => {
    expect(css('bgc#fff')).toBe('background-color: #fff;');
    expect(css('dib')).toBe('display: inline-block;');
    expect(css('pospr')).toBe('position: relative;');
  });

  it('единицы и проценты не трогаем', () => {
    expect(css('w100%')).toBe('width: 100%;');
    expect(css('h100vh')).toBe('height: 100vh;');
    expect(css('fz1.5rem')).toBe('font-size: 1.5rem;');
  });

  it('несколько значений через дефис', () => {
    expect(css('m10-20')).toBe('margin: 10px 20px;');
  });

  it('ноль — без единиц', () => {
    expect(css('m0')).toBe('margin: 0;');
  });

  it('свойства без единиц (z-index, opacity) оставляют число', () => {
    expect(css('z10')).toBe('z-index: 10;');
    expect(css('op50')).toBe('opacity: 50;');
  });

  it('несколько свойств через `+` — каждое своей строкой', () => {
    expect(css('m10+p20')).toBe('margin: 10px;\n  padding: 20px;');
  });

  it('!important', () => {
    expect(css('m10!')).toBe('margin: 10px !important;');
  });

  it('неизвестное имя — null', () => {
    expect(css('xyz10')).toBeNull();
  });
});
