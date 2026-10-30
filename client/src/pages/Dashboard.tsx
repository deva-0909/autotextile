import { Link } from 'react-router-dom';
import { type Alert, type Machine, fmtM, fmtTime, useApi } from '../api';
import { Card, Empty, StatusBadge } from '../ui';

interface DashboardData {
  kpis: {
    open_orders: number; wip_lots: number; wip_meters: number; machines_total: number; machines_running: number;
    machines_maintenance: number; utilization_pct: number; qc_pass_rate: number | null; dispatched_meters: number;
    low_stock: number; open_alerts: number;
  };
  stages: { code: string; name: string; queued: number; in_process: number; on_hold: number; meters: number }[];
  recent_events: { id: number; lot_no: string; stage: string; machine_code: string; started_at: string; completed_at: string | null; input_m: number; output_m: number | null }[];
}

export default function Dashboard() {
  const { data } = useApi<DashboardData>('/dashboard');
  const machines = useApi<Machine[]>('/machines');
  const alerts = useApi<Alert[]>('/alerts');
  if (!data) return <p className="muted">Loading…</p>;
  const k = data.kpis;
  const maxMeters = Math.max(1, ...data.stages.map((s) => s.meters));

  return (
    <>
      <h1>Plant overview</h1>
      <div className="kpis">
        <Kpi label="Open orders" value={k.open_orders} />
        <Kpi label="Work in progress" value={fmtM(k.wip_meters)} sub={`${k.wip_lots} lots`} />
        <Kpi label="Machine utilisation" value={`${k.utilization_pct}%`} sub={`${k.machines_running}/${k.machines_total} running · ${k.machines_maintenance} maint.`} />
        <Kpi label="QC first-pass rate" value={k.qc_pass_rate === null ? '—' : `${k.qc_pass_rate}%`} />
        <Kpi label="Dispatched" value={fmtM(k.dispatched_meters)} />
        <Kpi label="Open alerts" value={k.open_alerts} sub={`${k.low_stock} items below reorder`} tone={k.open_alerts ? 'warn' : undefined} />
      </div>

      <Card title="Process flow — WIP by stage">
        <div className="pipeline">
          {data.stages.map((s) => (
            <div className="pipe-stage" key={s.code}>
              <div className="pipe-name">{s.name}</div>
              <div className="pipe-bar"><div style={{ height: `${(s.meters / maxMeters) * 100}%` }} /></div>
              <div className="pipe-m">{fmtM(s.meters)}</div>
              <div className="muted small">{s.in_process} running · {s.queued} queued{s.on_hold ? ` · ${s.on_hold} held` : ''}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Machines" actions={<Link to="/floor">Production floor →</Link>}>
          <div className="machine-grid">
            {machines.data?.map((m) => (
              <div key={m.id} className={`machine machine-${m.status}`}>
                <strong>{m.code}</strong>
                <span className="small muted">{m.lot_no ?? m.status}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Open alerts" actions={<Link to="/alerts">All alerts →</Link>}>
          {alerts.data?.length ? (
            <ul className="alert-list">
              {alerts.data.slice(0, 6).map((a) => (
                <li key={a.id}><StatusBadge status={a.severity} /> {a.message}</li>
              ))}
            </ul>
          ) : <Empty>No open alerts.</Empty>}
        </Card>
      </div>

      <Card title="Recent stage activity">
        <table>
          <thead><tr><th>Lot</th><th>Stage</th><th>Machine</th><th>Started</th><th>Completed</th><th className="num">In</th><th className="num">Out</th></tr></thead>
          <tbody>
            {data.recent_events.map((e) => (
              <tr key={e.id}>
                <td>{e.lot_no}</td><td>{e.stage}</td><td>{e.machine_code}</td>
                <td>{fmtTime(e.started_at)}</td><td>{e.completed_at ? fmtTime(e.completed_at) : <StatusBadge status="running" />}</td>
                <td className="num">{e.input_m}</td><td className="num">{e.output_m ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
