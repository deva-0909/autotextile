import { Link, useParams } from 'react-router-dom';
import { api, fmtM, fmtTime, type Inspection, type Lot, type Meta, type Order, PRIORITY, type StageEvent, useAction, useApi } from '../api';
import { Card, StatusBadge } from '../ui';

type Detail = Order & { lots: Lot[]; events: StageEvent[]; inspections: Inspection[]; remaining_hours: number };

export default function OrderDetail() {
  const { id } = useParams();
  const { data: o, error } = useApi<Detail>(`/orders/${id}`);
  const meta = useApi<Meta>('/meta');
  const dispatch = useAction((lotId: number) => api(`/lots/${lotId}/dispatch`, { method: 'POST' }));
  if (error) return <p className="error">{error.message}</p>;
  if (!o || !meta.data) return <p className="muted">Loading…</p>;
  const stages = meta.data.stages.filter((s) => o.shade_code || s.code !== 'DYEING');

  return (
    <>
      <p><Link to="/orders">← Orders</Link></p>
      <h1>{o.order_no} <StatusBadge status={o.status} /></h1>
      <div className="facts">
        <div><span>Customer</span>{o.customer}</div>
        <div><span>Fabric</span>{o.fabric}, {o.gsm} gsm, {o.width_cm} cm</div>
        <div><span>Shade</span>{o.shade_code ?? 'Undyed'}</div>
        <div><span>Quantity</span>{fmtM(o.quantity_m)}</div>
        <div><span>Due</span>{o.due_date} · {PRIORITY[o.priority]}</div>
        <div><span>Est. machine-hours left</span>{o.remaining_hours}</div>
      </div>

      <Card title="Lots">
        <table>
          <thead><tr><th>Lot</th><th className="num">Qty</th><th>Progress</th><th>Stage</th><th>Machine</th><th>Status</th><th /></tr></thead>
          <tbody>
            {o.lots.map((l) => {
              const idx = stages.findIndex((s) => s.code === l.stage);
              const done = ['ready', 'dispatched'].includes(l.status) ? stages.length : idx;
              return (
                <tr key={l.id}>
                  <td>{l.lot_no}{l.rework_count > 0 && <span className="muted small"> (rework ×{l.rework_count})</span>}</td>
                  <td className="num">{fmtM(l.quantity_m)}</td>
                  <td>
                    <div className="steps" title={`${done}/${stages.length} stages done`}>
                      {stages.map((s, i) => <span key={s.code} className={i < done ? 'done' : i === idx && l.status !== 'rejected' ? 'current' : ''} />)}
                    </div>
                  </td>
                  <td>{meta.data.stages.find((s) => s.code === l.stage)?.name}</td>
                  <td>{l.machine_code ?? '—'}</td>
                  <td><StatusBadge status={l.status} />{l.hold_reason && <div className="small muted">{l.hold_reason}</div>}</td>
                  <td>{l.status === 'ready' && <button onClick={() => dispatch.mutate(l.id)}>Dispatch</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {o.inspections.length > 0 && (
        <Card title="QC inspections">
          <table>
            <thead><tr><th>Lot</th><th>When</th><th className="num">Points</th><th className="num">Pts/100 sq yd</th><th>Result</th></tr></thead>
            <tbody>
              {o.inspections.map((i) => (
                <tr key={i.id}><td>{i.lot_no}</td><td>{fmtTime(i.created_at)}</td><td className="num">{i.total_points}</td><td className="num">{i.points_per_100sqyd}</td><td><StatusBadge status={i.result} /></td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Process history">
        <table>
          <thead><tr><th>Lot</th><th>Stage</th><th>Machine</th><th>Started</th><th>Completed</th><th className="num">In (m)</th><th className="num">Out (m)</th><th className="num">Loss</th></tr></thead>
          <tbody>
            {o.events.map((e) => (
              <tr key={e.id}>
                <td>{e.lot_no}</td><td>{e.stage}</td><td>{e.machine_code}</td>
                <td>{fmtTime(e.started_at)}</td><td>{fmtTime(e.completed_at)}</td>
                <td className="num">{e.input_m}</td><td className="num">{e.output_m ?? '—'}</td>
                <td className="num">{e.output_m != null ? `${(((e.input_m - e.output_m) / e.input_m) * 100).toFixed(2)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
