import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { fmtINR } from '../lib/format';
import { Button, IconButton } from './ui';

export interface ProductOption { id: string; sku: string; name: string; gst_rate: number; status: string; uom_code: string }
export interface PartyOption { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; status: string }

export const useProducts = () => useQuery({ queryKey: ['product-options'], queryFn: () => api.get<Page<ProductOption>>('/masters/products?pageSize=200&f_status=active&sort=sku').then((r) => r.items), staleTime: 60_000 });
export const useParties = (types: string) => useQuery({ queryKey: ['party-options', types], queryFn: () => api.get<Page<PartyOption>>(`/masters/parties?pageSize=200&f_type=${types}&f_status=active&sort=legal_name`).then((r) => r.items), staleTime: 60_000 });
export const useWarehouses = () => useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<{ id: string; code: string; name: string; status: string; gst_registration_id: string; gstin: string }[]>('/organisation/warehouses'), staleTime: 60_000 });

export interface Line { product_id: string; qty_kg: string; rate?: string; notes?: string }

/** Editable table of product lines (KG, optional rate) used by requisitions, RFQs and POs. */
export function LineEditor({ lines, onChange, withRate, rateLabel = 'Rate / kg', error }: { lines: Line[]; onChange: (l: Line[]) => void; withRate?: boolean; rateLabel?: string; error?: string }) {
  const products = useProducts();
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.qty_kg) || 0) * (Number(l.rate) || 0), 0);
  const kg = lines.reduce((s, l) => s + (Number(l.qty_kg) || 0), 0);
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-slate-50 text-[11px] tracking-wide text-slate-500 uppercase">
            <tr><th className="px-3 py-2">Fabric SKU</th><th className="w-28 px-3 py-2 text-right">KG</th>{withRate && <th className="w-32 px-3 py-2 text-right">{rateLabel}</th>}{withRate && <th className="w-32 px-3 py-2 text-right">Amount</th>}<th className="w-10" /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l, i) => {
              const p = products.data?.find((x) => x.id === l.product_id);
              return (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <select aria-label="Fabric" className="input h-8 text-[13px]" value={l.product_id} onChange={(e) => set(i, { product_id: e.target.value })}>
                      <option value="">Select fabric…</option>
                      {products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                    </select>
                    {p && <p className="mt-0.5 pl-1 text-[11px] text-slate-400">GST {p.gst_rate}%</p>}
                  </td>
                  <td className="px-2 py-1.5"><input className="input h-8 text-right text-[13px] tabular" type="number" min={0} step="0.001" value={l.qty_kg} onChange={(e) => set(i, { qty_kg: e.target.value })} /></td>
                  {withRate && <td className="px-2 py-1.5"><input className="input h-8 text-right text-[13px] tabular" type="number" min={0} step="0.01" value={l.rate ?? ''} onChange={(e) => set(i, { rate: e.target.value })} /></td>}
                  {withRate && <td className="px-3 py-1.5 text-right text-slate-700 tabular">{fmtINR((Number(l.qty_kg) || 0) * (Number(l.rate) || 0))}</td>}
                  <td className="px-1"><IconButton label="Remove line" disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-slate-200 bg-slate-50/60 text-[12.5px] font-medium">
            <tr><td className="px-3 py-2"><Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => onChange([...lines, { product_id: '', qty_kg: '', rate: '' }])}>Add line</Button></td><td className="px-3 py-2 text-right tabular">{kg.toLocaleString('en-IN')} kg</td>{withRate && <td />}{withRate && <td className="px-3 py-2 text-right tabular">{fmtINR(total)}</td>}<td /></tr>
          </tfoot>
        </table>
      </div>
      {error && <p className="mt-1.5 text-xs font-medium text-rose-600">{error}</p>}
    </div>
  );
}

export const emptyLine = (): Line => ({ product_id: '', qty_kg: '', rate: '' });

/** Deliver-to picker: a warehouse, or a processing mill for direct-to-mill purchases. */
export function DeliverTo({ type, id, onChange, error }: { type: 'warehouse' | 'mill'; id: string; onChange: (t: 'warehouse' | 'mill', id: string) => void; error?: string }) {
  const wh = useWarehouses();
  const mills = useParties('mill');
  return (
    <div>
      <p className="label">Deliver to<span className="ml-0.5 text-rose-500">*</span></p>
      <div className="flex gap-2">
        <select aria-label="Source type" className="input w-44" value={type} onChange={(e) => onChange(e.target.value as 'warehouse' | 'mill', '')}>
          <option value="warehouse">Our warehouse</option>
          <option value="mill">Processing mill (direct)</option>
        </select>
        <select aria-label="Source" className={`input flex-1 ${error ? 'input-error' : ''}`} value={id} onChange={(e) => onChange(type, e.target.value)}>
          <option value="">Select…</option>
          {type === 'warehouse' ? wh.data?.filter((w) => w.status === 'active').map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)
            : mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.legal_name}</option>)}
        </select>
      </div>
      {type === 'mill' && <p className="mt-1.5 text-xs text-slate-500">Grey fabric goes straight to the mill. The mill confirms receipt on its portal and the material stays trader-owned stock at the mill.</p>}
      {error && <p className="mt-1.5 text-xs font-medium text-rose-600">{error}</p>}
    </div>
  );
}

export const linesPayload = (lines: Line[], withRate = false) =>
  lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, qty_kg: Number(l.qty_kg), ...(withRate ? { rate_per_kg: Number(l.rate) } : {}) }));
