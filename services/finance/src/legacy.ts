import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { addDays, books, getParty, primaryBook, round2 } from './common.ts';
import { post, type TaxLine } from './ledger.ts';

/**
 * Go-live: invoices and bills from the previous system (sales and purchase history for the months before the ERP),
 * posted exactly as live documents post (voucher, GST register lines, bill) on their original dates, plus their
 * settlement where already paid. Marked as migrated, idempotent on party and document number.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.object({
  kind: z.enum(['sale', 'purchase']),
  party_id: z.uuid(),
  doc_no: reqText(40),
  doc_date: isoDate,
  due_date: isoDate.nullable().optional(),
  our_gstin: optText(15),
  lines: z.array(z.object({ sku: optText(40), hsn: optText(10), kg: z.number().positive(), rate: z.number().positive(), gst_rate: z.number().min(0).max(28) })).min(1).max(50),
  settled_on: isoDate.nullable().optional(),
  settle_ref: optText(60),
});

export function legacyRoutes(r: Router, { pool }: ServiceContext) {
  r.post('/legacy-documents', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(body, req.body);
    const today = new Date().toISOString().slice(0, 10);
    if (b.doc_date > today) throw badRequest('A migrated document cannot be dated in the future');
    if (b.settled_on && (b.settled_on < b.doc_date || b.settled_on > today)) throw badRequest('settled_on must be between the document date and today');
    const party = await getParty(b.party_id);
    const out = await tx(pool, async (c) => {
      const all = await books(c);
      const book = (b.our_gstin && all.find((x) => x.gstin === b.our_gstin!.toUpperCase())) || (await primaryBook(c));
      const intra = !party.state_code || party.state_code === book.state_code;
      const sale = b.kind === 'sale';
      const lines = b.lines.map((l) => {
        const taxable = round2(l.kg * l.rate), tax = round2((taxable * l.gst_rate) / 100);
        const cgst = intra ? round2(tax / 2) : 0;
        return { ...l, taxable, cgst, sgst: intra ? round2(tax - cgst) : 0, igst: intra ? 0 : tax };
      });
      const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => round2(lines.reduce((s, l) => s + l[k], 0));
      const taxable = sum('taxable'), cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst');
      const total = round2(taxable + cgst + sgst + igst);
      const tax: TaxLine[] = lines.map((l) => ({
        direction: sale ? 'outward' : 'inward', doc_type: 'invoice', doc_no: b.doc_no, doc_date: b.doc_date, party_id: party.id, party_name: party.legal_name, party_gstin: party.gstin,
        place_of_supply: sale ? party.state_code : book.state_code, hsn: l.hsn ?? null, rate: l.gst_rate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
        itc_eligible: !sale, sku: l.sku ?? null, qty_kg: l.kg,
      }));
      const id = `${party.id}:${b.doc_no}`;
      const control = sale ? 'receivables' : 'payables';
      const v = await post(c, {
        type: sale ? 'sales' : 'purchase', book_id: book.id, date: b.doc_date, by: req.user!.name, approved_by: 'go-live migration',
        narration: `${sale ? 'Sales invoice' : 'Purchase bill'} ${b.doc_no} — ${party.legal_name} (migrated from the previous system)`, party_id: party.id, party_name: party.legal_name,
        source: { service: 'golive', type: sale ? 'legacy_sale' : 'legacy_purchase', id, ref: b.doc_no },
        lines: sale
          ? [{ account: 'receivables', debit: total, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }, { account: 'sales', credit: taxable },
            { account: 'output_cgst', credit: cgst }, { account: 'output_sgst', credit: sgst }, { account: 'output_igst', credit: igst }]
          : [{ account: 'purchases', debit: taxable }, { account: 'input_cgst', debit: cgst }, { account: 'input_sgst', debit: sgst }, { account: 'input_igst', debit: igst },
            { account: 'payables', credit: total, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }],
        tax, bill: { kind: sale ? 'receivable' : 'payable', party_id: party.id, party_name: party.legal_name, doc_no: b.doc_no, doc_date: b.doc_date, due_date: b.due_date ?? addDays(b.doc_date, 30), amount: total },
      });
      let settled: string | null = null;
      if (b.settled_on) {
        const s = await post(c, {
          type: sale ? 'receipt' : 'payment', book_id: book.id, date: b.settled_on, by: req.user!.name, approved_by: 'go-live migration',
          narration: `${sale ? 'Receipt from' : 'Payment to'} ${party.legal_name} against ${b.doc_no}${b.settle_ref ? ` · ${b.settle_ref}` : ''} (migrated)`, party_id: party.id, party_name: party.legal_name,
          source: { service: 'golive', type: sale ? 'legacy_receipt' : 'legacy_payment', id, ref: b.doc_no },
          lines: sale
            ? [{ account: 'bank_main', debit: total }, { account: control, credit: total, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }]
            : [{ account: control, debit: total, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }, { account: 'bank_main', credit: total }],
        });
        settled = s.number;
      }
      return { voucher_number: v.number, existing: !!v.existing, settlement_number: settled, total, taxable };
    });
    res.status(201).json(out);
  });
}
