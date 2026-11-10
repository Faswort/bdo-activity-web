import { recognizeRegion, type OcrWorker } from './ocr.ts';
import type { Layout, OcrLine, Region } from './types.ts';

/** Расстояние между заголовками «Фамилия» и «Активность» в эталоне 1920x1080. */
export const HEADER_SPAN = 249;

/** Смещение заголовка «Договор» от nameX в эталоне. */
export const DOGOVOR_DX = 630;
/** Расстояние «Уровень» -> «Договор» в эталоне (запасная калибровка). */
export const LEVEL_DOGOVOR_SPAN = DOGOVOR_DX - -276;

/**
 * Колонки: (dx0, dx1) относительно x заголовка «Фамилия».
 * Читаются только name и activity; level нужен для запасной калибровки.
 */
export const COLUMNS: Record<string, [number, number]> = {
  level: [-276, -216],
  // Правый край с запасом: длинные ники доходят до nameX+190.
  // Слова, начинающиеся правее NAME_WORD_LIMIT, отбрасываются,
  // чтобы цифры активности не попали в имя.
  name: [-99, 215],
  activity: [221, 366],
};

/** Слова имени не могут начинаться правее этого смещения от nameX. */
export const NAME_WORD_LIMIT = 190;

/** Вертикальные границы списка относительно строки заголовков. */
export const ROW_TOP = 36;
export const ROW_BOTTOM = 620;

export class LayoutError extends Error {}

export function box(layout: Layout, column: string, width: number, height: number): Region {
  const [dx0, dx1] = COLUMNS[column];
  const x0 = Math.max(0, Math.round(layout.nameX + dx0 * layout.scale));
  const x1 = Math.min(width, Math.round(layout.nameX + dx1 * layout.scale));
  const y0 = Math.max(0, Math.round(layout.headerY + ROW_TOP * layout.scale));
  const y1 = Math.min(height, Math.round(layout.headerY + ROW_BOTTOM * layout.scale));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

interface HeaderWords {
  nameX: number;
  headerY: number;
  activityX: number | null;
  fallbackScale: number | null;
}

function findHeaderWords(lines: OcrLine[]): HeaderWords | null {
  let name: { x0: number; y0: number } | null = null;
  let activityX: number | null = null;
  let level: { x0: number; y0: number } | null = null;
  let dogovor: { x0: number; y0: number } | null = null;

  for (const line of lines) {
    for (const word of line.words) {
      const text = word.text.toLowerCase();
      if (!name && (text.includes('фамил') || text.includes('амили'))) {
        name = { x0: word.x0, y0: word.y0 };
      }
      if (activityX === null && text.includes('ктивн')) {
        activityX = word.x0;
      }
      if (!level && text.includes('ровен')) {
        level = { x0: word.x0, y0: word.y0 };
      }
      if (!dogovor && text.includes('оговор')) {
        dogovor = { x0: word.x0, y0: word.y0 };
      }
    }
  }

  if (name) {
    return { nameX: name.x0, headerY: name.y0, activityX, fallbackScale: null };
  }

  // Заголовок «Фамилия» может быть закрыт подсказкой. Тогда опираемся на
  // видимые «Уровень» и «Договор».
  if (level && dogovor) {
    const scale = (dogovor.x0 - level.x0) / LEVEL_DOGOVOR_SPAN;
    if (scale >= 0.5 && scale <= 3) {
      return {
        nameX: dogovor.x0 - DOGOVOR_DX * scale,
        headerY: level.y0 - scale,
        activityX: null,
        fallbackScale: scale,
      };
    }
  }

  return null;
}

function buildLayout(found: HeaderWords): Layout {
  let scale: number;
  if (found.activityX !== null) {
    scale = (found.activityX - found.nameX) / HEADER_SPAN;
  } else if (found.fallbackScale !== null) {
    scale = found.fallbackScale;
  } else {
    scale = 1;
  }
  if (scale < 0.5 || scale > 3) {
    scale = found.fallbackScale ?? 1;
  }
  return { nameX: found.nameX, headerY: found.headerY, scale };
}

/**
 * Найти таблицу участников. Сначала смотрим верхнюю часть кадра (быстрее),
 * затем весь кадр. Обычно хватает первого варианта.
 */
export async function calibrate(worker: OcrWorker, bitmap: ImageBitmap): Promise<Layout> {
  const fractions = [0.6, 1];
  let sawLines = false;

  for (const fraction of fractions) {
    const height = Math.max(1, Math.round(bitmap.height * fraction));
    const region: Region = { x: 0, y: 0, width: bitmap.width, height };
    const lines = await recognizeRegion(worker, bitmap, region, 1, false);
    sawLines ||= lines.length > 0;
    const found = findHeaderWords(lines);
    if (found) return buildLayout(found);
  }

  throw new LayoutError(
    sawLines
      ? 'Не нашёл на скриншоте заголовок «Фамилия». Нужен кадр с открытым окном гильдии на вкладке со списком участников.'
      : 'На скриншоте не удалось прочитать текст. Проверьте, что это полноценный скриншот игры.',
  );
}
