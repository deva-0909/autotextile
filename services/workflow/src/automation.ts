import type { Pool } from '@erp/platform';
import { dispatchMessages } from './messaging.ts';
import { runScheduled } from './engine.ts';
import { runContractChecks } from './contracts.ts';

/** Message sending every 20 seconds; delayed actions and escalations every minute; contract renewals hourly. */
export function startWorkflowAutomation(pool: Pool) {
  const log = (what: string) => (e: unknown) => console.error(`[workflow] ${what} failed`, (e as Error).message);
  setInterval(() => void dispatchMessages(pool).catch(log('dispatch')), 20_000).unref();
  setInterval(() => void runScheduled(pool).catch(log('scheduler')), 60_000).unref();
  setTimeout(() => void runContractChecks(pool).catch(log('contracts')), 30_000);
  setInterval(() => void runContractChecks(pool).catch(log('contracts')), 60 * 60_000).unref();
}
