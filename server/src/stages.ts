export interface Stage {
  code: string;
  name: string;
  /** Process loss (%) above which an alert is raised. */
  maxLossPct: number;
}

/** Process route for woven fabric, greige to packed goods. */
export const STAGES: Stage[] = [
  { code: 'WARPING', name: 'Warping', maxLossPct: 0.5 },
  { code: 'SIZING', name: 'Sizing', maxLossPct: 1 },
  { code: 'WEAVING', name: 'Weaving', maxLossPct: 2 },
  { code: 'PRETREATMENT', name: 'Desizing & Scouring', maxLossPct: 2 },
  { code: 'DYEING', name: 'Dyeing', maxLossPct: 2 },
  { code: 'FINISHING', name: 'Stenter Finishing', maxLossPct: 3 },
  { code: 'INSPECTION', name: 'QC Inspection', maxLossPct: 1 },
  { code: 'PACKING', name: 'Packing', maxLossPct: 0.5 },
];

export const FIRST_STAGE = STAGES[0].code;

export function getStage(code: string): Stage {
  const s = STAGES.find((x) => x.code === code);
  if (!s) throw new Error(`Unknown stage ${code}`);
  return s;
}

/** Stages a lot still has to pass through, starting with `current`. Undyed (no shade) orders skip dyeing. */
export function remainingStages(current: string, shadeCode: string | null): Stage[] {
  const idx = STAGES.findIndex((s) => s.code === current);
  return STAGES.slice(idx).filter((s) => shadeCode || s.code !== 'DYEING');
}

export function nextStage(current: string, shadeCode: string | null): string | null {
  return remainingStages(current, shadeCode)[1]?.code ?? null;
}
