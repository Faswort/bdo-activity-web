import { calibrate, box, NAME_WORD_LIMIT } from './layout.ts';
import { recognizeActivityRegion, recognizeRegion, type OcrWorker } from './ocr.ts';
import {
  lineCenterY,
  lineText,
  type Layout,
  type Member,
  type OcrLine,
  type Region,
} from './types.ts';

export const STRIP_SCALE = 4;

const DIGITS_FIX: Record<string, string> = {
  O: '0',
  О: '0',
  o: '0',
  о: '0',
  Q: '0',
  I: '1',
  l: '1',
  '|': '1',
  З: '3',
  з: '3',
  S: '5',
  Б: '6',
  В: '8',
  g: '9',
};

const ACTIVITY_RE = /(\d{1,9})\s*[\(\[]\s*([+\-−–])?\s*(\d{1,6})/;
const NUM_RE = /\d+/;
const NAME_RE = /^(.*?)\s*[\(\[]\s*(.*?)\s*[\)\]]*$/;
const TRAILING_PARENS_RE = /[\(\[]+.*$/;
const JUNK_RE = /[\s\u00a0]+/g;
const EDGE_JUNK_RE = /^[\[\(\)\|,.:;\-–—]+|[\[\(\)\|,.:;\-–—]+$/g;

function translateDigits(text: string): string {
  let result = '';
  for (const char of text) result += DIGITS_FIX[char] ?? char;
  return result;
}

export interface ParsedActivity {
  total: number | null;
  delta: number | null;
}

/** «203127(+192)» -> { total: 203127, delta: 192 }. Прирост нужен только для проверки. */
export function parseActivity(raw: string): ParsedActivity {
  const text = translateDigits(raw).replace(/ /g, '');
  const match = text.match(ACTIVITY_RE);
  if (match) {
    const total = Number.parseInt(match[1], 10);
    let delta: number | null = match[3] !== undefined ? Number.parseInt(match[3], 10) : null;
    if (delta !== null && (match[2] === '-' || match[2] === '−' || match[2] === '–')) {
      delta = -delta;
    }
    return { total, delta };
  }
  const numbers = text.match(NUM_RE);
  return { total: numbers ? Number.parseInt(numbers[0], 10) : null, delta: null };
}

function cleanText(raw: string): string {
  const text = raw.replace(JUNK_RE, ' ').trim();
  return text.replace(EDGE_JUNK_RE, '').trim();
}

function isLower(char: string | undefined): boolean {
  return !!char && /[a-zа-яё]/.test(char);
}

/**
 * Заглавная «I» в нике почти всегда строчная «l» (ArtExpIosion -> ArtExplosion).
 * Заменяем, если рядом есть строчная буква; первый символ не трогаем.
 */
function fixLookalikes(text: string): string {
  const chars = [...text];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < chars.length; index++) {
      if (chars[index] !== 'I' || index === 0) continue;
      const left = chars[index - 1];
      const right = chars[index + 1];
      if (isLower(left) || isLower(right)) {
        chars[index] = 'l';
        changed = true;
      }
    }
  }
  return chars.join('');
}

export interface ParsedName {
  family: string;
  character: string;
}

/** «Фамилия(Имя)» / «Фамилия(-)» -> { family, character }. */
export function parseName(raw: string, fix = true): ParsedName {
  const text = raw.replace(JUNK_RE, '');
  if (!text) return { family: '', character: '' };

  const match = text.match(NAME_RE);
  let family: string;
  let character: string;
  if (match) {
    family = match[1];
    character = match[2];
  } else {
    family = text.replace(TRAILING_PARENS_RE, '');
    character = '';
  }

  family = cleanText(family);
  character = cleanText(character);
  if (character.length < 2 || character === '-' || character === '–' || character === '—' || character === '_') {
    character = '';
  }
  if (family === character) character = '';
  if (!fix) return { family, character };
  return { family: fixLookalikes(family), character: fixLookalikes(character) };
}

function clusterCenters(lines: OcrLine[], tolerance = 10): number[] {
  const centers = lines.map(lineCenterY).sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const center of centers) {
    const last = groups[groups.length - 1];
    if (last) {
      const mean = last.reduce((sum, value) => sum + value, 0) / last.length;
      if (center - mean <= tolerance) {
        last.push(center);
        continue;
      }
    }
    groups.push([center]);
  }
  return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
}

function assign(lines: OcrLine[], centers: number[], tolerance = 13): Map<number, OcrLine> {
  const best = new Map<number, { distance: number; line: OcrLine }>();
  for (const line of lines) {
    const centerY = lineCenterY(line);
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    centers.forEach((center, index) => {
      const distance = Math.abs(centerY - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0 || bestDistance > tolerance) continue;
    const current = best.get(bestIndex);
    if (!current || bestDistance < current.distance) {
      best.set(bestIndex, { distance: bestDistance, line });
    }
  }
  const result = new Map<number, OcrLine>();
  for (const [index, value] of best) result.set(index, value.line);
  return result;
}

function limitRegion(region: Region, width: number, height: number): Region {
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(width, Math.round(region.x + region.width));
  const y1 = Math.min(height, Math.round(region.y + region.height));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

async function readNameStrip(
  worker: OcrWorker,
  bitmap: ImageBitmap,
  layout: Layout,
): Promise<OcrLine[]> {
  const region = box(layout, 'name', bitmap.width, bitmap.height);
  const lines = await recognizeRegion(worker, bitmap, region, STRIP_SCALE, true);
  const limit = layout.nameX + NAME_WORD_LIMIT * layout.scale;
  const kept: OcrLine[] = [];
  for (const line of lines) {
    const words = line.words.filter((word) => word.x0 <= limit);
    if (words.length) kept.push({ words, confidence: line.confidence });
  }
  return kept;
}

async function retryName(
  worker: OcrWorker,
  bitmap: ImageBitmap,
  layout: Layout,
  centerY: number,
): Promise<string> {
  const nameBox = box(layout, 'name', bitmap.width, bitmap.height);
  const region = limitRegion(
    { x: nameBox.x, y: centerY - 17, width: nameBox.width, height: 34 },
    bitmap.width,
    bitmap.height,
  );
  const limit = layout.nameX + NAME_WORD_LIMIT * layout.scale;

  for (const scale of [4, 6, 8]) {
    const lines = await recognizeRegion(worker, bitmap, region, scale, false);
    for (const line of lines) {
      const words = line.words.filter((word) => word.x0 <= limit);
      if (!words.length) continue;
      const text = words.map((word) => word.text).join('');
      if (parseName(text).family) return text;
    }
  }
  return '';
}

async function retryActivity(
  activityWorker: OcrWorker,
  bitmap: ImageBitmap,
  layout: Layout,
  centerY: number,
): Promise<ParsedActivity | null> {
  const activityBox = box(layout, 'activity', bitmap.width, bitmap.height);
  let fallback: ParsedActivity | null = null;

  for (const scale of [2.5, 3.5, 2]) {
    const region = limitRegion(
      {
        x: activityBox.x - 12,
        y: centerY - 17,
        width: activityBox.width + 24,
        height: 34,
      },
      bitmap.width,
      bitmap.height,
    );
    const lines = await recognizeActivityRegion(activityWorker, bitmap, region, scale);
    for (const line of lines) {
      const parsed = parseActivity(lineText(line));
      if (parsed.total === null) continue;
      if (parsed.delta !== null) return parsed;
      fallback ??= parsed;
    }
  }
  return fallback;
}

interface RowResult {
  members: Member[];
  warnings: string[];
}

async function readRows(
  worker: OcrWorker,
  activityWorker: OcrWorker,
  bitmap: ImageBitmap,
  screen: string,
  layout: Layout,
): Promise<RowResult> {
  const warnings: string[] = [];
  // Имена и цифры читают разные воркеры, поэтому полосы можно распознавать
  // одновременно: это заметно сокращает время на кадр.
  const activityRegion = box(layout, 'activity', bitmap.width, bitmap.height);
  const [nameLines, activityLines] = await Promise.all([
    readNameStrip(worker, bitmap, layout),
    recognizeActivityRegion(activityWorker, bitmap, activityRegion),
  ]);

  if (!nameLines.length && !activityLines.length) {
    return { members: [], warnings: [`${screen}: не нашёл строк участников`] };
  }

  let centers = clusterCenters(activityLines);
  if (!centers.length) centers = clusterCenters(nameLines);

  const preliminary = assign(nameLines, centers);
  for (const line of nameLines) {
    const found = [...preliminary.values()].includes(line);
    if (!found) centers.push(lineCenterY(line));
  }
  centers.sort((a, b) => a - b);

  const names = assign(nameLines, centers);
  const activities = assign(activityLines, centers);

  const members: Member[] = [];
  for (let index = 0; index < centers.length; index++) {
    const center = centers[index];
    let nameText = names.has(index) ? lineText(names.get(index)!) : '';
    const activityLine = activities.get(index);
    const activityText = activityLine ? lineText(activityLine) : '';

    // Имя иногда не читается с резкостью; пробуем без неё, если активность есть.
    if (!nameText && activityText) {
      nameText = await retryName(worker, bitmap, layout, center);
    }

    const parsedName = parseName(nameText);
    if (!parsedName.family) {
      warnings.push(`${screen}: строка ${index + 1} без имени пропущена`);
      continue;
    }

    const parsedActivity = parseActivity(activityText);
    const member: Member = {
      family: parsedName.family,
      activity: parsedActivity.total,
      activityDelta: parsedActivity.delta,
      screen,
      rowIndex: index,
      confidence: activityLine?.confidence ?? 0,
    };

    // Бывает, что скобка «(+N)» не разобралась: перечитываем ячейку.
    if (member.activityDelta === null) {
      const retried = await retryActivity(activityWorker, bitmap, layout, center);
      if (retried && retried.delta !== null) {
        if (retried.total !== null && retried.total !== member.activity) {
          warnings.push(
            `${screen}: строка ${index + 1}: активность уточнена ${member.activity} -> ${retried.total}`,
          );
        }
        member.activity = retried.total;
        member.activityDelta = retried.delta;
      }
    }

    members.push(member);
  }

  if (!members.length) warnings.push(`${screen}: участники не распознаны`);
  return { members, warnings };
}

export interface ExtractResult {
  members: Member[];
  warnings: string[];
  layout: Layout | null;
}

/**
 * Прочитать все строки участников с одного скриншота.
 * layout можно передать из калибровки первого кадра партии.
 */
export async function extractImage(
  worker: OcrWorker,
  activityWorker: OcrWorker,
  bitmap: ImageBitmap,
  screen: string,
  providedLayout: Layout | null = null,
): Promise<ExtractResult> {
  let layout: Layout;
  try {
    layout = providedLayout ?? (await calibrate(worker, bitmap));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      members: [],
      warnings: [`${screen}: ${message}`],
      layout: null,
    };
  }

  let result = await readRows(worker, activityWorker, bitmap, screen, layout);

  // Окно могло стоять иначе, чем на первом кадре: пробуем откалибровать заново.
  if (!result.members.length && providedLayout) {
    try {
      layout = await calibrate(worker, bitmap);
      result = await readRows(worker, activityWorker, bitmap, screen, layout);
    } catch {
      // оставляем результат первой попытки
    }
  }

  return { ...result, layout };
}
