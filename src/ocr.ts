import { createWorker, OEM, PSM } from 'tesseract.js';
import { prepareRegion } from './imaging.ts';
import type { OcrLine, OcrWord, Region } from './types.ts';

export type OcrWorker = Awaited<ReturnType<typeof createWorker>>;
export type ProgressHandler = (status: string, progress: number) => void;

/**
 * Абсолютный адрес ресурса рядом со страницей. С относительной базой Vite
 * это работает и на GitHub Pages в подпапке, и при локальном просмотре.
 */
export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export async function createOcrWorker(onProgress: ProgressHandler): Promise<OcrWorker> {
  const worker = await createWorker(['rus', 'eng'], OEM.LSTM_ONLY, {
    ...workerOptions(onProgress),
  });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1',
  });

  return worker;
}

/** Общие настройки воркера: свои ресурсы вместо CDN, прогресс и ошибки. */
function workerOptions(onProgress: ProgressHandler) {
  return {
    workerPath: assetUrl('tesseract/worker.min.js'),
    corePath: assetUrl('tesseract-core'),
    langPath: assetUrl('tessdata'),
    logger: (message: { status: string; progress?: number }) => {
      if (typeof message.progress === 'number') {
        onProgress(message.status, message.progress);
      }
    },
    errorHandler: (error: unknown) => console.error('[tesseract]', error),
  };
}

/**
 * Отдельный воркер только с английской моделью для колонки активности.
 *
 * Смешанная модель «rus+eng» знает и кириллические, и латинские цифры, из-за
 * чего иногда путает похожие глифы. На тестовом наборе eng-модель с
 * цифровым whitelist читает все значения активности без ошибок.
 */
export async function createActivityWorker(onProgress: ProgressHandler): Promise<OcrWorker> {
  const worker = await createWorker(['eng'], OEM.LSTM_ONLY, {
    ...workerOptions(onProgress),
  });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: ACTIVITY_WHITELIST,
    preserve_interword_spaces: '1',
  });

  return worker;
}

/** Распознать готовый canvas и вернуть строки в координатах исходного скриншота. */
export async function recognizeCanvas(
  worker: OcrWorker,
  canvas: HTMLCanvasElement,
  scale: number,
  offsetX: number,
  offsetY: number,
): Promise<OcrLine[]> {
  const result = await worker.recognize(canvas, {}, { blocks: true });
  const lines: OcrLine[] = [];
  const blocks = result.data.blocks ?? [];

  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words: OcrWord[] = [];
        for (const word of line.words ?? []) {
          const text = String(word.text ?? '').trim();
          if (!text) continue;
          words.push({
            text,
            x0: offsetX + word.bbox.x0 / scale,
            y0: offsetY + word.bbox.y0 / scale,
            x1: offsetX + word.bbox.x1 / scale,
            y1: offsetY + word.bbox.y1 / scale,
            confidence: word.confidence ?? 0,
          });
        }
        if (words.length) {
          lines.push({ words, confidence: line.confidence ?? 0 });
        }
      }
    }
  }

  return lines;
}

export async function recognizeRegion(
  worker: OcrWorker,
  bitmap: ImageBitmap,
  region: Region,
  scale: number,
  sharpen: boolean,
  negate = false,
): Promise<OcrLine[]> {
  const canvas = prepareRegion(bitmap, region, scale, sharpen, negate);
  return recognizeCanvas(worker, canvas, scale, region.x, region.y);
}

const ACTIVITY_SCALE = 2.5;
export const ACTIVITY_WHITELIST = '0123456789()+-';

/**
 * Распознать колонку активности выделенным eng-воркером: страничный режим
 * SINGLE_BLOCK, цифровой whitelist, инверсия цветов и увеличение x2.5.
 * На тестовом наборе это дало 118 из 118 верных значений вместо ~68%
 * у обычного режима с моделью «rus+eng».
 */
export async function recognizeActivityRegion(
  worker: OcrWorker,
  bitmap: ImageBitmap,
  region: Region,
  scale = ACTIVITY_SCALE,
): Promise<OcrLine[]> {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: ACTIVITY_WHITELIST,
    preserve_interword_spaces: '1',
  });
  return recognizeRegion(worker, bitmap, region, scale, false, true);
}
