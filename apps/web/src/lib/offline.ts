import { useEffect, useState } from 'react';
import { ApiError, api } from './api';

/**
 * Offline capture for warehouse floor actions (put-away moves). When the network is down the action is kept on the
 * device and sent, in order, as soon as the connection returns; the server validates it then exactly as if it had
 * been sent live, so nothing financial or dispatch-related is ever released offline.
 */
const KEY = 'erp.offline.queue.v1';
export interface Queued { id: string; path: string; body: object; label: string; at: number }
const read = (): Queued[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Queued[]; } catch { return []; } };
const write = (q: Queued[]) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage unavailable */ } window.dispatchEvent(new Event('erp-offline-queue')); };
const isNetwork = (e: unknown) => !(e instanceof ApiError) || (typeof navigator !== 'undefined' && !navigator.onLine);

export async function postOrQueue(path: string, body: object, label: string): Promise<'sent' | 'queued'> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) { write([...read(), { id: crypto.randomUUID(), path, body, label, at: Date.now() }]); return 'queued'; }
  try { await api.post(path, body); return 'sent'; }
  catch (e) { if (!isNetwork(e)) throw e; write([...read(), { id: crypto.randomUUID(), path, body, label, at: Date.now() }]); return 'queued'; }
}

let flushing = false;
/** Send queued actions in order. A server refusal (stock moved meanwhile, bin full) is reported and dropped. */
export async function flushQueue() {
  if (flushing) return { sent: 0, rejected: [] as { item: Queued; error: string }[] };
  flushing = true;
  const rejected: { item: Queued; error: string }[] = [];
  let sent = 0;
  try {
    for (const item of read()) {
      try { await api.post(item.path, item.body); sent++; }
      catch (e) { if (isNetwork(e)) break; rejected.push({ item, error: (e as Error).message }); }
      write(read().filter((x) => x.id !== item.id));
    }
  } finally { flushing = false; }
  return { sent, rejected };
}

export function useOfflineQueue(onResult?: (r: Awaited<ReturnType<typeof flushQueue>>) => void) {
  const [items, setItems] = useState<Queued[]>(read);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const sync = () => setItems(read());
    const up = () => { setOnline(true); void flushQueue().then((r) => { sync(); if (r.sent || r.rejected.length) onResult?.(r); }); };
    const down = () => setOnline(false);
    window.addEventListener('erp-offline-queue', sync); window.addEventListener('online', up); window.addEventListener('offline', down);
    if (navigator.onLine && read().length) up();
    return () => { window.removeEventListener('erp-offline-queue', sync); window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { items, online };
}
