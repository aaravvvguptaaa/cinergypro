'use strict';
// Layered Photoshop import: extracts the composite and each visible layer as PNGs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { app } = require('electron');

let agPsd = null;
function lib() { if (!agPsd) agPsd = require('ag-psd'); return agPsd; }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function extract(file, outDir) {
  const buf = fs.readFileSync(file);
  const doc = lib().readPsd(buf, { useImageData: true, skipThumbnail: true });
  const key = crypto.createHash('sha1').update(file + fs.statSync(file).mtimeMs).digest('hex').slice(0, 12);
  const dir = outDir || path.join(app.getPath('userData'), 'MediaCache', 'psd', key);
  fs.mkdirSync(dir, { recursive: true });
  const result = { width: doc.width, height: doc.height, composite: null, layers: [] };
  if (doc.imageData) {
    const p = path.join(dir, 'composite.png');
    fs.writeFileSync(p, encodePng(doc.imageData.data, doc.width, doc.height));
    result.composite = p;
  }
  let idx = 0;
  const visit = (layers, prefix) => {
    for (const l of layers || []) {
      if (l.children) { visit(l.children, prefix + (l.name || 'Group') + '/'); continue; }
      if (!l.imageData || l.hidden) continue;
      const w = l.imageData.width, h = l.imageData.height;
      if (!w || !h) continue;
      // Place layer on a full-canvas transparent image so positions are preserved.
      const full = new Uint8Array(doc.width * doc.height * 4);
      for (let y = 0; y < h; y++) {
        const dy = y + (l.top || 0); if (dy < 0 || dy >= doc.height) continue;
        for (let x = 0; x < w; x++) {
          const dx = x + (l.left || 0); if (dx < 0 || dx >= doc.width) continue;
          const si = (y * w + x) * 4, di = (dy * doc.width + dx) * 4;
          full[di] = l.imageData.data[si]; full[di + 1] = l.imageData.data[si + 1]; full[di + 2] = l.imageData.data[si + 2]; full[di + 3] = l.imageData.data[si + 3];
        }
      }
      const p = path.join(dir, `layer_${String(idx++).padStart(3, '0')}.png`);
      fs.writeFileSync(p, encodePng(full, doc.width, doc.height));
      result.layers.push({ name: prefix + (l.name || `Layer ${idx}`), path: p, opacity: l.opacity == null ? 1 : l.opacity, blendMode: l.blendMode || 'normal' });
    }
  };
  visit(doc.children, '');
  return result;
}

module.exports = { extract, encodePng };
