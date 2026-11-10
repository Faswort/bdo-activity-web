import type { Region } from './types.ts';

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Браузер не дал доступ к Canvas 2D');
  return context;
}

export async function decodeImage(file: File): Promise<ImageBitmap> {
  return await createImageBitmap(file);
}

/** Вырезает область исходного скриншота в отдельный canvas (без масштаба). */
export function drawRegion(bitmap: ImageBitmap, region: Region): HTMLCanvasElement {
  const canvas = createCanvas(region.width, region.height);
  const context = context2d(canvas);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    bitmap,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

// Ядро гауссова размытия (приближение sigma ~1.4).
const KERNEL = [1, 4, 6, 4, 1];
const KERNEL_SUM = 16;

/**
 * Unsharp mask по RGB. Повторяет фильтр desktop-версии
 * (PIL UnsharpMask radius=2, percent=170, threshold=3).
 */
function unsharpMask(image: ImageData, amount = 1.7, threshold = 3): void {
  const { width, height, data } = image;
  const size = width * height;
  const source = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    source[i * 3] = data[i * 4];
    source[i * 3 + 1] = data[i * 4 + 1];
    source[i * 3 + 2] = data[i * 4 + 2];
  }

  const horizontal = new Float32Array(size * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -2; k <= 2; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        const index = (row + sx) * 3;
        const weight = KERNEL[k + 2];
        r += source[index] * weight;
        g += source[index + 1] * weight;
        b += source[index + 2] * weight;
      }
      const out = (row + x) * 3;
      horizontal[out] = r / KERNEL_SUM;
      horizontal[out + 1] = g / KERNEL_SUM;
      horizontal[out + 2] = b / KERNEL_SUM;
    }
  }

  const blurred = new Float32Array(size * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -2; k <= 2; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        const index = (sy * width + x) * 3;
        const weight = KERNEL[k + 2];
        r += horizontal[index] * weight;
        g += horizontal[index + 1] * weight;
        b += horizontal[index + 2] * weight;
      }
      const out = (y * width + x) * 3;
      blurred[out] = r / KERNEL_SUM;
      blurred[out + 1] = g / KERNEL_SUM;
      blurred[out + 2] = b / KERNEL_SUM;
    }
  }

  for (let i = 0; i < size; i++) {
    for (let c = 0; c < 3; c++) {
      const original = source[i * 3 + c];
      const difference = original - blurred[i * 3 + c];
      const value =
        Math.abs(difference) > threshold ? original + amount * difference : original;
      data[i * 4 + c] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

/**
 * Готовит область для OCR: при необходимости повышает резкость и/или
 * инвертирует цвета, затем увеличивает в scale раз с высоким качеством.
 *
 * Инверсия важна для колонки активности: Tesseract лучше читает тёмные
 * цифры на светлом фоне, а в игре они светлые на тёмном. Вместе с
 * увеличением x2.5 и цифровым whitelist это даёт заметно более точные числа.
 */
export function prepareRegion(
  bitmap: ImageBitmap,
  region: Region,
  scale: number,
  sharpen: boolean,
  negate = false,
): HTMLCanvasElement {
  const source = drawRegion(bitmap, region);
  if (sharpen || negate) {
    const context = context2d(source);
    const image = context.getImageData(0, 0, source.width, source.height);
    if (sharpen) unsharpMask(image);
    if (negate) {
      const { data } = image;
      for (let index = 0; index < data.length; index += 4) {
        data[index] = 255 - data[index];
        data[index + 1] = 255 - data[index + 1];
        data[index + 2] = 255 - data[index + 2];
      }
    }
    context.putImageData(image, 0, 0);
  }
  if (scale === 1) return source;

  const target = createCanvas(source.width * scale, source.height * scale);
  const context = context2d(target);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, target.width, target.height);
  return target;
}

/** Уменьшенная копия скриншота для предпросмотра в интерфейсе. */
export function thumbnail(bitmap: ImageBitmap, maxSize = 160): string {
  const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = createCanvas(bitmap.width * ratio, bitmap.height * ratio);
  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}
