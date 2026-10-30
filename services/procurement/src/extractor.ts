import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '@erp/platform';

const str = z.object({ value: z.string().nullable(), confidence: z.number() });
const num = z.object({ value: z.number().nullable(), confidence: z.number() });

/** What Claude returns for one supplier invoice. Confidence is 0–1 per field. */
export const ExtractionSchema = z.object({
  is_tax_invoice: z.boolean(),
  supplier_name: str,
  supplier_gstin: str,
  buyer_gstin: str,
  invoice_number: str,
  invoice_date: str,
  po_reference: str,
  place_of_supply: str,
  taxable_value: num,
  cgst: num,
  sgst: num,
  igst: num,
  total_value: num,
  lines: z.array(z.object({
    description: z.string(),
    hsn_code: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    rate: z.number().nullable(),
    taxable_value: z.number().nullable(),
    gst_rate: z.number().nullable(),
    confidence: z.number(),
  })),
  notes: z.string().nullable(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You read Indian GST supplier tax invoices received by a knitted-fabric trading company and transcribe them into structured data.

Transcribe what is printed; do not infer or correct values. If a field is not present or not legible, return null with confidence 0.
Confidence (0 to 1) reflects how certain you are that the value is exactly what the document says: 0.95+ for clear printed text, around 0.7 for partly legible or ambiguous values, below 0.5 for guesses.
- Dates as YYYY-MM-DD. Indian invoices usually print DD/MM/YYYY or DD-MM-YY.
- Amounts as plain numbers in rupees, without currency symbols or thousands separators.
- GSTINs are 15 characters; copy them exactly in upper case. The supplier is the seller who issued the invoice; the buyer is the billed party.
- po_reference: the buyer's purchase order number if printed (often labelled PO No., Order No. or Buyer's Order).
- Line quantity and unit as printed (fabric is usually in KG; note rolls or metres in the unit field). rate is per unit, before tax. gst_rate is the percentage.
- CGST, SGST and IGST are invoice-level totals; use 0 only if the invoice explicitly shows zero, otherwise null when absent.
- is_tax_invoice is false for proformas, quotations, delivery challans or anything that is not a tax invoice. Mention such issues in notes.
- For multi-page invoices, combine all pages into one invoice.`;

let client: Anthropic | null = null;
export const aiEnabled = () => !!config.anthropicKey();

export class ExtractionFailed extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export async function extractInvoice(file: Buffer, mime: string): Promise<Extraction> {
  client ??= new Anthropic({ apiKey: config.anthropicKey()!, maxRetries: 2, timeout: 180_000 });
  const data = file.toString('base64');
  const source: Anthropic.Beta.BetaContentBlockParam =
    mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : (IMAGE_TYPES as readonly string[]).includes(mime)
        ? { type: 'image', source: { type: 'base64', media_type: mime as (typeof IMAGE_TYPES)[number], data } }
        : (() => { throw new ExtractionFailed(`AI extraction supports PDF and images, not ${mime}`, false); })();
  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // Server-side fallback keeps extraction running if a safety classifier declines a document.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: betaZodOutputFormat(ExtractionSchema) },
      messages: [{ role: 'user', content: [source, { type: 'text', text: 'Extract this supplier invoice.' }] }],
    });
    if (response.stop_reason === 'refusal') throw new ExtractionFailed('The model declined to read this document', false);
    if (response.stop_reason === 'max_tokens') throw new ExtractionFailed('The invoice is too long to extract in one pass', false);
    if (!response.parsed_output) throw new ExtractionFailed('The model did not return structured data', true);
    return response.parsed_output;
  } catch (err) {
    if (err instanceof ExtractionFailed) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new ExtractionFailed('ANTHROPIC_API_KEY is invalid or lacks access', false);
    if (err instanceof Anthropic.BadRequestError) throw new ExtractionFailed(`Document rejected: ${err.message}`, false);
    if (err instanceof Anthropic.RateLimitError) throw new ExtractionFailed('Rate limited by the AI service; will retry', true);
    if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) throw new ExtractionFailed('AI service unavailable; will retry', true);
    if (err instanceof Anthropic.APIError) throw new ExtractionFailed(`AI service error ${err.status}: ${err.message}`, (err.status ?? 500) >= 500);
    throw err;
  }
}
