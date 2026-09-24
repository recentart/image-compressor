'use strict';

// Compression engine. Runs in a Web Worker so the page stays responsive.
// Input: an ImageBitmap, a mode and a target size in bytes. Nothing here touches the network.
//
// Search order, as agreed for this app:
//   1. At full size, find the best quality that fits the target.
//   2. If even the lowest quality is too big, step the dimensions down (never below 25%)
//      and repeat.
//   3. If nothing fits, report the smallest result so the page can explain why.
//
// Modes:
//   jpeg / webp  quality 92 down to 50 (browser encoder)
//   png          lossless PNG only (our encoder or the browser's, whichever is smaller)
//   palette      lossless PNG, then 256, 128 or 64 colors
//   (PNG input with the "Convert to WebP" option simply uses the webp mode)

const SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.33, 0.25];
const LOSSY_LADDER = [];
for (let q = 92; q >= 50; q -= 2) LOSSY_LADDER.push(q);
const PALETTE_LADDER = [0, 256, 128, 64];  // 0 = lossless
const TOO_LARGE = 'This image is too large for your browser to process.';

self.onmessage = async ({ data: job }) => {
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      throw userError('This browser is too old to compress images here. Please update it.');
    }
    if ((job.mode === 'png' || job.mode === 'palette') && typeof CompressionStream === 'undefined') {
      throw userError("This browser can't create optimized PNG files. Please update it.");
    }
    const result = await compress(job);
    self.postMessage({ type: 'done', ...result });
  } catch (err) {
    console.error(err);
    const message = err && err.userFacing ? err.message
      : 'Something went wrong while compressing this image. It may be too large for this browser.';
    self.postMessage({ type: 'error', message });
  } finally {
    job.bitmap.close();
  }
};

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

async function compress({ bitmap, mode, target }) {
  const lossy = mode === 'jpeg' || mode === 'webp';
  const ladder = lossy ? LOSSY_LADDER : mode === 'palette' ? PALETTE_LADDER : [0];
  let smallest = null;

  for (let s = 0; s < SCALES.length; s++) {
    const scale = SCALES[s];
    const width = scaleDim(bitmap.width, scale);
    const height = scaleDim(bitmap.height, scale);
    const canvas = drawScaled(bitmap, width, height);
    try {
      const encode = lossy ? lossyEncoder(canvas, `image/${mode}`) : pngEncoder(canvas);
      const results = [];
      const fits = async (i) => {
        if (!results[i]) {
          post({ type: 'progress', text: `${Math.round(scale * 100)}% size, ${levelName(mode, ladder[i])}…`, fraction: s / SCALES.length });
          results[i] = await encode(ladder[i]);
          if (!smallest || results[i].size < smallest.size) smallest = { size: results[i].size, scale, width, height };
        }
        return results[i].size <= target;
      };

      // Lowest quality first: if even that is too big, this size can't work.
      let hi = ladder.length - 1;
      if (!(await fits(hi))) continue;
      // Otherwise binary-search the ladder for the best quality that still fits.
      let lo = 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (await fits(mid)) hi = mid;
        else lo = mid + 1;
      }
      return { ok: true, blob: results[hi], width, height, scale, level: ladder[hi] };
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  return { ok: false, smallest };
}

function post(message) {
  self.postMessage(message);
}

function levelName(mode, level) {
  if (mode === 'jpeg' || mode === 'webp') return `quality ${level}`;
  return level ? `${level} colors` : 'lossless';
}

// Never below 25%: ceil keeps e.g. 9 px × 0.25 at 3 px, not 2.
function scaleDim(n, scale) {
  return Math.max(1, Math.ceil(n * scale - 1e-9));
}

// Halve first, then draw to the exact size: one big downscale in a single drawImage can alias.
function drawScaled(bitmap, width, height) {
  let src = bitmap;
  let w = bitmap.width;
  let h = bitmap.height;
  while (w / 2 >= width && h / 2 >= height) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    src = paint(src, w, h);
  }
  return paint(src, width, height);
}

function paint(src, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw userError(TOO_LARGE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

function lossyEncoder(canvas, type) {
  return async (quality) => {
    const blob = await canvas.convertToBlob({ type, quality: quality / 100 });
    // Browsers that can't write a format silently return PNG instead.
    if (blob.type !== type) {
      throw userError(`This browser can't create ${type === 'image/webp' ? 'WebP' : 'JPEG'} files. Chrome, Edge and Firefox can.`);
    }
    return blob;
  };
}

// ---------- PNG ----------

function pngEncoder(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const info = analyze(img);
  let lossless = null;
  let hist = null;
  return async (colors) => {
    if (!colors || (info.palette && info.palette.size <= colors)) {
      if (!lossless) {
        const ours = await encodeLossless(img, info);
        const browsers = await canvas.convertToBlob({ type: 'image/png' });
        lossless = browsers.size < ours.size ? browsers : ours;
      }
      return lossless;
    }
    if (!hist) hist = histogram(img.data);
    const { palette, lut } = quantize(hist, colors);
    return encodeIndexed(img.width, img.height, palette, mapPixels(img.data, lut));
  };
}

// Which PNG color type can hold this image exactly: palette (≤256 colors), gray, RGB or RGBA.
function analyze({ data }) {
  const px = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  let opaque = true;
  let gray = true;
  let palette = new Map();
  let prev = -1;
  for (let i = 0; i < px.length; i++) {
    const v = px[i];
    if (v === prev) continue;
    prev = v;
    if (v >>> 24 !== 255) opaque = false;
    const r = v & 255;
    if (r !== ((v >>> 8) & 255) || r !== ((v >>> 16) & 255)) gray = false;
    if (palette && !palette.has(v)) {
      if (palette.size === 256) palette = null;
      else palette.set(v, 0);
    }
  }
  return { px, opaque, gray, palette };
}

async function encodeLossless({ width, height, data }, { px, opaque, gray, palette }) {
  if (palette) {
    // Translucent entries first keeps the tRNS chunk short.
    const colors = [...palette.keys()].sort((x, y) => (x >>> 24) - (y >>> 24));
    const index = new Map(colors.map((c, i) => [c, i]));
    const indices = new Uint8Array(px.length);
    for (let i = 0, prev = -1, idx = 0; i < px.length; i++) {
      if (px[i] !== prev) { prev = px[i]; idx = index.get(prev); }
      indices[i] = idx;
    }
    return encodeIndexed(width, height, Uint32Array.from(colors), indices);
  }
  const channels = (gray ? 1 : 3) + (opaque ? 0 : 1);
  const raw = new Uint8Array(width * height * channels);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    raw[j++] = data[i];
    if (!gray) { raw[j++] = data[i + 1]; raw[j++] = data[i + 2]; }
    if (!opaque) raw[j++] = data[i + 3];
  }
  const colorType = gray ? (opaque ? 0 : 4) : (opaque ? 2 : 6);
  const idat = await deflate(filterRows(raw, width * channels, height, channels));
  return pngBlob(width, height, 8, colorType, idat);
}

// Palette PNG. Small palettes are packed into 1, 2 or 4 bits per pixel. No row filters,
// which is the usual best choice for palette images.
async function encodeIndexed(width, height, colors, indices) {
  const n = colors.length;
  const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const rowBytes = Math.ceil(width / perByte);
  const raw = new Uint8Array((rowBytes + 1) * height);  // each row starts with filter type 0
  for (let y = 0; y < height; y++) {
    const out = y * (rowBytes + 1) + 1;
    const row = y * width;
    if (depth === 8) {
      raw.set(indices.subarray(row, row + width), out);
    } else {
      for (let x = 0; x < width; x++) {
        raw[out + Math.floor(x / perByte)] |= indices[row + x] << (8 - depth * (x % perByte + 1));
      }
    }
  }
  const plte = new Uint8Array(n * 3);
  let translucent = 0;
  for (let i = 0; i < n; i++) {
    const v = colors[i];
    plte[i * 3] = v & 255;
    plte[i * 3 + 1] = (v >>> 8) & 255;
    plte[i * 3 + 2] = (v >>> 16) & 255;
    if (v >>> 24 !== 255) translucent = i + 1;
  }
  const trns = new Uint8Array(translucent);
  for (let i = 0; i < translucent; i++) trns[i] = colors[i] >>> 24;
  return pngBlob(width, height, depth, 3, await deflate(raw), plte, trns);
}

// Per row, pick the PNG filter with the smallest sum of absolute differences (the libpng heuristic).
function filterRows(raw, rowBytes, height, bpp) {
  const out = new Uint8Array((rowBytes + 1) * height);
  const zero = new Uint8Array(rowBytes);
  const trial = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const cur = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const up = y ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : zero;
    const at = y * (rowBytes + 1);
    let bestType = 0;
    let bestCost = rowCost(cur);
    out.set(cur, at + 1);
    for (let type = 1; type <= 4; type++) {
      applyFilter(type, cur, up, bpp, trial);
      const cost = rowCost(trial);
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
        out.set(trial, at + 1);
      }
    }
    out[at] = bestType;
  }
  return out;
}

function rowCost(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += row[i] < 128 ? row[i] : 256 - row[i];
  return sum;
}

function applyFilter(type, cur, up, bpp, out) {
  const n = cur.length;
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - up[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + up[i]) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = up[i];
      const c = i >= bpp ? up[i - bpp] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      out[i] = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function pngBlob(width, height, depth, colorType, idat, plte, trns) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colorType;  // compression, filter and interlace bytes stay 0
  const parts = [PNG_SIGNATURE, ...chunk('IHDR', ihdr)];
  if (plte) parts.push(...chunk('PLTE', plte));
  if (trns && trns.length) parts.push(...chunk('tRNS', trns));
  parts.push(...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

function chunk(type, data) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const crc = crc32(data, crc32(head.subarray(4), -1));
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, (crc ^ -1) >>> 0);
  return [head, data, tail];
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});

function crc32(bytes, crc) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc;
}

// ---------- Color reduction (median cut, refined with k-means) ----------

// Colors are grouped into 5-bit-per-channel buckets, which keeps the work proportional to
// the number of distinct colors rather than the number of pixels.
const bucketOf = (r, g, b, a) => ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
const ALPHA_WEIGHT = 2;  // counts alpha double so opaque and translucent pixels don't share a color

function histogram(data) {
  const count = new Uint32Array(1 << 20);
  const sum = new Float64Array(4 << 20);
  for (let i = 0; i < data.length; i += 4) {
    const k = bucketOf(data[i], data[i + 1], data[i + 2], data[i + 3]);
    count[k]++;
    sum[k * 4] += data[i];
    sum[k * 4 + 1] += data[i + 1];
    sum[k * 4 + 2] += data[i + 2];
    sum[k * 4 + 3] += data[i + 3];
  }
  let n = 0;
  for (let k = 0; k < count.length; k++) if (count[k]) n++;
  const keys = new Uint32Array(n);
  const weight = new Float64Array(n);
  const color = new Float64Array(n * 4);
  for (let k = 0, j = 0; k < count.length; k++) {
    if (!count[k]) continue;
    keys[j] = k;
    weight[j] = count[k];
    color[j * 4] = sum[k * 4] / count[k];
    color[j * 4 + 1] = sum[k * 4 + 1] / count[k];
    color[j * 4 + 2] = sum[k * 4 + 2] / count[k];
    color[j * 4 + 3] = (sum[k * 4 + 3] / count[k]) * ALPHA_WEIGHT;
    j++;
  }
  return { keys, weight, color };
}

function quantize({ keys, weight, color }, maxColors) {
  const n = keys.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  // Median cut: keep splitting the box with the most color error at its weighted median.
  const boxes = [makeBox(order, 0, n, weight, color)];
  while (boxes.length < maxColors) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.end - b.start > 1 && b.error > 0 && (pick < 0 || b.error > boxes[pick].error)) pick = i;
    }
    if (pick < 0) break;
    const { start, end, axis, total } = boxes[pick];
    order.subarray(start, end).sort((x, y) => color[x * 4 + axis] - color[y * 4 + axis]);
    let cut = end - 1;
    for (let i = start, acc = 0; i < end - 1; i++) {
      acc += weight[order[i]];
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    boxes[pick] = makeBox(order, start, cut, weight, color);
    boxes.push(makeBox(order, cut, end, weight, color));
  }

  // Refine: two k-means passes, then a final assignment.
  const m = boxes.length;
  const pal = new Float64Array(m * 4);
  boxes.forEach((b, i) => pal.set(b.mean, i * 4));
  const assign = new Uint8Array(n);
  for (let pass = 0; ; pass++) {
    for (let j = 0; j < n; j++) assign[j] = nearest(pal, m, color, j * 4);
    if (pass === 2) break;
    const sums = new Float64Array(m * 5);
    for (let j = 0; j < n; j++) {
      const p = assign[j] * 5;
      const w = weight[j];
      for (let c = 0; c < 4; c++) sums[p + c] += color[j * 4 + c] * w;
      sums[p + 4] += w;
    }
    for (let p = 0; p < m; p++) {
      const w = sums[p * 5 + 4];
      if (w) for (let c = 0; c < 4; c++) pal[p * 4 + c] = sums[p * 5 + c] / w;
    }
  }

  // Final palette: rounded, unused entries dropped, translucent entries first.
  const used = new Uint8Array(m);
  for (let j = 0; j < n; j++) used[assign[j]] = 1;
  const entries = [];
  for (let p = 0; p < m; p++) {
    if (!used[p]) continue;
    const r = Math.round(pal[p * 4]);
    const g = Math.round(pal[p * 4 + 1]);
    const b = Math.round(pal[p * 4 + 2]);
    const a = Math.min(255, Math.round(pal[p * 4 + 3] / ALPHA_WEIGHT));
    entries.push({ p, a, value: ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 });
  }
  entries.sort((x, y) => x.a - y.a);
  const remap = new Uint8Array(m);
  entries.forEach((e, i) => { remap[e.p] = i; });
  const lut = new Uint8Array(1 << 20);
  for (let j = 0; j < n; j++) lut[keys[j]] = remap[assign[j]];
  return { palette: Uint32Array.from(entries, (e) => e.value), lut };
}

function makeBox(order, start, end, weight, color) {
  let total = 0;
  const sum = [0, 0, 0, 0];
  const sq = [0, 0, 0, 0];
  for (let i = start; i < end; i++) {
    const j = order[i];
    const w = weight[j];
    total += w;
    for (let c = 0; c < 4; c++) {
      const v = color[j * 4 + c];
      sum[c] += v * w;
      sq[c] += v * v * w;
    }
  }
  const mean = sum.map((s) => s / total);
  const spread = sq.map((q, c) => q - sum[c] * mean[c]);
  const axis = spread.indexOf(Math.max(...spread));
  return { start, end, total, mean, axis, error: spread[0] + spread[1] + spread[2] + spread[3] };
}

function nearest(pal, m, color, o) {
  const r = color[o], g = color[o + 1], b = color[o + 2], a = color[o + 3];
  let best = 0;
  let bestDist = Infinity;
  for (let p = 0, q = 0; p < m; p++, q += 4) {
    const dr = pal[q] - r, dg = pal[q + 1] - g, db = pal[q + 2] - b, da = pal[q + 3] - a;
    const d = dr * dr + dg * dg + db * db + da * da;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function mapPixels(data, lut) {
  const out = new Uint8Array(data.length >> 2);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = lut[bucketOf(data[i], data[i + 1], data[i + 2], data[i + 3])];
  }
  return out;
}
