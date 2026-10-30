import { Link } from 'react-router-dom';
import { api, fmtM, type Lot, type Machine, type Meta, useAction, useApi } from '../api';
import { Badge, Card, StatusBadge } from '../ui';

export default function Floor() {
  const meta = useApi<Meta>('/meta');
  const machines = useApi<Machine[]>('/machines');
  const lots = useApi<Lot[]>('/lots');
  const complete = useAction(({ id, output_m }: { id: number; output_m: number }) =>
    api(`/lots/${id}/complete`, { method: 'POST', body: { output_m } }),
  );
  const setStatus = useAction(({ id, status }: { id: number; status: string }) =>
    api(`/machines/${id}`, { method: 'PATCH', body: { status } }),
  );
  const release = useAction((id: number) => api(`/lots/${id}/release`, { method: 'POST' }));
  const hold = useAction((id: number) => api(`/lots/${id}/hold`, { method: 'POST', body: { reason: 'Manual hold' } }));
  const dispatch = useAction((id: number) => api(`/lots/${id}/dispatch`, { method: 'POST' }));

  if (!meta.data || !machines.data || !lots.data) return <p className="muted">Loading…</p>;
  const ready = lots.data.filter((l) => l.status === 'ready');

  const onComplete = (m: Machine) => {
    const input = window.prompt(`Output metres for ${m.lot_no} (input ${m.lot_quantity_m} m)`, String(m.lot_quantity_m));
    if (input === null) return;
    complete.mutate({ id: m.lot_id!, output_m: Number(input) });
  };

  return (
    <>
      <h1>Production floor</h1>
      <p className="muted">
        Lots are dispatched to idle machines automatically — urgent orders first, then earliest due date.
        Completing a stage routes the lot to the next process.
      </p>
      <div className="board">
        {meta.data.stages.map((stage) => {
          const stageMachines = machines.data.filter((m) => m.stage === stage.code);
          const stageLots = lots.data.filter((l) => l.stage === stage.code && ['queued', 'on_hold'].includes(l.status));
          return (
            <div className="column" key={stage.code}>
              <h3>{stage.name}</h3>
              {stageMachines.map((m) => (
                <div key={m.id} className={`mcard machine-${m.status}`}>
                  <div className="mcard-head">
                    <strong>{m.code}</strong>
                    <StatusBadge status={m.status} />
                  </div>
                  <div className="small muted">{m.name} · {m.capacity_m_per_hr} m/h</div>
                  {m.lot_no && <div className="mcard-lot">{m.lot_no} · {fmtM(m.lot_quantity_m!)}</div>}
                  <div className="mcard-actions">
                    {m.status === 'running' && stage.code !== 'INSPECTION' && <button onClick={() => onComplete(m)}>Complete</button>}
                    {m.status === 'running' && stage.code === 'INSPECTION' && <Link className="button" to="/quality">Inspect</Link>}
                    {m.status === 'idle' && <button className="ghost" onClick={() => setStatus.mutate({ id: m.id, status: 'maintenance' })}>Maintenance</button>}
                    {m.status === 'maintenance' && <button className="ghost" onClick={() => setStatus.mutate({ id: m.id, status: 'idle' })}>Back online</button>}
                  </div>
                </div>
              ))}
              <div className="queue-label">Queue ({stageLots.length})</div>
              {stageLots.map((l) => (
                <div key={l.id} className={`lcard ${l.status === 'on_hold' ? 'lcard-hold' : ''}`}>
                  <div className="mcard-head">
                    <Link to={`/orders/${l.order_id}`}>{l.lot_no}</Link>
                    {l.priority === 1 && <Badge tone="bad">urgent</Badge>}
                  </div>
                  <div className="small muted">{fmtM(l.quantity_m)} · due {l.due_date}</div>
                  {l.hold_reason && <div className="small hold">{l.hold_reason}</div>}
                  <div className="mcard-actions">
                    {l.status === 'on_hold'
                      ? <button className="ghost" onClick={() => release.mutate(l.id)}>Release</button>
                      : <button className="ghost" onClick={() => hold.mutate(l.id)}>Hold</button>}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        <div className="column">
          <h3>Ready to dispatch</h3>
          {ready.map((l) => (
            <div key={l.id} className="lcard">
              <Link to={`/orders/${l.order_id}`}>{l.lot_no}</Link>
              <div className="small muted">{fmtM(l.quantity_m)} · {l.customer}</div>
              <div className="mcard-actions"><button onClick={() => dispatch.mutate(l.id)}>Dispatch</button></div>
            </div>
          ))}
          {!ready.length && <p className="small muted">Nothing packed yet.</p>}
        </div>
      </div>
      <Card><span className="small muted">Tip: use “Run one step” in the sidebar to simulate the shift.</span></Card>
    </>
  );
}
