"use strict";
/**
 * Generates a 128x128 PNG icon with no dependencies.
 * Shapes are defined as signed-distance tests and supersampled 4x4 per pixel,
 * which gives clean anti-aliased edges at small sizes.
 */
const fs = require("fs");
const zlib = require("zlib");

const SIZE = 128;
const SS = 4; // supersampling factor

/* ---------------- colors ---------------- */
const BG = [16, 42, 56];        // deep slate blue
const CHECK = [45, 212, 143];   // mint green
const BRACKET = [72, 104, 124];  // dim steel, sits behind the check

/* ---------------- geometry helpers ---------------- */
function roundedRect(x, y, w, h, r) {
    return (px, py) => {
        const cx = Math.min(Math.max(px, x + r), x + w - r);
        const cy = Math.min(Math.max(py, y + r), y + h - r);
        const dx = px - cx, dy = py - cy;
        if (px >= x + r && px <= x + w - r) return py >= y && py <= y + h;
        if (py >= y + r && py <= y + h - r) return px >= x && px <= x + w;
        return dx * dx + dy * dy <= r * r;
    };
}

/** Distance from point to a line segment, for round-capped strokes. */
function segDist(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = px - x1, wy = py - y1;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - (x1 + t * vx), dy = py - (y1 + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
}

function stroke(points, width) {
    const hw = width / 2;
    return (px, py) => {
        for (let i = 0; i < points.length - 1; i++) {
            const [x1, y1] = points[i], [x2, y2] = points[i + 1];
            if (segDist(px, py, x1, y1, x2, y2) <= hw) return true;
        }
        return false;
    };
}

/* ---------------- the icon ---------------- */
const bg = roundedRect(0, 0, SIZE, SIZE, 26);
// A check mark: the review passed
const check = stroke([[40, 68], [57, 85], [90, 42]], 15);
// Angle brackets flanking it: this is about code
const bracketL = stroke([[34, 44], [20, 64], [34, 84]], 8);
const bracketR = stroke([[94, 44], [108, 64], [94, 84]], 8);

const layers = [
    { hit: bg, color: BG },
    { hit: bracketL, color: BRACKET },
    { hit: bracketR, color: BRACKET },
    { hit: check, color: CHECK },
];

/* ---------------- render with supersampling ---------------- */
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const fx = x + (sx + 0.5) / SS;
                const fy = y + (sy + 0.5) / SS;
                let cr = 0, cg = 0, cb = 0, ca = 0;
                for (const layer of layers) {
                    if (layer.hit(fx, fy)) {
                        cr = layer.color[0]; cg = layer.color[1]; cb = layer.color[2]; ca = 255;
                    }
                }
                r += cr; g += cg; b += cb; a += ca;
            }
        }
        const n = SS * SS;
        const i = (y * SIZE + x) * 4;
        px[i] = Math.round(r / n);
        px[i + 1] = Math.round(g / n);
        px[i + 2] = Math.round(b / n);
        px[i + 3] = Math.round(a / n);
    }
}

/* ---------------- ASCII preview (sanity check the composition) ---------------- */
const ramp = " .:-=+*#%@";
let preview = "";
for (let y = 0; y < SIZE; y += 4) {
    let line = "";
    for (let x = 0; x < SIZE; x += 2) {
        const i = (y * SIZE + x) * 4;
        const alpha = px[i + 3] / 255;
        const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255 * alpha;
        line += ramp[Math.min(ramp.length - 1, Math.round(lum * (ramp.length - 1)))];
    }
    preview += line + "\n";
}
console.log(preview);

/* ---------------- PNG encoding ---------------- */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filtering
ihdr[12] = 0;  // no interlace

// Raw scanlines, each prefixed with filter type 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
]);

const out = "c:/Users/TAR/Desktop/Themes-Review/salla-theme-reviewer/icon.png";
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
