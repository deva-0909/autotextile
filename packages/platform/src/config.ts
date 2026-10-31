import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const SERVICES = ['identity', 'organisation', 'masters', 'governance', 'procurement', 'jobwork', 'inventory', 'crm', 'commerce', 'fulfilment', 'finance'] as const;
export type ServiceName = (typeof SERVICES)[number];

export const config = {
  databaseUrl: () => env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/textile_erp'),
  jwtSecret: () => env('JWT_SECRET', 'dev-only-secret-change-me'),
  /** Optional: enables AI invoice extraction. Without it, invoices are keyed in manually on the review screen. */
  anthropicKey: () => process.env.ANTHROPIC_API_KEY || null,
  /** Payment gateway: 'sandbox' simulates the bank; 'icici' needs the merchant credentials below. */
  paymentGateway: () => (process.env.PAYMENT_GATEWAY ?? 'sandbox') as 'sandbox' | 'icici',
  paymentWebhookSecret: () => env('PAYMENT_WEBHOOK_SECRET', 'dev-only-webhook-secret'),
  storageDir: () => path.resolve(ROOT_DIR, env('STORAGE_DIR', './storage')),
  port: (service: ServiceName | 'gateway') =>
    Number(env(`${service.toUpperCase()}_PORT`, String({ gateway: 4000, identity: 4101, organisation: 4102, masters: 4103, governance: 4104, procurement: 4105, jobwork: 4106, inventory: 4107, crm: 4108, commerce: 4109, fulfilment: 4110, finance: 4111 }[service]))),
};
