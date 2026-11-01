import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtINR } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Button, Card, Input, PageHeader, Skeleton, StatusBadge } from '../../components/ui';

interface Row { id: string; invoice_no: string; invoice_date: string; order_no: string; order_id: string; customer_name: string; warehouse_code: string; status: string; taxable: number; gst: number; total: number; settled: number }

/** Every GST tax invoice raised at dispatch. Each opens as the printable invoice (print or save as PDF). */
export function SalesInvoicesPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['ful-invoices', q], queryFn: () => api.get<Row[]>(`/fulfilment/invoices${q.trim().length >= 2 ? `?q=${encodeURIComponent(q.trim())}` : ''}`) });
  return (
    <>
      <PageHeader title="Sales invoices" description="GST tax invoices raised at dispatch. Open one to see it as printed, then print or save it as PDF."
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Sales invoices' }]}
        actions={<Input placeholder="Invoice, order or customer" value={q} onChange={(e) => setQ(e.target.value)} />} />
      {!list.data ? <Skeleton className="h-60" /> : (
        <Card padded={false}><SimpleTable rows={list.data} rowKey={(r) => r.id} csvName="sales-invoices" empty="No invoices yet" onRowClick={(r) => nav(`/fulfilment/invoices/${r.id}`)} columns={[
          { key: 'n', header: 'Invoice', render: (r) => <span className="font-mono text-[12px]">{r.invoice_no}</span> },
          { key: 'd', header: 'Date', render: (r) => fmtDate(r.invoice_date) },
          { key: 'c', header: 'Customer', render: (r) => r.customer_name },
          { key: 'o', header: 'Order', render: (r) => <span className="font-mono text-[12px]">{r.order_no}</span> },
          { key: 'w', header: 'From', render: (r) => r.warehouse_code },
          { key: 't', header: 'Taxable', align: 'right', render: (r) => fmtINR(r.taxable) },
          { key: 'g', header: 'GST', align: 'right', render: (r) => fmtINR(r.gst) },
          { key: 'v', header: 'Total', align: 'right', render: (r) => <b>{fmtINR(r.total)}</b> },
          { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'p', header: '', render: (r) => <Button size="sm" icon={<Printer className="size-3.5" />} onClick={(e) => { e.stopPropagation(); nav(`/fulfilment/invoices/${r.id}`); }}>Print</Button> },
        ]} /></Card>
      )}
    </>
  );
}
