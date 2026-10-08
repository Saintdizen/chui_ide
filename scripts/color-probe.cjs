/**
 * Пробник цветового соответствия: сверяет пиксель НА ЭКРАНЕ с тем, что записано
 * в токенах темы.
 *
 * Зачем именно экран, а не `capturePage()`: `capturePage` отдаёт кадр Chromium,
 * а цветоуправление (профиль монитора, протокол `wp_color_manager_v1` на
 * Wayland) работает в композиторе — то есть после него. Именно поэтому сдвиг
 * тёмных тонов на `capturePage` не виден вообще.
 *
 * Как устроено: пробник рисует плашки известных цветов и в полноэкранном окне,
 * сам снимает экран (`spectacle`) и опознаёт плашки по «отпечатку» из шести
 * цветов. Снимок повторяется, пока плашки не окажутся в кадре: окно полноэкранное
 * появляется не мгновенно, и один фиксированный кадр ловил чужой рабочий стол.
 *
 * Два прохода — отдельными процессами, потому что флаги Chromium читает до старта
 * GPU-процесса и в одном процессе их не переключить:
 *   «без флагов»           — как Electron ведёт себя сам;
 *   «как в приложении»     — те же флаги, что ставит `src/main/index.ts`.
 * Перед ними идёт прогревающий запуск: у первого Electron холодный кэш GPU, и его
 * окно не успевает попасть даже в двенадцатый кадр.
 *
 * Запуск: npm run probe:colors   (нужен дисплей и KDE: окно занимает экран на пару секунд)
 */
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

/** Плашки: две поверхности проекта, края шкалы и цвет токена. */
const PATCHES = [
  ['#1e1e1e', 'полотно редактора'],
  ['#161618', 'фон приложения'],
  ['#000000', 'чёрный'],
  ['#ffffff', 'белый'],
  ['#569cd6', 'keyword VS Code'],
  ['#242424', 'тёмный тон'],
];

const STEP = 50;
const PASS = process.env.PROBE_PASS;

/** Флаги приложения: те же строки, что в `src/main/index.ts`. */
function applyAppSwitches() {
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  const passed = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch(
    'disable-features',
    passed === '' ? 'WaylandWpColorManagerV1' : `${passed},WaylandWpColorManagerV1`,
  );
}

if (PASS === 'app') applyAppSwitches();

/* ── проход: рисуем плашки, снимаем экран, читаем пиксели ───────────────── */

const channels = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
const hexOf = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Отпечаток ищется УСТОЙЧИВО, а не по точному совпадению: цвета могут быть
 * сдвинуты — собственно, ради замера сдвига пробник и запускают. Поэтому опознаём
 * по форме: белая плашка, слева от неё три тёмных, справа синяя и тёмная.
 */
function findAnchor(bitmap, width, height) {
  const at = (x, y) => {
    const offset = (y * width + x) * 4;
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
  };
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const bright = (rgb) => rgb[0] > 235 && rgb[1] > 235 && rgb[2] > 235;
  const dark = (rgb) => luma(rgb) < 80;
  const blue = (rgb) => rgb[2] > 170 && rgb[2] > rgb[0] + 40;

  for (let y = 20; y < Math.min(height, 600); y += 2) {
    for (let x = STEP * 3 + 20; x < width - STEP * 2 - 20; x += 2) {
      if (!bright(at(x, y))) continue;
      if (!dark(at(x - STEP, y)) || !dark(at(x - 2 * STEP, y)) || !dark(at(x - 3 * STEP, y))) continue;
      if (!blue(at(x + STEP, y)) || !dark(at(x + 2 * STEP, y))) continue;
      return {
        x,
        y,
        hexAt: (px, py) => hexOf(...at(px, py)),
      };
    }
  }
  return null;
}

/** Снимок экрана с повтором, пока плашки не окажутся в кадре. */
async function measure() {
  const shot = path.join(os.tmpdir(), `chui-color-probe-${PASS ?? 'plain'}.png`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const taken = spawnSync('spectacle', ['-b', '-n', '-f', '-o', shot], { encoding: 'utf8' });
    if (taken.error) return { error: `не запустить spectacle: ${taken.error.message}` };

    const image = nativeImage.createFromPath(shot);
    if (image.isEmpty()) continue;
    const { width, height } = image.getSize();
    const anchor = findAnchor(image.toBitmap(), width, height);
    if (!anchor) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      continue;
    }

    const rows = PATCHES.map(([color, name], index) => {
      const [r, g, b] = channels(color);
      const x = anchor.x + (index - 3) * STEP;
      const got = anchor.hexAt(x, anchor.y);
      const deltas = channels(got).map((value, channel) => value - [r, g, b][channel]);
      const mark =
        got === color ? 'точно' : deltas.every((delta) => delta === deltas[0]) ? `сдвиг ${deltas[0] > 0 ? '+' : ''}${deltas[0]}` : 'не кривая';
      return { name, color, got, mark };
    });
    return { rows, attempt };
  }

  return { error: 'плашки так и не попали в кадр' };
}

/* ── родитель: два прохода и сравнение ─────────────────────────────────── */

if (!PASS) {
  if (process.platform !== 'linux') {
    console.log('Пробник рассчитан на Linux с KDE: нужен `spectacle`.');
    app.exit(1);
  } else {
    const passes = [
      ['без флагов', 'plain'],
      ['как в приложении', 'app'],
    ];
    const measured = [];

    // Прогрев: первый Electron поднимает GPU-кэш, и до этого окно не успевает
    // появиться в кадре — измерение ловило чужой рабочий стол.
    spawnSync(process.execPath, [__filename], {
      env: { ...process.env, PROBE_PASS: 'warmup' },
      encoding: 'utf8',
    });

    for (const [title, pass] of passes) {
      const run = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, PROBE_PASS: pass },
        encoding: 'utf8',
      });
      const rows = (run.stdout ?? '')
        .split('\n')
        .filter((line) => line.startsWith('ROW|'))
        .map((line) => {
          const [, name, color, got, mark] = line.split('|');
          return { name, color, got, mark };
        });
      const failed = (run.stdout ?? '').split('\n').find((line) => line.startsWith('ERROR|'));
      measured.push({ title, rows, failed: failed ? failed.slice(6) : null });
    }

    console.log('\nПиксель на экране против токенов темы\n');
    for (const { title, rows, failed } of measured) {
      console.log(`  ${title}`);
      if (failed) console.log(`    не удалось измерить: ${failed}`);
      for (const row of rows) console.log(`    ${row.name.padEnd(18)} ${row.color} → ${row.got}  ${row.mark}`);
      console.log('');
    }

    const [plain, appPass] = measured;
    if (plain?.rows.length && appPass?.rows.length) {
      const shifted = (entry) => entry.rows.filter((row) => row.mark !== 'точно').length;
      console.log(
        shifted(appPass) < shifted(plain)
          ? 'Итог: флаги приложения убирают расхождение с токенами.'
          : shifted(appPass) === shifted(plain)
            ? 'Итог: флаги приложения на этой машине ничего не меняют.'
            : 'Итог: флаги приложения на этой машине вносят расхождение — стоит их снять.',
      );
    }
    app.exit(0);
  }
} else {
  void app.whenReady().then(async () => {
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000000">
${PATCHES.map(
  ([color], index) =>
    `<div style="position:absolute;left:${10 + index * STEP}px;top:10px;width:40px;height:40px;background:${color}"></div>`,
).join('')}
</body>`;

    const win = new BrowserWindow({ fullscreen: true, frame: false, backgroundColor: '#000000' });
    win.setAlwaysOnTop(true);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Два кадра: первый может быть ещё до того, как композитор поставит окно.
    await win.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))',
    );

    const result = await measure();
    if (result.error) console.log(`ERROR|${result.error}`);
    for (const row of result.rows ?? []) console.log(`ROW|${row.name}|${row.color}|${row.got}|${row.mark}`);
    app.exit(0);
  });
}

/* ── прогрев: окно без замера ─────────────────────────────────────────── */

if (PASS === 'warmup') {
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({ fullscreen: true, frame: false, backgroundColor: '#000000' });
    await win.loadURL('data:text/html,<body style="background:#000">');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    app.exit(0);
  });
}
