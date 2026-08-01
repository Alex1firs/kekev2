/**
 * Generate the KekeRide Park Dispatch PWA icons.
 *
 * Written rather than committed as binaries nobody can regenerate: the icons
 * are a few flat shapes, and a 40-line PNG encoder over Node's built-in zlib is
 * less of a liability than an image dependency or an opaque blob.
 *
 * Android's install criteria want real PNGs at 192 and 512, plus a maskable
 * variant whose artwork sits inside the safe zone (the outer 20% can be cropped
 * to any shape the launcher likes). iOS wants a 180 apple-touch-icon with no
 * transparency.
 *
 *   node scripts/generate_dispatch_icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = [0x12, 0x16, 0x1d];      // --bg, the app's own background
const AMBER = [0xff, 0xc1, 0x07];   // --amber, the KekeRide mark
const INK = [0x14, 0x18, 0x1f];     // the dark used on top of amber

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

/** rgba is a flat Uint8Array of size*size*4. */
function encodePng(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter: none
        rgba.copy
            ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
            : Buffer.from(rgba.slice(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * The mark: an amber diamond — the same ◆ the app's header uses — on the app's
 * own background, with a rounded-square plate so it reads as an app icon rather
 * than a floating glyph.
 *
 * `safe` shrinks the artwork for maskable icons so nothing important is inside
 * the region a launcher may crop.
 */
function drawIcon(size, { maskable = false, opaqueSquare = false } = {}) {
    const px = Buffer.alloc(size * size * 4);
    const c = (size - 1) / 2;
    const plateR = size * 0.5;                          // rounded-square radius
    const corner = size * (opaqueSquare ? 0.0 : 0.22);
    const scale = maskable ? 0.60 : 0.78;               // diamond extent
    const half = (size * scale) / 2;

    const set = (i, rgb, a = 255) => { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a; };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;

            // Plate: rounded square (or full bleed for the Apple icon, which
            // must not be transparent and gets its own rounding from iOS).
            let inPlate = true;
            if (!opaqueSquare) {
                const dx = Math.max(corner - x, x - (size - 1 - corner), 0);
                const dy = Math.max(corner - y, y - (size - 1 - corner), 0);
                inPlate = Math.hypot(dx, dy) <= corner + 0.5 && plateR > 0;
            }
            if (!inPlate) { px[i + 3] = 0; continue; }
            set(i, BG);

            // Diamond: |dx| + |dy| <= half
            const dx = Math.abs(x - c), dy = Math.abs(y - c);
            const d = dx + dy;
            /*
             * A solid amber diamond, ringed. This is the same mark the app's
             * header shows (◆), so the home-screen icon and the running app
             * agree.
             *
             * An earlier version put a horizontal bar through the middle; at
             * launcher size it read as a "no entry" sign, which is the last
             * thing a dispatch tool should look like.
             */
            if (d <= half) {
                set(i, AMBER);
                if (d <= half * 0.52) set(i, INK);
                if (d <= half * 0.30) set(i, AMBER);
            }
        }
    }
    return px;
}

const OUT = path.join(__dirname, '..', '..', 'keke_dispatcher', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const targets = [
    ['icon-192.png', 192, {}],
    ['icon-512.png', 512, {}],
    ['maskable-512.png', 512, { maskable: true, opaqueSquare: true }],
    ['apple-touch-icon-180.png', 180, { opaqueSquare: true }],
    ['favicon-64.png', 64, {}],
];

for (const [name, size, opts] of targets) {
    const png = encodePng(size, drawIcon(size, opts));
    fs.writeFileSync(path.join(OUT, name), png);
    console.log(`${name.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)}kb`);
}
