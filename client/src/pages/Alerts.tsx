import { useState } from 'react';
import { type Alert, api, fmtTime, useAction, useApi } from '../api';
import { Card, Empty, StatusBadge } from '../ui';

export default function Alerts() {
  const [all, setAll] = useState(false);
  const alerts = useApi<Alert[]>(`/alerts${all ? '?all=1' : ''}`);
  const ack = useAction((id: number) => api(`/alerts/${id}/ack`, { method: 'POST' }));
  const run = useAction(() => api('/automation/run', { method: 'POST' }));
  return (
    <>
      <h1>Alerts</h1>
      <p className="muted">Raised automatically for material shortages, process loss over limit, QC rework/rejects, low stock, due-date risk and overdue orders.</p>
      <Card
        actions={
          <div className="row">
            <label className="toggle"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show acknowledged</label>
            <button className="ghost" onClick={() => run.mutate()}>Run checks now</button>
          </div>
        }
      >
        {alerts.data?.length ? (
          <table>
            <thead><tr><th>Severity</th><th>Type</th><th>Message</th><th>Raised</th><th /></tr></thead>
            <tbody>
              {alerts.data.map((a) => (
                <tr key={a.id} className={a.acknowledged ? 'muted' : ''}>
                  <td><StatusBadge status={a.severity} /></td><td>{a.kind.replace('_', ' ')}</td><td>{a.message}</td><td>{fmtTime(a.created_at)}</td>
                  <td>{!a.acknowledged && <button className="ghost" onClick={() => ack.mutate(a.id)}>Acknowledge</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No alerts.</Empty>}
      </Card>
    </>
  );
}
