'use strict';

// Page logic: file selection, settings and results. The compression itself runs in worker.js.

const KB = 1000;
const MB = KB * KB;
const MAX_PIXELS = 100e6;
const FORMATS = {
  'image/jpeg': { name: 'JPEG', ext: 'jpg' },
  'image/png': { name: 'PNG', ext: 'png' },
  'image/webp': { name: 'WebP', ext: 'webp' },
};

const $ = (id) => document.getElementById(id);
const ui = {
  drop: $('drop'), dropTitle: $('drop-title'), input: $('file'), fileMessage: $('file-message'),
  editor: $('editor'), info: $('info'), form: $('settings'),
  custom: $('custom'), customValue: $('custom-value'), customUnit: $('custom-unit'), customError: $('custom-error'),
  pngOptions: $('png-options'), pngWebp: $('png-webp'), pngWebpHint: $('png-webp-hint'), compress: $('compress'),
  status: $('status'), statusText: $('status-text'), statusDetail: $('status-detail'), progress: $('progress'),
  outcome: $('outcome'), result: $('result'), resultHeading: $('result-heading'), resultNotes: $('result-notes'),
  resultFacts: $('result-facts'), download: $('download'), another: $('another'), live: $('live'),
};
const DROP_TITLE = ui.dropTitle.textContent;

let current = null;     // { file, type, width, height, animated, img, url }
let generation = 0;     // bumped by every new action so stale async work can tell it is stale
let worker = null;
let downloadUrl = null;

const canEncodeWebp = (() => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
})();
if (!canEncodeWebp) {
  ui.pngWebp.disabled = true;
  ui.pngWebpHint.textContent = "This browser can't create WebP files. Chrome, Edge and Firefox can.";
}

// ---------- Choosing a file ----------

ui.drop.addEventListener('click', () => ui.input.click());
ui.another.addEventListener('click', () => ui.input.click());
ui.input.addEventListener('change', () => {
  const file = ui.input.files[0];
  ui.input.value = '';  // so choosing the same file again still fires "change"
  if (file) openFile(file);
});

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
function setDragging(on) {
  ui.drop.classList.toggle('dragging', on);
  ui.dropTitle.textContent = on ? 'Drop the image to open it' : DROP_TITLE;
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) setDragging(true);
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); }
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const files = e.dataTransfer.files;
  if (!files.length) return;
  await openFile(files[0]);
  if (files.length > 1 && current && current.file === files[0]) {
    showFileMessage('warn', `One image at a time: using “${files[0].name}”.`);
  }
});

async function openFile(file) {
  stopWork();
  clearResult();
  releaseImage();
  const gen = generation;
  showFileMessage('', '');
  ui.editor.hidden = true;
  ui.drop.classList.remove('compact');

  let head;
  try {
    head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  } catch {
    if (gen === generation) showFileMessage('error', `“${file.name}” couldn't be read.`);
    return;
  }
  if (gen !== generation) return;

  const type = sniff(head);
  if (!type) return showFileMessage('error', unsupportedMessage(file));

  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    // The load event rather than img.decode(): Chrome holds decode() back while the tab is hidden.
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    // "load" only needs the header; a full decode catches files that are cut off or damaged.
    (await createImageBitmap(img)).close();
  } catch {
    URL.revokeObjectURL(url);
    if (gen === generation) {
      showFileMessage('error', `“${file.name}” couldn't be opened. The file may be damaged, incomplete, or too large for this browser.`);
    }
    return;
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (gen !== generation || !width || !height) {
    URL.revokeObjectURL(url);
    if (gen === generation) showFileMessage('error', `“${file.name}” couldn't be opened. The file may be damaged.`);
    return;
  }
  if (width * height > MAX_PIXELS) {
    URL.revokeObjectURL(url);
    return showFileMessage('error', `This image is ${Math.round(width * height / 1e6)} megapixels, too large to process in a browser tab. The limit is 100 megapixels.`);
  }

  current = { file, type, width, height, img, url, animated: isAnimated(head, type) };
  renderFacts(ui.info, [
    ['File name', file.name],
    ['Dimensions', `${width} × ${height} px`],
    ['File size', formatBytes(file.size)],
    ['Format', FORMATS[type].name],
  ]);
  ui.pngOptions.hidden = type !== 'image/png';
  ui.editor.hidden = false;
  ui.drop.classList.add('compact');
  announce(`Opened ${file.name}: ${width} by ${height} pixels, ${formatBytes(file.size)}.`);
}

function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Animated PNGs have an acTL chunk before the first IDAT; animated WebPs set a flag in VP8X.
function isAnimated(b, type) {
  if (type === 'image/webp') return ascii(b, 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0;
  if (type !== 'image/png') return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 8; p + 8 <= b.length; p += 12 + view.getUint32(p)) {
    const name = ascii(b, p + 4, p + 8);
    if (name === 'acTL') return true;
    if (name === 'IDAT') return false;
  }
  return false;
}

function ascii(bytes, from, to) {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function unsupportedMessage(file) {
  if (file.size === 0) return `“${file.name}” is empty.`;
  const ext = (/\.([^.]+)$/.exec(file.name) || [])[1] || '';
  if (/^(jpe?g|png|webp)$/i.test(ext) || /^image\/(jpeg|png|webp)$/.test(file.type)) {
    return `“${file.name}” isn't a valid JPG, PNG or WebP image. It may be damaged or have the wrong file extension.`;
  }
  return `“${file.name}” isn't a supported file type. Please choose a JPG, PNG or WebP image.`;
}

// ---------- Settings ----------

ui.form.addEventListener('change', settingsChanged);
ui.customValue.addEventListener('input', settingsChanged);
ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  compress();
});

function settingsChanged() {
  ui.custom.hidden = ui.form.elements.target.value !== 'custom';
  // Any result on screen belongs to the old settings.
  if (worker || !ui.result.hidden || ui.outcome.textContent) {
    stopWork();
    clearResult();
  }
}

function readTarget() {
  ui.customError.textContent = '';
  ui.customValue.removeAttribute('aria-invalid');
  const choice = ui.form.elements.target.value;
  if (choice !== 'custom') return Number(choice);
  const bytes = Math.floor(Number(ui.customValue.value) * (ui.customUnit.value === 'MB' ? MB : KB));
  if (!Number.isFinite(bytes) || bytes < KB) {
    ui.customError.textContent = 'Enter a target of at least 1 KB.';
    ui.customValue.setAttribute('aria-invalid', 'true');
    ui.customValue.focus();
    return null;
  }
  return bytes;
}

// ---------- Compressing ----------

async function compress() {
  if (!current) return;
  stopWork();
  clearResult();
  const target = readTarget();
  if (target === null) return;

  const { file, type } = current;
  if (file.size <= target) return showUnchanged(target);
  if (current.animated) {
    return showOutcome('error', `“${file.name}” is animated. Compressing it would keep only the first frame, so animated images aren't supported.`);
  }
  const mode = type === 'image/jpeg' ? 'jpeg' : type === 'image/webp' ? 'webp' : ui.form.elements.png.value;
  if (mode === 'webp' && !canEncodeWebp) {
    return showOutcome('error', "This browser can't create WebP files, so it can't compress this image. Chrome, Edge and Firefox can.");
  }

  const gen = generation;
  setBusy(true);
  let bitmap;
  try {
    bitmap = await toBitmap(current.img);
  } catch {
    if (gen === generation) {
      setBusy(false);
      showOutcome('error', 'This image is too large for your browser to process.');
    }
    return;
  }
  if (gen !== generation) return bitmap.close();

  try {
    worker = new Worker('worker.js');
  } catch {
    bitmap.close();
    setBusy(false);
    return showOutcome('error', "Couldn't start the compressor. If you opened index.html straight from your disk, serve the folder with a local web server instead (see README).");
  }
  worker.onmessage = ({ data }) => {
    if (gen !== generation) return;
    if (data.type === 'progress') {
      ui.statusDetail.textContent = `Trying ${data.text}`;
      ui.progress.value = data.fraction;
      return;
    }
    stopWork();
    if (data.type === 'error') showOutcome('error', data.message);
    else if (data.ok) showCompressed(data, target, mode);
    else showImpossible(data, target, mode);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    if (gen !== generation) return;
    stopWork();
    showOutcome('error', 'The compressor stopped unexpectedly. The image may be too large for this browser. Try closing other tabs or using a smaller image.');
  };
  worker.postMessage({ bitmap, mode, target }, [bitmap]);
}

// Drawing the <img> applies any EXIF rotation, which not every browser does for createImageBitmap(file).
async function toBitmap(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas');
    ctx.drawImage(img, 0, 0);
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = canvas.height = 0;  // release the pixel memory now rather than at GC
  }
}

function stopWork() {
  generation++;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  setBusy(false);
}

function setBusy(on) {
  ui.compress.disabled = on;
  ui.status.hidden = !on;
  if (!on) return;
  ui.statusText.textContent = 'Compressing…';
  ui.statusDetail.textContent = '';
  ui.progress.removeAttribute('value');
  announce('Compressing…');
}

// ---------- Results ----------

function showUnchanged(target) {
  const { file, type, width, height } = current;
  setDownload(file, file.name, `Download original (${formatBytes(file.size)})`);
  showResult('Already under target', [`Original: ${formatBytes(file.size)}. Target: ${formatBytes(target)}. No compression needed.`], [
    ['Original size', formatBytes(file.size)],
    ['Final size', formatBytes(file.size)],
    ['Reduction', '0%'],
    ['Target', formatBytes(target)],
    ['Dimensions', `${width} × ${height} px (unchanged)`],
    ['Compression quality', 'Unchanged (original file)'],
    ['Format', FORMATS[type].name],
  ]);
  announce(`Already under target. ${formatBytes(file.size)} is within ${formatBytes(target)}. No compression needed.`);
}

function showCompressed(data, target, mode) {
  const { file, type, width, height } = current;
  const blob = data.blob;
  const outType = blob.type;
  const scaled = data.scale < 1;
  const percent = `${Math.round(data.scale * 100)}%`;

  const notes = [];
  if (scaled) notes.push(`To reach the target, the width and height were reduced to ${percent} of the original.`);
  if (mode === 'palette' && data.level) notes.push(`To reach the target, the image was reduced to ${data.level} colors.`);
  if (outType !== type) notes.push(`Converted from ${FORMATS[type].name} to ${FORMATS[outType].name}, so the file is now a .${FORMATS[outType].ext} image.`);
  if (scaled && mode === 'png') {
    notes.push(`Tip: “Reduce colors”${canEncodeWebp ? ' or “Convert to WebP”' : ''} may reach the target without shrinking the image.`);
  }
  if (scaled && mode === 'palette' && canEncodeWebp) notes.push('Tip: “Convert to WebP” may reach the target without shrinking the image.');

  const quality = mode === 'jpeg' || mode === 'webp' ? `${data.level} / 100`
    : data.level ? `${data.level} colors (reduced)` : 'Lossless';
  const reduction = `${((1 - blob.size / file.size) * 100).toFixed(1)}%`;

  setDownload(blob, outputName(file.name, type, outType), `Download compressed image (${formatBytes(blob.size)})`);
  showResult(`Compressed to ${formatBytes(blob.size)}`, notes, [
    ['Original size', formatBytes(file.size)],
    ['Compressed size', `${formatBytes(blob.size)} (${blob.size.toLocaleString('en-US')} bytes)`],
    ['Reduction', reduction],
    ['Target', formatBytes(target)],
    ['Original dimensions', `${width} × ${height} px`],
    ['Final dimensions', `${data.width} × ${data.height} px`],
    ['Dimensions reduced', scaled ? `Yes, to ${percent}` : 'No'],
    ['Compression quality', quality],
    ['Format', outType === type ? FORMATS[type].name : `${FORMATS[type].name} → ${FORMATS[outType].name}`],
  ]);
  announce(`Compressed to ${formatBytes(blob.size)}, ${reduction} smaller. Download is ready.`);
}

function showImpossible(data, target, mode) {
  const s = data.smallest;
  let text = `Couldn't get this image under ${formatBytes(target)}. The smallest result, at ${Math.round(s.scale * 100)}% of the original width and height (${s.width} × ${s.height} px), was ${formatBytes(s.size)}.`;
  if (mode === 'png') {
    text += ` Lossless PNG can't go smaller. Try “Reduce colors”${canEncodeWebp ? ' or “Convert to WebP”' : ''} above, or choose a larger target.`;
  } else if (mode === 'palette' && canEncodeWebp) {
    text += ' Try “Convert to WebP” above, or choose a larger target.';
  } else {
    text += ' That size isn’t realistically achievable for this image without much more aggressive quality loss. Please choose a larger target.';
  }
  showOutcome('warn', text);
}

function showResult(heading, notes, facts) {
  ui.resultHeading.textContent = heading;
  ui.resultNotes.replaceChildren(...notes.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  renderFacts(ui.resultFacts, facts);
  ui.result.hidden = false;
  ui.result.scrollIntoView({ block: 'nearest' });
}

function clearResult() {
  ui.result.hidden = true;
  showOutcome('', '');
  ui.download.removeAttribute('href');
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
}

function releaseImage() {
  if (!current) return;
  URL.revokeObjectURL(current.url);
  current = null;
}

function setDownload(blob, filename, label) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  ui.download.href = downloadUrl;
  ui.download.download = filename;
  ui.download.textContent = label;
}

function outputName(name, inType, outType) {
  const match = /^(.*?)\.([^.]+)$/.exec(name);
  const base = (match ? match[1] : name) || 'image';
  // Keep the user's own spelling of the extension (.jpeg, .JPG) when the format is unchanged.
  const ext = match && inType === outType ? match[2] : FORMATS[outType].ext;
  return `${base}-compressed.${ext}`;
}

// ---------- Small helpers ----------

function renderFacts(dl, pairs) {
  dl.replaceChildren(...pairs.map(([label, value]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

function showFileMessage(kind, text) {
  ui.fileMessage.className = `message ${kind}`;
  ui.fileMessage.textContent = text;
}

function showOutcome(kind, text) {
  ui.outcome.className = `message ${kind}`;
  ui.outcome.textContent = text;
}

function announce(text) {
  ui.live.textContent = text;
}

function formatBytes(n) {
  if (n < KB) return `${n} bytes`;
  if (n < MB) return `${trimNumber(n / KB)} KB`;
  return `${trimNumber(n / MB)} MB`;
}

function trimNumber(v) {
  if (v >= 100) return String(Math.round(v));
  return v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}
