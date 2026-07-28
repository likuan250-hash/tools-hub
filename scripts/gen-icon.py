#!/usr/bin/env python3
# 纯标准库生成 build/icon.ico（蓝底白"T"几何占位图标），无需 PIL/ImageMagick。
# 内嵌单帧 PNG(256x256) 的 ICO 格式，electron-builder 可直接使用。
import zlib
import struct
import os

W = H = 256


def bg(x, y):
    t = (x + y) / (2 * (W - 1))
    r = int(64 + (10 - 64) * t)
    g = int(158 + (70 - 158) * t)
    b = int(255 + (160 - 255) * t)
    return (r, g, b, 255)


def is_T(x, y):
    v_bar = 96 <= x < 160 and 48 <= y < 208
    h_bar = 56 <= x < 200 and 48 <= y < 96
    return v_bar or h_bar


raw = bytearray()
for y in range(H):
    raw.append(0)  # filter type 0 (None)
    for x in range(W):
        if is_T(x, y):
            raw += bytes((255, 255, 255, 255))
        else:
            r, g, b, a = bg(x, y)
            raw += bytes((r, g, b, a))

sig = b"\x89PNG\r\n\x1a\n"


def chunk(typ, data):
    c = struct.pack(">I", len(data)) + typ + data
    crc = zlib.crc32(typ + data) & 0xFFFFFFFF
    c += struct.pack(">I", crc)
    return c


ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
idat = zlib.compress(bytes(raw), 9)
png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

ico = bytearray()
ico += struct.pack("<HHH", 0, 1, 1)  # reserved, type=icon, count=1
ico += struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
ico += png

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "icon.ico")
with open(out, "wb") as f:
    f.write(bytes(ico))
print("icon written:", out, len(ico), "bytes")
