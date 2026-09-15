"""Generate extension icons (16/48/128) without external deps: navy rounded square,
orange download arrow + tray. Rendered at 384px (LCM of 16/48/128) and box-downsampled."""
import struct, zlib, os

BASE = 384
NAVY = (0x23, 0x2F, 0x3E)
ORANGE = (0xFF, 0x99, 0x00)
WHITE = (0xFF, 0xFF, 0xFF)


def inside(x, y):
    """Return RGBA for a point in [0,BASE) coordinates."""
    s = BASE / 128.0
    # rounded square, radius 24 (in 128-space)
    r = 24 * s
    cx = min(max(x, r), BASE - r)
    cy = min(max(y, r), BASE - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return (0, 0, 0, 0)
    col = NAVY
    # arrow shaft: x 54..74, y 24..66 (128-space)
    if 54 * s <= x < 74 * s and 24 * s <= y < 66 * s:
        col = ORANGE
    # arrow head: triangle apex (64,90), base y=62 from x=34..94
    if 62 * s <= y <= 90 * s:
        t = (y - 62 * s) / (28 * s)  # 0 at base .. 1 at apex
        half = 30 * s * (1 - t)
        if abs(x - 64 * s) <= half:
            col = ORANGE
    # tray: rect x 28..100, y 96..108
    if 28 * s <= x < 100 * s and 96 * s <= y < 108 * s:
        col = WHITE
    return col + (255,)


def render():
    return [[inside(x + 0.5, y + 0.5) for x in range(BASE)] for y in range(BASE)]


def downsample(img, size):
    k = BASE // size
    rows = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            acc = [0, 0, 0, 0]
            for yy in range(oy * k, (oy + 1) * k):
                for xx in range(ox * k, (ox + 1) * k):
                    p = img[yy][xx]
                    a = p[3]
                    acc[0] += p[0] * a; acc[1] += p[1] * a; acc[2] += p[2] * a; acc[3] += a
            n = k * k
            if acc[3]:
                row += bytes((acc[0] // acc[3], acc[1] // acc[3], acc[2] // acc[3], acc[3] // n))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    img = render()
    for sz in (16, 48, 128):
        with open(os.path.join(out, f"icon{sz}.png"), "wb") as f:
            f.write(png(sz, downsample(img, sz)))
        print("wrote icon%d.png" % sz)
