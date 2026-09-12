/**
 * Generates the two PNG icons the Teams app package requires.
 *
 * Teams rejects a package without them: color.png (192x192, full colour) and
 * outline.png (32x32, white-on-transparent silhouette). Written by hand rather
 * than added as a binary asset so the package is reproducible from source.
 *
 * Usage: npx tsx scripts/make-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const ACCENT = [0x2f, 0x5b, 0xea] as const; // matches manifest accentColor

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixel data as a PNG (colour type 6, 8-bit). */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draws the StandSync mark: a ring with a gap at the top-right (the "sync"
 * motion) and a solid dot at the centre (the ticket).
 */
function drawMark(
  size: number,
  opts: {
    background?: readonly [number, number, number];
    foreground: readonly [number, number, number];
  },
): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const ringOuter = size * 0.4;
  const ringInner = size * 0.28;
  const dot = size * 0.13;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      // Angle measured so the gap sits in the upper-right quadrant.
      const angle = Math.atan2(-dy, dx);
      const inGap = angle > 0.35 && angle < 1.25;

      const onRing = dist <= ringOuter && dist >= ringInner && !inGap;
      const onDot = dist <= dot;

      if (opts.background) {
        px[i] = opts.background[0];
        px[i + 1] = opts.background[1];
        px[i + 2] = opts.background[2];
        px[i + 3] = 255;
      }

      if (onRing || onDot) {
        px[i] = opts.foreground[0];
        px[i + 1] = opts.foreground[1];
        px[i + 2] = opts.foreground[2];
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

mkdirSync('appPackage', { recursive: true });

// color.png — 192x192, white mark on the StandSync accent.
writeFileSync(
  'appPackage/color.png',
  encodePng(192, 192, drawMark(192, { background: ACCENT, foreground: [255, 255, 255] })),
);

// outline.png — 32x32, white mark on transparent (Teams tints this itself).
writeFileSync(
  'appPackage/outline.png',
  encodePng(32, 32, drawMark(32, { foreground: [255, 255, 255] })),
);

console.log('Wrote appPackage/color.png (192x192) and appPackage/outline.png (32x32)');
