import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function useApi<T>(path: string | null) {
  return useQuery({ queryKey: [path], queryFn: () => api<T>(path!), enabled: path !== null });
}

/** POST/PATCH helper that refreshes every query on success (the shop floor is highly interconnected). */
export function useAction<V = void>(fn: (vars: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: Error) => alert(e.message),
  });
}

export interface Stage { code: string; name: string; maxLossPct: number }
export interface Meta { stages: Stage[]; defect_types: string[]; qc_pass_limit: number; max_lot_m: number }
export interface Order {
  id: number; order_no: string; customer: string; fabric: string; gsm: number; width_cm: number;
  shade_code: string | null; quantity_m: number; due_date: string; priority: number; status: string; created_at: string;
  lot_count?: number; lots_dispatched?: number; lots_rejected?: number;
}
export interface Lot {
  id: number; lot_no: string; order_id: number; quantity_m: number; stage: string; status: string;
  machine_id: number | null; machine_code?: string | null; rework_count: number; hold_reason: string | null; updated_at: string;
  order_no?: string; customer?: string; fabric?: string; shade_code?: string | null; due_date?: string; priority?: number; width_cm?: number;
}
export interface Machine {
  id: number; code: string; name: string; stage: string; capacity_m_per_hr: number; status: string;
  lot_id: number | null; lot_no: string | null; lot_quantity_m: number | null; started_at: string | null;
}
export interface StageEvent {
  id: number; lot_id: number; lot_no: string; stage: string; machine_code: string | null;
  started_at: string; completed_at: string | null; input_m: number; output_m: number | null;
}
export interface Defect { type: string; points: number; count: number }
export interface Inspection {
  id: number; lot_id: number; lot_no: string; order_no?: string; customer?: string; inspected_m: number; width_cm: number;
  defects: Defect[]; total_points: number; points_per_100sqyd: number; result: string; inspector: string | null; created_at: string;
}
export interface Item { id: number; code: string; name: string; category: string; unit: string; qty_on_hand: number; reorder_level: number }
export interface RecipeLine { item_code: string; basis: 'owf' | 'gpl'; amount: number }
export interface Recipe { shade_code: string; name: string; liquor_ratio: number; lines: RecipeLine[] }
export interface Alert { id: number; kind: string; severity: string; message: string; ref: string; acknowledged: number; created_at: string }

export const fmtM = (m: number) => `${Math.round(m).toLocaleString()} m`;
export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const PRIORITY = { 1: 'Urgent', 2: 'Normal', 3: 'Low' } as Record<number, string>;
