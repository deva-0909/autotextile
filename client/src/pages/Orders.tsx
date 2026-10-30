import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtM, type Order, PRIORITY, type Recipe, useAction, useApi } from '../api';
import { Card, StatusBadge } from '../ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function Orders() {
  const orders = useApi<Order[]>('/orders');
  const [showForm, setShowForm] = useState(false);
  return (
    <>
      <h1>Sales orders</h1>
      <Card title="Orders" actions={<button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : 'New order'}</button>}>
        {showForm && <NewOrderForm onDone={() => setShowForm(false)} />}
        <table>
          <thead>
            <tr><th>Order</th><th>Customer</th><th>Fabric</th><th>Shade</th><th className="num">Qty</th><th>Due</th><th>Priority</th><th>Lots</th><th>Status</th></tr>
          </thead>
          <tbody>
            {orders.data?.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/orders/${o.id}`}>{o.order_no}</Link></td>
                <td>{o.customer}</td>
                <td>{o.fabric} <span className="muted small">{o.gsm} gsm · {o.width_cm} cm</span></td>
                <td>{o.shade_code ?? <span className="muted">Undyed</span>}</td>
                <td className="num">{fmtM(o.quantity_m)}</td>
                <td className={o.status !== 'completed' && o.due_date < today() ? 'overdue' : ''}>{o.due_date}</td>
                <td>{PRIORITY[o.priority]}</td>
                <td>{o.lots_dispatched}/{o.lot_count} shipped{o.lots_rejected ? `, ${o.lots_rejected} rejected` : ''}</td>
                <td><StatusBadge status={o.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function NewOrderForm({ onDone }: { onDone: () => void }) {
  const recipes = useApi<Recipe[]>('/recipes');
  const [f, setF] = useState({
    customer: '', fabric: '', gsm: '120', width_cm: '150', shade_code: '', quantity_m: '2000',
    due_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), priority: '2',
  });
  const create = useAction(() =>
    api('/orders', {
      method: 'POST',
      body: { ...f, gsm: +f.gsm, width_cm: +f.width_cm, quantity_m: +f.quantity_m, priority: +f.priority, shade_code: f.shade_code || null },
    }),
  );
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <label>Customer<input required value={f.customer} onChange={set('customer')} /></label>
      <label>Fabric quality<input required value={f.fabric} onChange={set('fabric')} placeholder="e.g. Cotton Poplin 40x40" /></label>
      <label>GSM<input type="number" min="1" required value={f.gsm} onChange={set('gsm')} /></label>
      <label>Width (cm)<input type="number" min="1" required value={f.width_cm} onChange={set('width_cm')} /></label>
      <label>Shade
        <select value={f.shade_code} onChange={set('shade_code')}>
          <option value="">Undyed (skip dyeing)</option>
          {recipes.data?.map((r) => <option key={r.shade_code} value={r.shade_code}>{r.shade_code} — {r.name}</option>)}
        </select>
      </label>
      <label>Quantity (m)<input type="number" min="1" required value={f.quantity_m} onChange={set('quantity_m')} /></label>
      <label>Due date<input type="date" required value={f.due_date} onChange={set('due_date')} /></label>
      <label>Priority
        <select value={f.priority} onChange={set('priority')}>
          <option value="1">Urgent</option><option value="2">Normal</option><option value="3">Low</option>
        </select>
      </label>
      <div className="form-actions">
        <button type="submit" disabled={create.isPending}>Create order &amp; plan lots</button>
        <span className="muted small">Orders are split into lots of up to 1,500 m and scheduled automatically.</span>
      </div>
    </form>
  );
}
