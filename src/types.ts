export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrLine {
  words: OcrWord[];
  confidence: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  nameX: number;
  headerY: number;
  scale: number;
}

export interface Member {
  family: string;
  activity: number | null;
  activityDelta: number | null;
  screen: string;
  rowIndex: number;
  confidence: number;
}

export interface MergedMember {
  family: string;
  activity: number | null;
  screens: string[];
  variants: string[];
}

export interface ImageJob {
  file: File;
  bitmap: ImageBitmap;
}

export interface ProcessResult {
  rows: MergedMember[];
  warnings: string[];
  metrics: {
    images: number;
    rows: number;
    unique: number;
    seconds: number;
    confidence: number;
  };
}

export const lineText = (line: OcrLine): string => line.words.map((w) => w.text).join('');

export const lineTextSpaced = (line: OcrLine): string => line.words.map((w) => w.text).join(' ');

export const lineCenterY = (line: OcrLine): number => {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const word of line.words) {
    top = Math.min(top, word.y0);
    bottom = Math.max(bottom, word.y1);
  }
  return (top + bottom) / 2;
};
