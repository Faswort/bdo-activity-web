import * as XLSX from 'xlsx-js-style';
import type { MergedMember } from './types.ts';

const HEADER_FILL = { patternType: 'solid', fgColor: { rgb: '1F3864' } };
const HEADER_FONT = { color: { rgb: 'FFFFFF' }, bold: true, sz: 11 };
const ZERO_FILL = { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } };
const ZERO_FONT = { color: { rgb: '808080' } };
const THIN = { style: 'thin', color: { rgb: 'B4C6E7' } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const CENTER = { horizontal: 'center', vertical: 'center' };
const BODY = { vertical: 'center' };

export const SHEET_TITLE = 'Активность по датам';

const cellAt = (sheet: XLSX.WorkSheet, row: number, column: number): XLSX.CellObject =>
  sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject;

export function buildWorkbook(rows: MergedMember[], dateLabel: string): XLSX.WorkBook {
  const data: Array<Array<string | number>> = [
    ['Фамилия', dateLabel],
    ...rows.map((row) => [row.family, row.activity ?? 0] as Array<string | number>),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet['!cols'] = [{ wch: 28 }, { wch: 15 }];
  sheet['!rows'] = [{ hpt: 28 }];

  for (let column = 0; column < 2; column++) {
    const cell = cellAt(sheet, 0, column);
    if (!cell) continue;
    cell.s = { fill: HEADER_FILL, font: HEADER_FONT, alignment: CENTER, border: BORDER };
  }

  rows.forEach((row, index) => {
    const activityCell = cellAt(sheet, index + 1, 0 + 1);
    if (activityCell) {
      activityCell.z = '#,##0';
      activityCell.s = { border: BORDER, alignment: BODY };
      if (row.activity === null) {
        activityCell.s = {
          ...activityCell.s,
          fill: ZERO_FILL,
          font: ZERO_FONT,
        };
      }
    }
    const nameCell = cellAt(sheet, index + 1, 0);
    if (nameCell) nameCell.s = { border: BORDER, alignment: BODY };
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, SHEET_TITLE);
  return workbook;
}

export function downloadWorkbook(rows: MergedMember[], dateLabel: string): void {
  const workbook = buildWorkbook(rows, dateLabel);
  XLSX.writeFile(workbook, `BDO-активность_${dateLabel}.xlsx`, { compression: true });
}
