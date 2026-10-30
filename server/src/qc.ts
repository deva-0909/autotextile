/** 4-point fabric inspection system (ASTM D5430). */

export interface Defect {
  type: string;
  /** 1: up to 3", 2: 3"-6", 3: 6"-9", 4: over 9" or holes. */
  points: number;
  count: number;
}

export const DEFECT_TYPES = [
  'Slub', 'Missing end', 'Broken pick', 'Float', 'Stain', 'Hole', 'Shade variation', 'Crease mark',
];

/** Acceptance limit in points per 100 square yards. */
export const QC_PASS_LIMIT = 40;

export function totalPoints(defects: Defect[]): number {
  return defects.reduce((sum, d) => sum + d.points * d.count, 0);
}

export function pointsPer100SqYd(total: number, lengthM: number, widthCm: number): number {
  const yards = lengthM * 1.09361;
  const inches = widthCm / 2.54;
  return Math.round(((total * 3600) / (yards * inches)) * 100) / 100;
}

export function validateDefects(input: unknown): Defect[] {
  if (!Array.isArray(input)) throw new Error('defects must be an array');
  return input.map((d) => {
    const points = Number(d?.points);
    const count = Number(d?.count);
    if (!d?.type || typeof d.type !== 'string') throw new Error('defect type is required');
    if (!Number.isInteger(points) || points < 1 || points > 4) throw new Error('defect points must be 1-4');
    if (!Number.isInteger(count) || count < 0) throw new Error('defect count must be a non-negative integer');
    return { type: d.type, points, count };
  });
}
