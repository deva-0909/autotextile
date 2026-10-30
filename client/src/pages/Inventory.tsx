import { api, fmtTime, type Item, useAction, useApi } from '../api';
import { Card, StatusBadge } from '../ui';

interface Txn { id: number; code: string; name: string; unit: string; qty: number; reason: string; created_at: string }

export default function Inventory() {
  const items = useApi<Item[]>('/inventory');
  const txns = useApi<Txn[]>('/inventory/txns');
  const receive = useAction(({ id, qty }: { id: number; qty: number }) => api(`/inventory/${id}/receive`, { method: 'POST', body: { qty } }));

  const onReceive = (i: Item) => {
    const qty = window.prompt(`Receive ${i.name} (${i.unit})`, String(Math.max(i.reorder_level * 2, 10)));
    if (qty) receive.mutate({ id: i.id, qty: Number(qty) });
  };

  return (
    <>
      <h1>Inventory — yarn, dyes &amp; chemicals</h1>
      <p className="muted">Dyes and chemicals are issued automatically when a lot starts dyeing. Receiving stock auto-releases lots held for shortage.</p>
      <Card title="Stock">
        <table>
          <thead><tr><th>Code</th><th>Item</th><th>Category</th><th className="num">On hand</th><th className="num">Reorder level</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.data?.map((i) => (
              <tr key={i.id}>
                <td>{i.code}</td><td>{i.name}</td><td>{i.category}</td>
                <td className="num">{i.qty_on_hand.toFixed(1)} {i.unit}</td><td className="num">{i.reorder_level} {i.unit}</td>
                <td>{i.qty_on_hand <= i.reorder_level ? <StatusBadge status="warning" /> : <StatusBadge status="pass" />}</td>
                <td><button className="ghost" onClick={() => onReceive(i)}>Receive</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Recent movements">
        <table>
          <thead><tr><th>When</th><th>Item</th><th className="num">Qty</th><th>Reason</th></tr></thead>
          <tbody>
            {txns.data?.map((t) => (
              <tr key={t.id}>
                <td>{fmtTime(t.created_at)}</td><td>{t.name}</td>
                <td className={`num ${t.qty < 0 ? 'overdue' : 'ok'}`}>{t.qty > 0 ? '+' : ''}{t.qty.toFixed(3)} {t.unit}</td><td>{t.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
