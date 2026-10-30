const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN');

export const fmtINR = (n: number | null | undefined) => (n == null ? '—' : inr.format(n));
export const fmtNum = (n: number | null | undefined, unit = '') => (n == null ? '—' : `${num.format(n)}${unit ? ` ${unit}` : ''}`);
export const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function fmtRelative(s: string | null | undefined) {
  if (!s) return '—';
  const diff = (Date.now() - new Date(s).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(s);
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ACRONYMS = new Set(['ifsc', 'gstin', 'gst', 'pan', 'hsn', 'uom', 'id', 'cin', 'mfa', 'sku', 'moq', 'ca', 'irn', 'tds', 'kg']);
export const humanize = (s: string) =>
  s.replace(/[_.]/g, ' ').split(' ').map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(' ').replace(/^./, (c) => c.toUpperCase());
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Client-side mirror of the server GSTIN check, for instant feedback. */
export function gstinProblem(g: string): string | null {
  const v = g.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return 'Format: 2-digit state, PAN, entity no., Z, check digit';
  if (!GST_STATES[v.slice(0, 2)]) return 'Unknown state code';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(v[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === v[14] ? null : 'Check digit does not match';
}
