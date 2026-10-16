"""Настоящий ввод через XTEST: тянем верхний край окна вверх.

Синтетические события Electron (`sendInputEvent`) до оконного менеджера не доходят,
поэтому для проверки нативного растягивания нужен именно XTEST.
"""

import ctypes
import sys
import time

xlib = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")

xlib.XOpenDisplay.restype = ctypes.c_void_p
display = ctypes.c_void_p(xlib.XOpenDisplay(None))
if not display.value:
    print("нет дисплея")
    sys.exit(1)


def move(x: int, y: int) -> None:
    xtst.XTestFakeMotionEvent(display, -1, int(x), int(y), 0)
    xlib.XFlush(display)


def button(press: bool) -> None:
    xtst.XTestFakeButtonEvent(display, 1, 1 if press else 0, 0)
    xlib.XFlush(display)


x = int(sys.argv[1])
y = int(sys.argv[2])
steps = int(sys.argv[3]) if len(sys.argv) > 3 else 8
step = int(sys.argv[4]) if len(sys.argv) > 4 else 10

# Курсор — у самой верхней кромки окна, середина по ширине.
move(x, y)
time.sleep(0.4)
button(True)
time.sleep(0.4)
for i in range(1, steps + 1):
    move(x, y - i * step)
    time.sleep(0.15)
time.sleep(0.3)
button(False)
print(f"жест: ({x}, {y}) → ({x}, {y - steps * step})")
