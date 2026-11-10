import type { Member, MergedMember } from './types.ts';

/** Порог похожести фамилий, при котором строки считаются одним участником. */
export const FUZZY_STRONG = 0.97;
export const FUZZY_WITH_ACTIVITY = 0.92;

export function normalizeName(family: string): string {
  return (family || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, '');
}

function pick(values: string[]): string {
  const filtered = values.filter(Boolean);
  if (!filtered.length) return '';
  const counts = new Map<string, number>();
  for (const value of filtered) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const candidates = [...counts.entries()]
    .filter(([, count]) => count === best)
    .map(([value]) => value);
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function pickInt(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value !== null);
  if (!filtered.length) return null;
  const counts = new Map<number, number>();
  for (const value of filtered) counts.set(value, (counts.get(value) ?? 0) + 1);
  let bestValue: number | null = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestValue = value;
    }
  }
  return bestValue;
}

function mergeGroup(members: Member[]): MergedMember {
  const merged: MergedMember = {
    family: pick(members.map((member) => member.family)),
    activity: pickInt(members.map((member) => member.activity)),
    screens: [],
    variants: [],
  };
  for (const member of members) {
    if (!merged.screens.includes(member.screen)) merged.screens.push(member.screen);
    if (!merged.variants.includes(member.family)) merged.variants.push(member.family);
  }
  return merged;
}

function compatible(a: MergedMember, b: MergedMember): boolean {
  if (a.activity === null || b.activity === null) return true;
  return a.activity === b.activity;
}

/** Слить два представления одного участника, оставив поля keep основными. */
function combine(keep: MergedMember, other: MergedMember): MergedMember {
  const merged: MergedMember = {
    family: keep.family,
    activity: keep.activity ?? other.activity,
    screens: [...keep.screens],
    variants: [...keep.variants],
  };
  for (const screen of other.screens) {
    if (!merged.screens.includes(screen)) merged.screens.push(screen);
  }
  for (const variant of other.variants) {
    if (!merged.variants.includes(variant)) merged.variants.push(variant);
  }
  return merged;
}

/**
 * Склеить строки с одинаковой (ненулевой) активностью, но по-разному
 * прочитанным именем. Одинаковый итог у двух разных людей практически не
 * встречается, поэтому это надёжнее, чем гадать по имени. Склеиваем только
 * строки с разных скриншотов.
 */
function mergeSameActivity(merged: MergedMember[], warnings: string[]): MergedMember[] {
  const byActivity = new Map<number, number[]>();
  merged.forEach((member, index) => {
    if (member.activity) {
      const list = byActivity.get(member.activity) ?? [];
      list.push(index);
      byActivity.set(member.activity, list);
    }
  });

  const dropped = new Set<number>();
  for (const [activity, indexes] of byActivity) {
    if (indexes.length < 2) continue;
    indexes.sort((a, b) => {
      const lengthDiff = merged[a].family.length - merged[b].family.length;
      if (lengthDiff !== 0) return lengthDiff;
      return merged[a].screens.length - merged[b].screens.length;
    });
    const keepIndex = indexes[indexes.length - 1];
    let keep = merged[keepIndex];
    for (const index of indexes.slice(0, -1)) {
      const other = merged[index];
      if (keep.screens.some((screen) => other.screens.includes(screen))) continue;
      keep = combine(keep, other);
      merged[keepIndex] = keep;
      dropped.add(index);
      warnings.push(
        `активность ${activity} совпала: «${other.family}» объединено с «${keep.family}»`,
      );
    }
  }

  return merged.filter((_, index) => !dropped.has(index));
}

/** Похожесть строк как у difflib.SequenceMatcher.ratio: 2 * LCS / (lenA + lenB). */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  let previous = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const current = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return (2 * previous[n]) / (m + n);
}

/** Слить строки со всех скриншотов, убрав повторы. */
export function mergeMembers(members: Member[]): { rows: MergedMember[]; warnings: string[] } {
  const warnings: string[] = [];
  const groups = new Map<string, Member[]>();
  const prepared: Member[] = [];

  for (const member of members) {
    if (!member.family) continue;
    prepared.push(member);
    const key = normalizeName(member.family);
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }

  let merged = [...groups.values()].map((group) => mergeGroup(group));
  merged = mergeSameActivity(merged, warnings);

  // Добираем почти одинаковые имена (OCR мог прочитать одну букву иначе).
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i];
        const b = merged[j];
        const ratio = similarity(a.family.toLowerCase(), b.family.toLowerCase());
        if (ratio < FUZZY_WITH_ACTIVITY) continue;
        if (compatible(a, b) || ratio >= FUZZY_STRONG) {
          const keys = new Set([normalizeName(a.family), normalizeName(b.family)]);
          const sources = prepared.filter((member) => keys.has(normalizeName(member.family)));
          merged[i] = mergeGroup(sources);
          merged.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }

  merged.sort((a, b) => {
    const aNull = a.activity === null ? 1 : 0;
    const bNull = b.activity === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    const aValue = -(a.activity ?? 0);
    const bValue = -(b.activity ?? 0);
    if (aValue !== bValue) return aValue - bValue;
    return normalizeName(a.family).localeCompare(normalizeName(b.family));
  });

  for (const group of merged) {
    if (group.variants.length > 1) {
      warnings.push(
        `фамилия распознана по-разному: ${group.variants.join(' / ')} -> ${group.family}`,
      );
    }
    if (group.activity === null) {
      warnings.push(`${group.family}: не удалось прочитать активность`);
    }
  }

  return { rows: merged, warnings };
}
