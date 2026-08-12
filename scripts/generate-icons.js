// יוצר את אייקוני ה-PWA (PNG אמיתיים) בלי שום ספריית תמונות חיצונית -
// רק zlib המובנה של Node כדי לדחוס את נתוני ה-PNG. מריצים פעם אחת:
//   npm run icons
// התוצאה: public/icons/icon-192.png, icon-512.png (וגרסאות maskable).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "public", "icons");
const BG = [108, 92, 231, 255]; // #6c5ce7

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255];
}

function renderIcon(size, { maskable }) {
  const data = new Uint8Array(size * size * 4);
  const cornerRadius = maskable ? 0 : size * 0.18;

  const setPx = (x, y, rgba) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
  };

  const insideRoundedRect = (x, y) => {
    if (maskable || cornerRadius <= 0) return true;
    const nx = x < cornerRadius ? cornerRadius : x > size - cornerRadius ? size - cornerRadius : x;
    const ny = y < cornerRadius ? cornerRadius : y > size - cornerRadius ? size - cornerRadius : y;
    if ((x < cornerRadius || x > size - cornerRadius) && (y < cornerRadius || y > size - cornerRadius)) {
      const dx = x - nx, dy = y - ny;
      return dx * dx + dy * dy <= cornerRadius * cornerRadius;
    }
    return true;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRoundedRect(x, y)) setPx(x, y, BG);
      else setPx(x, y, [0, 0, 0, 0]);
    }
  }

  // "שרבוט" צבעוני - קו גלי בקשת צבעים, מדמה ציור חופשי
  const cx = size / 2, cy = size / 2;
  const w = size * 0.62;
  const amp = size * 0.13;
  const strokeR = Math.max(3, size * 0.05);
  const steps = Math.ceil((w * 2.4) / (strokeR * 0.5));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = cx - w / 2 + t * w;
    const py = cy + amp * (Math.sin(t * Math.PI * 2 * 2) * 0.6 + Math.sin(t * Math.PI * 2 * 3.7 + 1) * 0.4);
    const hue = 300 - t * 280; // מאדום לסגול דרך הקשת
    const color = hsvToRgb(hue < 0 ? hue + 360 : hue, 0.75, 0.95);

    const r = Math.ceil(strokeR);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > strokeR * strokeR) continue;
        const x = Math.round(px + dx), y = Math.round(py + dy);
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        if (!maskable && !insideRoundedRect(x, y)) continue;
        setPx(x, y, color);
      }
    }
  }

  return data;
}

// ---------- מקודד PNG מינימלי ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIcon(size, maskable) {
  const rgba = renderIcon(size, { maskable });
  const png = encodePNG(size, size, rgba);
  const name = `icon-${size}${maskable ? "-maskable" : ""}.png`;
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log("נוצר:", name);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
[192, 512].forEach((size) => {
  writeIcon(size, false);
  writeIcon(size, true);
});
