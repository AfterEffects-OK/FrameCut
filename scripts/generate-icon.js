const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const size = 512;
const pixels = Buffer.alloc(size * size * 4);

function pixel(x, y, color) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (y * size + x) * 4;
  const alpha = color[3] / 255;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(color[channel] * alpha + pixels[index + channel] * (1 - alpha));
  }
  pixels[index + 3] = 255;
}

function ellipse(cx, cy, rx, ry, color) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      if (((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1) pixel(x, y, color);
    }
  }
}

function ellipseRing(cx, cy, rx, ry, thickness, color) {
  for (let y = Math.floor(cy - ry - thickness); y <= Math.ceil(cy + ry + thickness); y += 1) {
    for (let x = Math.floor(cx - rx - thickness); x <= Math.ceil(cx + rx + thickness); x += 1) {
      const outer = ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2);
      const inner = ((x - cx) ** 2) / ((rx - thickness) ** 2) + ((y - cy) ** 2) / ((ry - thickness) ** 2);
      if (outer <= 1 && inner >= 1) pixel(x, y, color);
    }
  }
}

function roundedRect(x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const lx = px - x;
      const ly = py - y;
      let outside = false;
      if (lx < radius && ly < radius) outside = (radius - lx) ** 2 + (radius - ly) ** 2 > radius ** 2;
      if (lx >= w - radius && ly < radius) outside = (lx - (w - radius)) ** 2 + (radius - ly) ** 2 > radius ** 2;
      if (lx < radius && ly >= h - radius) outside = (radius - lx) ** 2 + (ly - (h - radius)) ** 2 > radius ** 2;
      if (lx >= w - radius && ly >= h - radius) outside = (lx - (w - radius)) ** 2 + (ly - (h - radius)) ** 2 > radius ** 2;
      if (!outside) pixel(px, py, color);
    }
  }
}

function line(x1, y1, x2, y2, thickness, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(length);
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    ellipse(x1 + dx * t, y1 + dy * t, thickness / 2, thickness / 2, color);
  }
}

function polygon(points, color) {
  let minY = size;
  let maxY = 0;
  points.forEach(point => {
    minY = Math.min(minY, point[1]);
    maxY = Math.max(maxY, point[1]);
  });
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += 1) {
    const intersections = [];
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        intersections.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      for (let x = Math.ceil(intersections[index]); x <= Math.floor(intersections[index + 1]); x += 1) pixel(x, y, color);
    }
  }
}

const dark = [16, 18, 17, 255];
const lime = [183, 243, 107, 255];
const white = [238, 245, 234, 255];
const film = [185, 196, 188, 255];
const frame = [17, 20, 17, 255];

roundedRect(0, 0, 512, 512, 112, [29, 35, 30, 255]);
roundedRect(54, 78, 404, 356, 54, [23, 27, 24, 255]);

roundedRect(62, 88, 388, 136, 18, frame);
roundedRect(78, 108, 356, 96, 10, film);
for (let x = 78; x <= 414; x += 48) {
  roundedRect(x, 92, 28, 18, 5, lime);
  roundedRect(x, 202, 28, 18, 5, lime);
}

polygon([[256,292],[84,128],[126,198],[256,334]], dark);
polygon([[256,292],[92,136],[126,198],[256,334]], white);
polygon([[256,292],[428,128],[386,198],[256,334]], dark);
polygon([[256,292],[420,136],[386,198],[256,334]], white);

ellipse(256,292,34,34,dark);
ellipseRing(256,292,34,34,12,lime);
ellipse(256,292,10,10,white);

ellipse(178,398,70,70,dark);
ellipseRing(178,398,70,70,18,lime);
ellipse(334,398,70,70,dark);
ellipseRing(334,398,70,70,18,lime);
ellipse(178,398,23,23,lime);
ellipse(334,398,23,23,lime);

line(186,342,256,292,26,lime);
line(326,342,256,292,26,lime);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([length, Buffer.from(type), data, check]);
}

function createPng(outputSize) {
  const raw = Buffer.alloc((outputSize * 4 + 1) * outputSize);
  for (let y = 0; y < outputSize; y += 1) {
    const sourceY = Math.min(size - 1, Math.floor(y * size / outputSize));
    raw[y * (outputSize * 4 + 1)] = 0;
    for (let x = 0; x < outputSize; x += 1) {
      const sourceX = Math.min(size - 1, Math.floor(x * size / outputSize));
      const sourceIndex = (sourceY * size + sourceX) * 4;
      const targetIndex = y * (outputSize * 4 + 1) + 1 + x * 4;
      pixels.copy(raw, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(outputSize, 0);
  header.writeUInt32BE(outputSize, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outputDir = path.join(__dirname, '..', 'public');
const png512 = createPng(512);
fs.writeFileSync(path.join(outputDir, 'app-icon-512.png'), png512);
fs.writeFileSync(path.join(outputDir, 'app-icon-180.png'), createPng(180));
fs.writeFileSync(path.join(outputDir, 'favicon-32.png'), createPng(32));
fs.writeFileSync(path.join(outputDir, 'favicon-16.png'), createPng(16));

const sizes = [256, 64, 48, 32, 16].map(sizeValue => ({ size: sizeValue, png: createPng(sizeValue) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + sizes.length * 16;
sizes.forEach(item => {
  const entry = Buffer.alloc(16);
  entry[0] = item.size === 256 ? 0 : item.size;
  entry[1] = item.size === 256 ? 0 : item.size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(item.png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += item.png.length;
});
fs.writeFileSync(path.join(outputDir, 'app-icon.ico'), Buffer.concat([header, ...entries, ...sizes.map(item => item.png)]));
console.log('Generated film-cutting app icon');
