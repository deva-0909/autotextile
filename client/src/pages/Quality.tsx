import { useState } from 'react';
import { api, type Defect, fmtM, fmtTime, type Inspection, type Lot, type Meta, useAction, useApi } from '../api';
import { Card, Empty, StatusBadge } from '../ui';

function rate(total: number, m: number, widthCm: number) {
  return (total * 3600) / (m * 1.09361 * (widthCm / 2.54));
}

export default function Quality() {
  const meta = useApi<Meta>('/meta');
  const lots = useApi<Lot[]>('/lots?stage=INSPECTION&status=in_process');
  const history = useApi<Inspection[]>('/inspections');
  return (
    <>
      <h1>Quality control — 4-point inspection</h1>
      <p className="muted">
        Points per 100 sq yd = total points × 3600 ÷ (yards inspected × width in inches). Limit: {meta.data?.qc_pass_limit ?? 40}.
        Failing lots go back to finishing once; a second failure rejects the lot.
      </p>
      <Card title="Lots on inspection frames">
        {lots.data?.length ? lots.data.map((l) => <InspectForm key={l.id} lot={l} meta={meta.data} />) : <Empty>No lots on inspection frames right now.</Empty>}
      </Card>
      <Card title="Inspection history">
        <table>
          <thead><tr><th>Lot</th><th>Customer</th><th>When</th><th className="num">Inspected</th><th>Defects</th><th className="num">Pts/100 sq yd</th><th>Result</th><th>Inspector</th></tr></thead>
          <tbody>
            {history.data?.map((i) => (
              <tr key={i.id}>
                <td>{i.lot_no}</td><td>{i.customer}</td><td>{fmtTime(i.created_at)}</td><td className="num">{fmtM(i.inspected_m)}</td>
                <td className="small">{i.defects.filter((d) => d.count).map((d) => `${d.type} ${d.points}pt×${d.count}`).join(', ') || '—'}</td>
                <td className="num">{i.points_per_100sqyd}</td><td><StatusBadge status={i.result} /></td><td>{i.inspector ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function InspectForm({ lot, meta }: { lot: Lot; meta?: Meta }) {
  const types = meta?.defect_types ?? [];
  const [inspector, setInspector] = useState('');
  const [defects, setDefects] = useState<Defect[]>([{ type: types[0] ?? 'Slub', points: 1, count: 0 }]);
  const submit = useAction(() => api(`/lots/${lot.id}/inspection`, { method: 'POST', body: { defects, inspector: inspector || undefined } }));
  const total = defects.reduce((s, d) => s + d.points * d.count, 0);
  const r = rate(total, lot.quantity_m, lot.width_cm ?? 150);
  const limit = meta?.qc_pass_limit ?? 40;
  const update = (i: number, patch: Partial<Defect>) => setDefects(defects.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <div className="inspect">
      <div className="inspect-head">
        <strong>{lot.lot_no}</strong>
        <span className="muted small">{lot.customer} · {lot.fabric} · {fmtM(lot.quantity_m)} × {lot.width_cm} cm{lot.rework_count ? ' · re-inspection' : ''}</span>
      </div>
      {defects.map((d, i) => (
        <div className="defect-row" key={i}>
          <select value={d.type} onChange={(e) => update(i, { type: e.target.value })}>
            {types.map((t) => <option key={t}>{t}</option>)}
          </select>
          <select value={d.points} onChange={(e) => update(i, { points: +e.target.value })}>
            <option value={1}>1 pt (≤ 3″)</option><option value={2}>2 pt (3–6″)</option>
            <option value={3}>3 pt (6–9″)</option><option value={4}>4 pt (&gt; 9″ / hole)</option>
          </select>
          <input type="number" min={0} value={d.count} onChange={(e) => update(i, { count: Math.max(0, Math.floor(+e.target.value)) })} aria-label="count" />
          <button className="ghost" onClick={() => setDefects(defects.filter((_, j) => j !== i))} disabled={defects.length === 1}>Remove</button>
        </div>
      ))}
      <div className="inspect-foot">
        <button className="ghost" onClick={() => setDefects([...defects, { type: types[0], points: 1, count: 0 }])}>Add defect</button>
        <input placeholder="Inspector" value={inspector} onChange={(e) => setInspector(e.target.value)} />
        <span>Total {total} pts → <strong className={r > limit ? 'overdue' : 'ok'}>{r.toFixed(2)} pts/100 sq yd ({r > limit ? 'FAIL' : 'PASS'})</strong></span>
        <button onClick={() => submit.mutate()} disabled={submit.isPending}>Record inspection</button>
      </div>
    </div>
  );
}
