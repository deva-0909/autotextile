/**
 * Indian payroll statutory rules used by the payroll run. Rates and ceilings are in one place so the payroll
 * consultant / CA can confirm them; the PT slabs live in the pt_slabs table.
 *  - PF: employee 12% of PF wage (basic), wage capped at ₹15,000 unless the employee opts for actual wage;
 *        employer 12% split into EPS 8.33% (always on the capped wage) and EPF (the rest).
 *  - ESIC: when monthly gross is ₹21,000 or less — employee 0.75%, employer 3.25% of gross earned.
 *  - Income tax on salary (section 192), new regime from FY 2025-26: standard deduction ₹75,000; slabs
 *        0–4L nil, 4–8L 5%, 8–12L 10%, 12–16L 15%, 16–20L 20%, 20–24L 25%, above 30%; rebate u/s 87A makes tax nil up to
 *        ₹12L taxable (marginal relief applied); 4% health and education cess. Deducted evenly over the year.
 */
export const PF_WAGE_CEILING = 15000;
export const ESIC_GROSS_LIMIT = 21000;
export const round = (n: number) => Math.round(n);

export function annualTaxNewRegime(annualGross: number) {
  const taxable = Math.max(0, annualGross - 75000);
  const slabs: [number, number][] = [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]];
  let tax = 0, prev = 0;
  for (const [upto, rate] of slabs) { if (taxable > prev) tax += (Math.min(taxable, upto) - prev) * rate; prev = upto; }
  if (taxable <= 1200000) tax = 0;
  else tax = Math.min(tax, taxable - 1200000); // marginal relief just above the rebate limit
  return round(tax * 1.04);
}

export interface Structure { basic: number; hra: number; conveyance: number; special: number; other: number; pf_applicable: boolean; pf_on_capped_wage: boolean }
export interface PtSlab { min_gross: number; max_gross: number | null; amount: number; feb_amount: number | null }

export function computePayslip(s: Structure, o: { daysInMonth: number; paidDays: number; overtimeHours: number; overtimeEligible: boolean; month: number; ptSlabs: PtSlab[]; shiftHours: number }) {
  const f = o.daysInMonth ? o.paidDays / o.daysInMonth : 0;
  const fullGross = Number(s.basic) + Number(s.hra) + Number(s.conveyance) + Number(s.special) + Number(s.other);
  const earnings: Record<string, number> = {
    basic: round(Number(s.basic) * f), hra: round(Number(s.hra) * f), conveyance: round(Number(s.conveyance) * f), special: round(Number(s.special) * f), other: round(Number(s.other) * f),
  };
  // Overtime at twice the ordinary hourly rate (Factories Act s.59) for eligible staff.
  if (o.overtimeEligible && o.overtimeHours > 0) earnings.overtime = round((fullGross / (o.daysInMonth * o.shiftHours)) * 2 * o.overtimeHours);
  const gross = Object.values(earnings).reduce((a, b) => a + b, 0);
  const pfWage = earnings.basic!;
  const pfBase = s.pf_on_capped_wage ? Math.min(pfWage, PF_WAGE_CEILING) : pfWage;
  const pfEmployee = s.pf_applicable ? round(pfBase * 0.12) : 0;
  const eps = s.pf_applicable ? round(Math.min(pfWage, PF_WAGE_CEILING) * 0.0833) : 0;
  const epfEmployer = s.pf_applicable ? round(pfBase * 0.12) - eps : 0;
  const esicApplies = fullGross <= ESIC_GROSS_LIMIT;
  const esicEmployee = esicApplies ? Math.ceil(gross * 0.0075) : 0;
  const esicEmployer = esicApplies ? Math.ceil(gross * 0.0325) : 0;
  const slab = o.ptSlabs.find((p) => gross >= Number(p.min_gross) && (p.max_gross == null || gross <= Number(p.max_gross)));
  const pt = slab ? Number(o.month === 2 && slab.feb_amount != null ? slab.feb_amount : slab.amount) : 0;
  const tds = round(annualTaxNewRegime(fullGross * 12) / 12);
  const deductions = { pf: pfEmployee, esic: esicEmployee, professional_tax: pt, income_tax: tds };
  const totalDeductions = Object.values(deductions).reduce((a, b) => a + b, 0);
  return { earnings, gross, deductions, total_deductions: totalDeductions, employer: { epf: epfEmployer, eps, esic: esicEmployer }, net: gross - totalDeductions, full_gross: fullGross };
}
