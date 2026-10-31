import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { GST_STATES, fmtDate, fmtINR, fmtNum } from '../../lib/format';
import { Button, ErrorState, Skeleton } from '../../components/ui';

interface Inv { invoice_no: string; invoice_date: string; order_no: string; seller: { legal_name: string; gstin: string; state_code: string; warehouse: string; address: string }; buyer: { legal_name: string; gstin: string | null; state_code: string | null; address: { line1: string; city: string; pincode: string | null } | null }; place_of_supply: string | null;
  lines: { line_no: number; sku: string; product_name: string; hsn_code: string; gst_rate: number; rolls: number; kg: number; price_per_kg: number; taxable: number; tax: number }[]; taxable: number; cgst: number; sgst: number; igst: number; total: number; settled: number; shipment: { number: string; transporter_name: string; lr_number: string | null; vehicle_no: string | null; eway_bill_no: string | null } | null; irn: string | null }

/** GST tax invoice, laid out for A4 printing. Opened from the dispatch screens and the customer portal. */
export function InvoicePage({ back }: { back?: string }) {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Inv>(`/fulfilment/invoices/${encodeURIComponent(id)}`) });
  if (q.isError) return <ErrorState error={q.error} />;
  const v = q.data;
  if (!v) return <Skeleton className="h-96" />;
  return <PrintableInvoice v={v} back={back} />;
}

function PrintableInvoice({ v, back }: { v: Inv; back?: string }) {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 300);
    return () => clearTimeout(t);
  }, [printing]);
  const sheet = <Sheet v={v} />;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">{back ? <Link to={back} className="link text-[13px]">← Back</Link> : <span />}<Button icon={<Printer className="size-4" />} onClick={() => setPrinting(true)}>Print</Button></div>
      {sheet}
      {printing && createPortal(<div className="print-only">{sheet}</div>, document.body)}
    </div>
  );
}

function Sheet({ v }: { v: Inv }): ReactNode {
  const intra = v.cgst > 0;
  return (
    <div>
      <div className="invoice-sheet mx-auto max-w-[210mm] bg-white p-8 text-[12px] text-slate-900 shadow-sm ring-1 ring-slate-200 print:shadow-none print:ring-0">
        <div className="flex items-start justify-between border-b border-slate-300 pb-4">
          <div><p className="text-[16px] font-bold">{v.seller.legal_name}</p><p>{v.seller.warehouse}</p><p>{v.seller.address}</p><p className="mt-1">GSTIN <b className="font-mono">{v.seller.gstin}</b> · State {v.seller.state_code} ({GST_STATES[v.seller.state_code]})</p></div>
          <div className="text-right"><p className="text-[18px] font-bold tracking-wide">TAX INVOICE</p><p className="font-mono text-[13px] font-semibold">{v.invoice_no}</p><p>Date {fmtDate(v.invoice_date)}</p><p>Order {v.order_no}</p></div>
        </div>
        <div className="grid grid-cols-2 gap-6 border-b border-slate-300 py-4">
          <div><p className="text-[10.5px] font-semibold text-slate-500 uppercase">Bill to</p><p className="font-semibold">{v.buyer.legal_name}</p>{v.buyer.address && <p>{v.buyer.address.line1}, {v.buyer.address.city} {v.buyer.address.pincode}</p>}<p>GSTIN <span className="font-mono">{v.buyer.gstin ?? 'Unregistered'}</span></p></div>
          <div><p className="text-[10.5px] font-semibold text-slate-500 uppercase">Place of supply</p><p>{v.place_of_supply} · {GST_STATES[v.place_of_supply ?? ''] ?? '—'} ({intra ? 'intra-state' : 'inter-state'})</p>
            {v.shipment && <><p className="mt-2 text-[10.5px] font-semibold text-slate-500 uppercase">Transport</p><p>{v.shipment.transporter_name}{v.shipment.lr_number ? ` · LR ${v.shipment.lr_number}` : ''}{v.shipment.vehicle_no ? ` · ${v.shipment.vehicle_no}` : ''}</p>{v.shipment.eway_bill_no && <p>E-way bill {v.shipment.eway_bill_no}</p>}</>}
          </div>
        </div>
        <table className="mt-4 w-full border-collapse">
          <thead><tr className="border-y border-slate-300 bg-slate-50 text-left text-[10.5px] uppercase"><th className="py-1.5 pr-2">#</th><th className="pr-2">Description</th><th className="pr-2">HSN</th><th className="pr-2 text-right">Rolls</th><th className="pr-2 text-right">KG</th><th className="pr-2 text-right">Rate/kg</th><th className="pr-2 text-right">Taxable</th><th className="pr-2 text-right">GST</th><th className="text-right">Tax</th></tr></thead>
          <tbody>{v.lines.map((l) => <tr key={l.line_no} className="border-b border-slate-200"><td className="py-1.5 pr-2">{l.line_no}</td><td className="pr-2">{l.product_name}<span className="block font-mono text-[10.5px] text-slate-500">{l.sku}</span></td><td className="pr-2">{l.hsn_code}</td><td className="pr-2 text-right">{l.rolls}</td><td className="pr-2 text-right tabular">{fmtNum(Number(l.kg))}</td><td className="pr-2 text-right tabular">{fmtNum(Number(l.price_per_kg))}</td><td className="pr-2 text-right tabular">{fmtNum(Number(l.taxable))}</td><td className="pr-2 text-right">{Number(l.gst_rate)}%</td><td className="text-right tabular">{fmtNum(Number(l.tax))}</td></tr>)}</tbody>
        </table>
        <div className="mt-4 ml-auto w-72 space-y-1 text-[12.5px]">
          <div className="flex justify-between"><span>Taxable value</span><span className="tabular">{fmtINR(v.taxable)}</span></div>
          {intra ? <><div className="flex justify-between"><span>CGST</span><span className="tabular">{fmtINR(v.cgst)}</span></div><div className="flex justify-between"><span>SGST</span><span className="tabular">{fmtINR(v.sgst)}</span></div></> : <div className="flex justify-between"><span>IGST</span><span className="tabular">{fmtINR(v.igst)}</span></div>}
          <div className="flex justify-between border-t border-slate-300 pt-1 text-[14px] font-bold"><span>Invoice total</span><span className="tabular">{fmtINR(v.total)}</span></div>
          <div className="flex justify-between text-slate-600"><span>Received / adjusted</span><span className="tabular">{fmtINR(v.settled)}</span></div>
        </div>
        <p className="mt-8 text-[10.5px] text-slate-500">{v.irn ? `IRN ${v.irn}` : 'E-invoice IRN not generated: GSP/IRP integration pending (required above the e-invoicing turnover threshold).'} This is a computer-generated invoice.</p>
      </div>
    </div>
  );
}
