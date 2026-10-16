/**
 * Проба: растягивает ли Chromium безрамочное окно за край САМ (ввод подаём XTEST).
 * Позицию окна берём со снимка экрана: без этого не знаем, куда целится жест.
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { writeFileSync } = require('node:fs');

app.commandLine.appendSwitch('ozone-platform', 'x11');

/** Где окно на экране: ищем яркую накладку, которую сами и рисуем. */
async function windowBox(w) {
  await w.webContents.executeJavaScript(
    `(() => {
       const layer = document.createElement('div');
       layer.id = 'probe-layer';
       layer.style.cssText = 'position:fixed;inset:0;background:#ff00ff;z-index:2147483647';
       document.body.appendChild(layer);
     })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const { size } = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const image = sources[0]?.thumbnail.toBitmap() ?? [];
  const { width, height } = sources[0]?.thumbnail.getSize() ?? { width: 0, height: 0 };
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (image[i + 2] > 200 && image[i + 1] < 60 && image[i] > 200) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  await w.webContents.executeJavaScript(`document.getElementById('probe-layer')?.remove()`);
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    x: 600,
    y: 400,
    width: 800,
    height: 600,
    show: true,
    frame: false,
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  w.setMinimumSize(400, 300);
  await w.loadURL(
    'data:text/html,<body style="margin:0;background:#123"><div style="height:36px;background:#333;-webkit-app-region:drag">шапка</div></body>',
  );
  w.moveTop();
  w.focus();
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const box = await windowBox(w);
  const target = box ? { x: Math.round(box.x + box.width / 2), y: box.y + 1 } : null;
  writeFileSync('/tmp/probe-target.json', JSON.stringify(target ?? {}));
  console.log(`[x11] getBounds ${JSON.stringify(w.getBounds())} окно на экране ${JSON.stringify(box)}`);
  console.log(`[x11] целимся в верхнюю кромку: ${JSON.stringify(target)}`);

  const before = w.getBounds();
  let last = JSON.stringify(before);
  const timer = setInterval(() => {
    const text = JSON.stringify(w.getBounds());
    if (text !== last) {
      console.log('[x11] стало', text);
      last = text;
    }
  }, 200);

  setTimeout(() => {
    clearInterval(timer);
    const after = w.getBounds();
    console.log(
      `[x11] итог: сдвиг y ${before.y - after.y}, прирост высоты ${after.height - before.height} (${before.height} → ${after.height})`,
    );
    w.destroy();
    app.exit(0);
  }, 16_000);
});
