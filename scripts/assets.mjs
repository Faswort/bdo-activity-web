// Готовит статические ресурсы для OCR: воркер, wasm-ядро и языковые модели.
// Всё кладётся в public/, чтобы страница работала без внешних CDN.
import { mkdir, copyFile, access, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');

const workerSrc = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const workerDst = join(publicDir, 'tesseract', 'worker.min.js');

const coreDir = join(root, 'node_modules', 'tesseract.js-core');
const coreDst = join(publicDir, 'tesseract-core');
// Нужны только LSTM-сборки (OEM.LSTM_ONLY): обычная, SIMD и relaxed SIMD.
// Воркер сам выберет подходящую по возможностям браузера.
const coreFiles = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

const langDir = join(publicDir, 'tessdata');
const langs = {
  rus: 'https://tessdata.projectnaptha.com/4.0.0/rus.traineddata.gz',
  eng: 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(dest, source, url) {
  if (await exists(dest)) {
    const info = await stat(dest);
    if (info.size > 1024) return;
  }
  await mkdir(dirname(dest), { recursive: true });
  if (source) {
    await copyFile(source, dest);
    console.log(`[assets] скопирован ${dest}`);
    return;
  }
  console.log(`[assets] скачиваю ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`не удалось скачать ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, buffer);
  console.log(`[assets] сохранён ${dest} (${(buffer.length / 1048576).toFixed(1)} МБ)`);
}

await ensureFile(workerDst, workerSrc);
for (const name of coreFiles) {
  await ensureFile(join(coreDst, name), join(coreDir, name));
}
for (const [lang, url] of Object.entries(langs)) {
  await ensureFile(join(langDir, `${lang}.traineddata.gz`), null, url);
}

console.log('[assets] готово');
