import { decodeImage, thumbnail } from './imaging.ts';
import { extractImage } from './extract.ts';
import { createActivityWorker, createOcrWorker, type OcrWorker } from './ocr.ts';
import { mergeMembers } from './merge.ts';
import { downloadWorkbook } from './export.ts';
import type { Layout, Member, ProcessResult, MergedMember } from './types.ts';

const MAX_BATCH = 14;
const INIT_HINT = 'Первый запуск скачивает языковую модель OCR (~19 МБ). Дальше браузер возьмёт её из кэша.';

const STATUS_LABELS: Record<string, string> = {
  'loading tesseract core': 'Загружаю OCR-движок',
  'initializing tesseract': 'Инициализирую OCR',
  'loading language traineddata': 'Загружаю языковую модель',
  'initializing api': 'Готовлю распознавание',
  'recognizing text': 'Распознаю текст',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Не найден элемент #${id}`);
  return node as T;
}

const drop = el<HTMLDivElement>('drop');
const fileInput = el<HTMLInputElement>('file');
const pick = el<HTMLButtonElement>('pick');
const filesBox = el<HTMLDivElement>('files');
const filesNote = el<HTMLParagraphElement>('files-note');
const runButton = el<HTMLButtonElement>('run');
const clearButton = el<HTMLButtonElement>('clear');
const progress = el<HTMLDivElement>('progress');
const progressStage = el<HTMLSpanElement>('progress-stage');
const progressPercent = el<HTMLSpanElement>('progress-percent');
const barFill = el<HTMLDivElement>('bar-fill');
const progressDetail = el<HTMLParagraphElement>('progress-detail');
const resultBox = el<HTMLElement>('result');
const resultTitle = el<HTMLHeadingElement>('result-title');
const resultSummary = el<HTMLParagraphElement>('result-summary');
const metricsBox = el<HTMLDivElement>('metrics');
const previewBody = el<HTMLTableSectionElement>('preview').querySelector('tbody')!;
const previewDate = el<HTMLTableCellElement>('preview-date');
const warningsBox = el<HTMLDetailsElement>('warnings-box');
const warningsCount = el<HTMLSpanElement>('warnings-count');
const warningsList = el<HTMLUListElement>('warnings');
const downloadButton = el<HTMLButtonElement>('download');

interface SelectedFile {
  key: string;
  file: File;
  preview: string;
}

let selected: SelectedFile[] = [];
let result: ProcessResult | null = null;
let resultDate = '';
let busy = false;
let keyCounter = 0;

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

function setProgress(stage: string, value: number, detail: string | null = null): void {
  const percent = Math.max(0, Math.min(100, value * 100));
  progressStage.textContent = stage;
  progressPercent.textContent = `${Math.round(percent)}%`;
  barFill.style.width = `${percent}%`;
  progressDetail.textContent = detail ?? '';
}

function updateControls(): void {
  runButton.disabled = busy || selected.length === 0;
  clearButton.disabled = busy || (selected.length === 0 && !result);
  fileInput.disabled = busy;
  for (const button of filesBox.querySelectorAll<HTMLButtonElement>('.file-remove')) {
    button.disabled = busy;
  }
}

function renderFiles(): void {
  filesBox.replaceChildren();
  filesBox.hidden = selected.length === 0;

  for (const item of selected) {
    const card = document.createElement('div');
    card.className = 'file';

    const image = document.createElement('img');
    image.src = item.preview;
    image.alt = item.file.name;
    image.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.file.name;
    name.title = item.file.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.dataset.key = item.key;
    remove.title = 'Убрать из партии';
    remove.setAttribute('aria-label', `Убрать ${item.file.name}`);
    remove.textContent = '×';

    card.append(image, name, remove);
    filesBox.append(card);
  }

  filesNote.textContent = selected.length
    ? `Выбрано ${selected.length} из ${MAX_BATCH}. Столбец получит дату ${formatDate(new Date())}.`
    : '';
  filesNote.classList.remove('warn');
}

async function addFiles(list: FileList | File[]): Promise<void> {
  if (busy) return;
  const incoming = Array.from(list);
  const images = incoming.filter((file) => file.type.startsWith('image/'));
  let skippedType = incoming.length - images.length;
  const room = MAX_BATCH - selected.length;
  const accepted = images.slice(0, Math.max(0, room));
  const skippedLimit = images.length - accepted.length;

  for (const file of accepted) {
    try {
      const bitmap = await decodeImage(file);
      const preview = thumbnail(bitmap);
      bitmap.close();
      selected.push({ key: `f${++keyCounter}`, file, preview });
    } catch {
      skippedType++;
    }
  }

  selected.sort((a, b) =>
    a.file.name.localeCompare(b.file.name, 'ru', { numeric: true, sensitivity: 'base' }),
  );

  const notes: string[] = [];
  if (skippedLimit > 0) notes.push(`В партию можно добавить не больше ${MAX_BATCH} изображений.`);
  if (skippedType > 0) notes.push('Пропущены файлы, которые не являются изображениями.');

  renderFiles();
  if (notes.length) {
    filesNote.textContent = notes.join(' ');
    filesNote.classList.add('warn');
  }
  updateControls();
}

function clearAll(): void {
  if (busy) return;
  selected = [];
  result = null;
  resultDate = '';
  fileInput.value = '';
  progress.hidden = true;
  resultBox.hidden = true;
  renderFiles();
  updateControls();
}

function addMetric(value: string, label: string): void {
  const box = document.createElement('div');
  box.className = 'metric';
  const valueNode = document.createElement('div');
  valueNode.className = 'metric-value';
  valueNode.textContent = value;
  const labelNode = document.createElement('div');
  labelNode.className = 'metric-label';
  labelNode.textContent = label;
  box.append(valueNode, labelNode);
  metricsBox.append(box);
}

function renderResult(data: ProcessResult, dateLabel: string): void {
  resultDate = dateLabel;
  previewDate.textContent = dateLabel;
  resultTitle.textContent = data.warnings.length ? 'Готово с замечаниями' : 'Готово';
  resultSummary.textContent = `Дата столбца: ${dateLabel}. Уникальных участников: ${data.rows.length}.`;

  metricsBox.replaceChildren();
  addMetric(String(data.metrics.images), 'скриншотов');
  addMetric(String(data.metrics.rows), 'строк найдено');
  addMetric(String(data.metrics.unique), 'уникальных');
  addMetric(`${data.metrics.seconds.toFixed(1)} с`, 'время');
  addMetric(
    data.metrics.confidence > 0 ? `${Math.round(data.metrics.confidence)}%` : '—',
    'средняя уверенность',
  );

  previewBody.replaceChildren();
  for (const row of data.rows) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = row.family;
    const activity = document.createElement('td');
    activity.textContent = row.activity === null ? '—' : row.activity.toLocaleString('ru-RU');
    tr.append(name, activity);
    previewBody.append(tr);
  }

  warningsList.replaceChildren();
  warningsCount.textContent = String(data.warnings.length);
  warningsBox.hidden = data.warnings.length === 0;
  for (const warning of data.warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    warningsList.append(li);
  }

  resultBox.hidden = false;
  downloadButton.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Показать причину сбоя и замечания, не оставляя кнопку скачивания. */
function renderFailure(message: string, warnings: string[]): void {
  resultDate = '';
  resultTitle.textContent = 'Не удалось распознать';
  resultSummary.textContent = message;
  metricsBox.replaceChildren();
  previewBody.replaceChildren();
  previewDate.textContent = '';

  warningsList.replaceChildren();
  warningsCount.textContent = String(warnings.length);
  warningsBox.hidden = warnings.length === 0;
  for (const warning of warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    warningsList.append(li);
  }

  downloadButton.hidden = true;
  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function averageConfidence(members: Member[]): number {
  const values = members.map((member) => member.confidence).filter((value) => value > 0);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function run(): Promise<void> {
  if (busy || !selected.length) return;

  busy = true;
  result = null;
  resultBox.hidden = true;
  progress.hidden = false;
  updateControls();

  const started = performance.now();
  const dateLabel = formatDate(new Date());
  const total = selected.length;
  const allMembers: Member[] = [];
  const warnings: string[] = [];
  let layout: Layout | null = null;
  let imageIndex = 0;
  let initializing = true;

  setProgress('Загружаю OCR…', 0, INIT_HINT);
  let worker: OcrWorker | null = null;
  let activityWorker: OcrWorker | null = null;

  try {
    if (typeof WebAssembly === 'undefined') {
      throw new Error('Этот браузер не поддерживает WebAssembly, без него распознавание невозможно.');
    }

    worker = await createOcrWorker((status, value) => {
      if (initializing) {
        const label = STATUS_LABELS[status] ?? 'Готовлю OCR';
        setProgress(label, Math.min(1, value) * 0.5, INIT_HINT);
        return;
      }
      if (status === 'recognizing text') {
        setProgress(
          progressStage.textContent ?? 'Распознаю…',
          Math.min(1, (imageIndex + value) / total),
        );
      }
    });

    // Второй воркер — только английская модель для цифр активности.
    setProgress('Загружаю модель для активности…', 0.5, INIT_HINT);
    activityWorker = await createActivityWorker((status, value) => {
      if (!initializing) return;
      const label = STATUS_LABELS[status] ?? 'Готовлю OCR';
      setProgress(label, 0.5 + Math.min(1, value) * 0.5, INIT_HINT);
    });

    initializing = false;
    setProgress('OCR готов', 0);

    for (let index = 0; index < total; index++) {
      imageIndex = index;
      const item = selected[index];
      setProgress(`Кадр ${index + 1} из ${total}: ${item.file.name}`, index / total);

      const bitmap = await decodeImage(item.file);
      try {
        const extracted = await extractImage(worker!, activityWorker!, bitmap, item.file.name, layout);
        if (extracted.layout) layout = extracted.layout;
        allMembers.push(...extracted.members);
        warnings.push(...extracted.warnings);
      } finally {
        bitmap.close();
      }
      setProgress(`Кадр ${index + 1} из ${total}: ${item.file.name}`, (index + 1) / total);
    }

    setProgress('Объединяю результаты…', 1);
    const merged = mergeMembers(allMembers);
    warnings.push(...merged.warnings);

    if (!merged.rows.length) {
      throw new Error(
        warnings.length
          ? 'Не удалось распознать ни одного участника. Проверьте замечания ниже.'
          : 'Не удалось распознать ни одного участника.',
      );
    }

    result = {
      rows: merged.rows,
      warnings,
      metrics: {
        images: total,
        rows: allMembers.length,
        unique: merged.rows.length,
        seconds: (performance.now() - started) / 1000,
        confidence: averageConfidence(allMembers),
      },
    };

    setProgress('Готово', 1);
    renderResult(result, dateLabel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setProgress('Ошибка распознавания', 0, message);
    progressDetail.classList.add('error');
    if (warnings.length) renderFailure(message, warnings);
  } finally {
    await worker?.terminate();
    await activityWorker?.terminate();
    busy = false;
    updateControls();
    progressDetail.classList.remove('error');
  }
}

function removeFile(key: string): void {
  if (busy) return;
  selected = selected.filter((item) => item.key !== key);
  renderFiles();
  updateControls();
}

pick.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) void addFiles(fileInput.files);
  fileInput.value = '';
});

filesBox.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.file-remove');
  if (button?.dataset.key) removeFile(button.dataset.key);
});

for (const type of ['dragenter', 'dragover'] as const) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (!busy) drop.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('dragover');
  });
}
drop.addEventListener('drop', (event) => {
  event.stopPropagation();
  if (event.dataTransfer?.files) void addFiles(event.dataTransfer.files);
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

runButton.addEventListener('click', () => void run());
clearButton.addEventListener('click', clearAll);
downloadButton.addEventListener('click', () => {
  if (result) downloadWorkbook(result.rows as MergedMember[], resultDate);
});

renderFiles();
updateControls();
