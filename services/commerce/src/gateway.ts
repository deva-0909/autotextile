import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, type Client, config, one } from '@erp/platform';

/**
 * Payment gateway adapter. The ERP talks to the bank through three calls (create, verify, refund) and receives
 * signed callbacks. 'sandbox' simulates the bank inside this service so the full flow can be exercised; 'icici'
 * is where the ICICI Bank Payment Gateway API goes once merchant credentials and the API specification are issued.
 */
export interface GatewayStatus { status: 'created' | 'success' | 'failed'; txn_id: string | null; utr: string | null; amount: number }
export interface Gateway {
  name: string;
  createOrder(c: Client, p: { gatewayOrderId: string; amount: number; reference: string; expiresAt: Date }): Promise<void>;
  verify(c: Client, gatewayOrderId: string): Promise<GatewayStatus>;
  refund(c: Client, p: { gatewayOrderId: string; txnId: string; amount: number }): Promise<{ refundId: string; ok: boolean }>;
}

const sandbox: Gateway = {
  name: 'sandbox',
  async createOrder(c, p) {
    await c.query('INSERT INTO gateway_sandbox (gateway_order_id, amount) VALUES ($1, $2)', [p.gatewayOrderId, p.amount]);
  },
  async verify(c, id) {
    const r = await one<{ status: GatewayStatus['status']; txn_id: string | null; utr: string | null; amount: number }>(c, 'SELECT status, txn_id, utr, amount::float FROM gateway_sandbox WHERE gateway_order_id = $1', [id]);
    if (!r) throw new AppError(404, 'not_found', 'Unknown gateway order');
    return r;
  },
  async refund(c, p) {
    await c.query('UPDATE gateway_sandbox SET refunded = refunded + $2 WHERE gateway_order_id = $1', [p.gatewayOrderId, p.amount]);
    return { refundId: `RFND${randomBytes(5).toString('hex').toUpperCase()}`, ok: true };
  },
};

const notConfigured = () => new AppError(503, 'gateway_not_configured', 'ICICI payment gateway is not configured. Set ICICI_MERCHANT_ID, ICICI_API_KEY and ICICI_API_BASE once ICICI issues them, or use PAYMENT_GATEWAY=sandbox.');
const icici: Gateway = {
  name: 'icici',
  async createOrder() { throw notConfigured(); },
  async verify() { throw notConfigured(); },
  async refund() { throw notConfigured(); },
};

export const gateway = (): Gateway => (config.paymentGateway() === 'icici' ? icici : sandbox);

export const sign = (raw: string) => createHmac('sha256', config.paymentWebhookSecret()).update(raw).digest('hex');
export function signatureOk(raw: string, signature: string | undefined) {
  if (!signature) return false;
  const a = Buffer.from(sign(raw), 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const newToken = () => randomBytes(24).toString('hex');
