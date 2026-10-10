/**
 * Иконка приложения: рисуем её кодом и кладём готовый PNG в `build/icon.png`.
 *
 * Тёмная плитка с синим знаком «[i_i]»: цвета взяты из палитры приложения
 * (`styles/theme.css`), поэтому ярлык и окно выглядят как одно целое. Геометрию
 * знака скрипт НЕ повторяет — читает её из `dist/shared/logo.js`, то есть из
 * того же файла, что и интерфейс (`renderer/ui/logo.ts`).
 *
 * Зачем скрипт, а не файл из редактора: electron-builder собирает значки окна
 * (`.ico` для Windows и `.icns` для macOS) из одной картинки 512×512, и эта
 * картинка должна быть воспроизводима — исходник в репозитории, а не бинарь
 * неизвестного происхождения. Зависимостей нет: PNG пишем сами через zlib.
 *
 *   npm run icon
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_HEIGHT, LOGO_RECTS, LOGO_WIDTH } from '../dist/shared/logo.js';

const SIZE = 512;
/** Сглаживание: 4×4 подвыборки на пиксель дают ровный край без размытия. */
const SAMPLES = 4;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── палитра ────────────────────────────────────────────────────────────────
   Значения совпадают с ролями тёмной схемы в `src/renderer/styles/theme.css`:
   окно `--main_background`, карточка `--element_background_2`, линия
   `--border_color`, акцент `--blue_prime_background`. */
const SURFACE = [30, 30, 30]; // #1e1e1e — полотно редактора
const WINDOW = [22, 22, 24]; // #161618 — фон окна
const BORDER = [58, 58, 60]; // #3a3a3c — линия-контур
const MARK = [0, 145, 255]; // #0091ff — акцент палитры

const mix = (a, b, t) => a + (b - a) * t;

/** Фон плитки: мягкий градиент от полотна редактора к фону окна. */
function surfaceColor(x, y) {
  const t = (x / SIZE) * 0.35 + (y / SIZE) * 0.65;
  return [mix(SURFACE[0], WINDOW[0], t), mix(SURFACE[1], WINDOW[1], t), mix(SURFACE[2], WINDOW[2], t)];
}

/* ── геометрия ─────────────────────────────────────────────────────────────── */

/** Расстояние до скруглённого прямоугольника с центром (cx, cy): <0 внутри. */
function roundedBoxDistance(x, y, cx, cy, width, height, radius) {
  const dx = Math.abs(x - cx) - (width / 2 - radius);
  const dy = Math.abs(y - cy) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Точка внутри прямоугольника знака — с учётом скругления углов. */
function insideRect(ux, uy, rect) {
  if (ux < rect.x || ux > rect.x + rect.width || uy < rect.y || uy > rect.y + rect.height) return false;
  const radius = Math.min(rect.rx ?? 0, rect.width / 2, rect.height / 2);
  if (radius <= 0) return true;
  return (
    roundedBoxDistance(ux, uy, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width, rect.height, radius) <= 0
  );
}

const PLATE_RADIUS = SIZE * 0.22;
const PLATE_INSET = SIZE * 0.02;
/** Контур: тонкая линия по краю плитки — на тёмных обоях она отделяет значок. */
const BORDER_WIDTH = SIZE * 0.014;

/** Знак занимает почти три четверти полотна: ярлык читается и в 16 пикселей. */
const MARK_SCALE = (0.74 * SIZE) / LOGO_WIDTH;

/** Границы знака: по ним центрируем, а не по «пустой» решётке 25×16. */
const MARK_BOX = LOGO_RECTS.reduce(
  (box, rect) => ({
    left: Math.min(box.left, rect.x),
    right: Math.max(box.right, rect.x + rect.width),
    top: Math.min(box.top, rect.y),
    bottom: Math.max(box.bottom, rect.y + rect.height),
  }),
  { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
);

const MARK_CENTER = { x: (MARK_BOX.left + MARK_BOX.right) / 2, y: (MARK_BOX.top + MARK_BOX.bottom) / 2 };
/** Знак в единицах решётки — из пикселя полотна. */
const toUnits = (x, y) => ({
  x: (x - SIZE / 2) / MARK_SCALE + MARK_CENTER.x,
  y: (y - SIZE / 2) / MARK_SCALE + MARK_CENTER.y,
});

/** Внутри ли точка знака (в пикселях полотна). */
function insideMark(x, y) {
  const { x: ux, y: uy } = toUnits(x, y);
  return LOGO_RECTS.some((rect) => insideRect(ux, uy, rect));
}

/* ── пиксели ───────────────────────────────────────────────────────────────── */

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const plateWidth = SIZE - PLATE_INSET * 2;

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let covered = 0;
    let markHits = 0;
    let red = 0;
    let green = 0;
    let blue = 0;

    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        const distance = roundedBoxDistance(px, py, SIZE / 2, SIZE / 2, plateWidth, plateWidth, PLATE_RADIUS);
        if (distance > 0) continue;

        covered += 1;
        if (insideMark(px, py)) markHits += 1;
        // Контур рисуем по краю плитки: он отделяет значок от тёмных обоев.
        const base = distance > -BORDER_WIDTH ? BORDER : surfaceColor(px, py);
        red += base[0];
        green += base[1];
        blue += base[2];
      }
    }

    if (covered === 0) continue;

    const markRatio = markHits / covered;
    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(mix(red / covered, MARK[0], markRatio));
    pixels[offset + 1] = Math.round(mix(green / covered, MARK[1], markRatio));
    pixels[offset + 2] = Math.round(mix(blue / covered, MARK[2], markRatio));
    pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
  }
}

/* ── PNG ───────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Строки с фильтром 0: картинка рисуется один раз, экономить на фильтрах незачем. */
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // бит на канал
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = path.join(root, 'build', 'icon.png');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(
  `[иконка] ${target} — ${SIZE}×${SIZE}, знак ${Math.round(MARK_BOX.right - MARK_BOX.left)}×${Math.round(MARK_BOX.bottom - MARK_BOX.top)} единиц решётки ${LOGO_WIDTH}×${LOGO_HEIGHT}, ${(png.length / 1024).toFixed(1)} КБ`,
);
