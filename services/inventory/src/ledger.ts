import { type Client, type Pool, badRequest, conflict, many, notFound, one } from '@erp/platform';
import { round3 } from './common.ts';

/**
 * The only code that changes stock. Each call appends to the immutable stock_movements ledger and updates
 * the roll's current position (a projection of that ledger) in the same transaction.
 */
export type RollState = 'qc_hold' | 'available' | 'reserved' | 'allocated' | 'in_transit' | 'at_mill' | 'damaged' | 'rejected' | 'dispatched' | 'consumed' | 'written_off';
export type MovementType = 'inward' | 'qc' | 'putaway' | 'move' | 'reserve' | 'release' | 'allocate' | 'pick' | 'transfer_out' | 'transfer_in' | 'issue_to_mill' | 'consume_at_mill' | 'split' | 'adjust_in' | 'adjust_out' | 'weight_adjust' | 'damage' | 'write_off' | 'return_in';

/** States that are physically in one of our warehouses. */
export const PHYSICAL: RollState[] = ['qc_hold', 'available', 'reserved', 'allocated', 'damaged', 'rejected'];

export interface Roll {
  id: string; barcode: string; lot_id: string; roll_no: number; parent_roll_id: string | null; product_id: string;
  weight_kg: number; initial_kg: number; state: RollState; warehouse_id: string | null; location_id: string | null; location_path: string | null;
  holder_ref: string | null; grade: string | null; gsm: number | null; width_in: number | null; shade_code: string | null; dye_lot: string | null;
  reservation_id: string | null; transfer_id: string | null; version: number;
}
export interface Actor { id: string | null; name: string }
export interface Ref { type: string; id?: string | null; no?: string | null }

/** Locks a roll by barcode (or id). */
export async function lockRoll(c: Client, code: string): Promise<Roll> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(code);
  const r = await one<Roll>(c, `SELECT * FROM rolls WHERE ${isUuid ? 'id = $1' : 'barcode = upper($1)'} FOR UPDATE`, [code.trim()]);
  if (!r) throw notFound(`Roll ${code}`);
  return r;
}

async function record(c: Client, roll: Pick<Roll, 'id' | 'lot_id' | 'product_id'>, type: MovementType, kg: number,
  from: { wh: string | null; state: string | null; loc: string | null }, to: { wh: string | null; state: string | null; loc: string | null },
  ref: Ref | undefined, reason: string | null | undefined, actor: Actor, movesRoll = true) {
  await c.query(`
    INSERT INTO stock_movements (movement_type, roll_id, lot_id, product_id, kg, moves_roll, from_warehouse_id, from_state, from_location, to_warehouse_id, to_state, to_location, ref_type, ref_id, ref_no, reason, by_user, by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [type, roll.id, roll.lot_id, roll.product_id, round3(kg), movesRoll, from.wh, from.state, from.loc, to.wh, to.state, to.loc, ref?.type ?? null, ref?.id ?? null, ref?.no ?? null, reason ?? null, actor.id, actor.name]);
}

export interface MoveTo {
  state?: RollState;
  /** Defaults to the current warehouse; pass null when the roll leaves our warehouses (dispatched, at mill, consumed, written off). */
  warehouse_id?: string | null;
  location?: { id: string; path: string } | null;
}

/** Moves a whole roll to a new state and/or place. Extra columns (grade, reservation, holder…) are set on the roll alongside. */
export async function moveRoll(c: Client, roll: Roll, type: MovementType, to: MoveTo, opts: { ref?: Ref; reason?: string | null; actor: Actor; set?: Record<string, unknown> }) {
  const state = to.state ?? roll.state;
  const wh = to.warehouse_id === undefined ? roll.warehouse_id : to.warehouse_id;
  const loc = to.location === undefined ? (wh === roll.warehouse_id ? { id: roll.location_id, path: roll.location_path } : null) : to.location;
  await record(c, roll, type, roll.weight_kg, { wh: roll.warehouse_id, state: roll.state, loc: roll.location_path }, { wh, state, loc: loc?.path ?? null }, opts.ref, opts.reason, opts.actor);
  const set: Record<string, unknown> = { state, warehouse_id: wh, location_id: loc?.id ?? null, location_path: loc?.path ?? null, ...opts.set };
  if (['dispatched', 'at_mill', 'in_transit'].includes(state)) set.last_out_at = new Date();
  const cols = Object.keys(set);
  await c.query(`UPDATE rolls SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, [roll.id, ...cols.map((k) => set[k])]);
  Object.assign(roll, set);
}

/** Changes a roll's weight without moving it (re-weighing, partial consumption, stock count). */
export async function adjustWeight(c: Client, roll: Roll, newKg: number, type: MovementType, opts: { ref?: Ref; reason: string; actor: Actor }) {
  const diff = round3(newKg - roll.weight_kg);
  if (Math.abs(diff) < 0.0005) return 0;
  const here = { wh: roll.warehouse_id, state: roll.state, loc: roll.location_path };
  const none = { wh: null, state: null, loc: null };
  if (diff > 0) await record(c, roll, type, diff, none, here, opts.ref, opts.reason, opts.actor, false);
  else await record(c, roll, type, -diff, here, none, opts.ref, opts.reason, opts.actor, false);
  await c.query('UPDATE rolls SET weight_kg = $2, version = version + 1, updated_at = now() WHERE id = $1', [roll.id, round3(newKg)]);
  roll.weight_kg = round3(newKg);
  return diff;
}

async function nextRollNo(c: Client, lotId: string) {
  await c.query('SELECT 1 FROM lots WHERE id = $1 FOR UPDATE', [lotId]);
  const r = await one<{ n: number }>(c, 'SELECT coalesce(max(roll_no), 0) + 1 AS n FROM rolls WHERE lot_id = $1', [lotId]);
  return r!.n;
}

/** Creates a roll in a lot with an inward movement. */
export async function createRoll(c: Client, lot: { id: string; lot_no: string; product_id: string }, r: {
  weight_kg: number; state: RollState; warehouse_id: string | null; location?: { id: string; path: string } | null;
  gsm?: number | null; width_in?: number | null; shade_code?: string | null; dye_lot?: string | null; grade?: string | null; parent_roll_id?: string | null;
}, opts: { type?: MovementType; ref?: Ref; reason?: string | null; actor: Actor }) {
  if (r.weight_kg <= 0) throw badRequest('Roll weight must be more than 0 kg');
  const no = await nextRollNo(c, lot.id);
  const roll = await one<Roll>(c, `
    INSERT INTO rolls (barcode, lot_id, roll_no, parent_roll_id, product_id, weight_kg, initial_kg, state, warehouse_id, location_id, location_path, gsm, width_in, shade_code, dye_lot, grade)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [`${lot.lot_no}-${String(no).padStart(3, '0')}`, lot.id, no, r.parent_roll_id ?? null, lot.product_id, round3(r.weight_kg), r.state, r.warehouse_id,
      r.location?.id ?? null, r.location?.path ?? null, r.gsm ?? null, r.width_in ?? null, r.shade_code ?? null, r.dye_lot ?? null, r.grade ?? null]);
  await record(c, roll!, opts.type ?? 'inward', roll!.weight_kg, { wh: null, state: null, loc: null }, { wh: r.warehouse_id, state: r.state, loc: r.location?.path ?? null },
    opts.ref, opts.reason, opts.actor, true);
  return roll!;
}

/** Cuts part of a roll into a new child roll (partial sale or transfer) so no kg is counted twice. */
export async function splitRoll(c: Client, roll: Roll, kg: number, actor: Actor, reason: string | null) {
  if (!['available', 'qc_hold', 'damaged', 'at_mill'].includes(roll.state)) throw conflict(`A ${roll.state.replace('_', ' ')} roll can’t be split`);
  if (kg <= 0 || kg >= roll.weight_kg - 0.001) throw badRequest(`Split weight must be between 0 and ${roll.weight_kg} kg`);
  const lot = await one<{ id: string; lot_no: string; product_id: string }>(c, 'SELECT id, lot_no, product_id FROM lots WHERE id = $1', [roll.lot_id]);
  await record(c, roll, 'split', kg, { wh: roll.warehouse_id, state: roll.state, loc: roll.location_path }, { wh: null, state: null, loc: null }, { type: 'roll', id: roll.id, no: roll.barcode }, reason, actor, false);
  await c.query('UPDATE rolls SET weight_kg = weight_kg - $2, version = version + 1, updated_at = now() WHERE id = $1', [roll.id, round3(kg)]);
  roll.weight_kg = round3(roll.weight_kg - kg);
  const child = await createRoll(c, lot!, {
    weight_kg: kg, state: roll.state, warehouse_id: roll.warehouse_id, location: roll.location_id ? { id: roll.location_id, path: roll.location_path! } : null,
    gsm: roll.gsm, width_in: roll.width_in, shade_code: roll.shade_code, dye_lot: roll.dye_lot, grade: roll.grade, parent_roll_id: roll.id,
  }, { type: 'split', ref: { type: 'roll', id: roll.id, no: roll.barcode }, reason, actor });
  if (roll.holder_ref) await c.query('UPDATE rolls SET holder_ref = $2 WHERE id = $1', [child.id, roll.holder_ref]);
  return { ...child, holder_ref: roll.holder_ref };
}

/** Compares the roll projection with balances derived from the ledger. Empty means they agree. */
export async function verifyLedger(c: Pool | Client) {
  return many<{ product_id: string; warehouse_id: string | null; state: string; ledger_kg: number; rolls_kg: number; ledger_rolls: number; roll_count: number }>(c, `
    WITH l AS (SELECT product_id, warehouse_id, state, kg, rolls FROM stock_balances),
         r AS (SELECT product_id, warehouse_id, state, round(sum(weight_kg), 3) AS kg, count(*)::int AS rolls FROM rolls GROUP BY 1, 2, 3)
    SELECT coalesce(l.product_id, r.product_id) AS product_id, coalesce(l.warehouse_id, r.warehouse_id) AS warehouse_id, coalesce(l.state, r.state) AS state,
      coalesce(l.kg, 0)::float AS ledger_kg, coalesce(r.kg, 0)::float AS rolls_kg, coalesce(l.rolls, 0) AS ledger_rolls, coalesce(r.rolls, 0) AS roll_count
    FROM l FULL JOIN r ON l.product_id = r.product_id AND l.warehouse_id IS NOT DISTINCT FROM r.warehouse_id AND l.state = r.state
    WHERE abs(coalesce(l.kg, 0) - coalesce(r.kg, 0)) > 0.001 OR coalesce(l.rolls, 0) <> coalesce(r.rolls, 0)`);
}
