import type { Request } from 'express';
import { type AuthUser, type Pool, callService, many, notify, signAccessToken, tx } from '@erp/platform';
import { type Definition, S, runReport } from './data.ts';

/**
 * Scheduled reports run with the owner's current permissions and data scope (a short-lived token for that person),
 * store a snapshot and notify the recipients. Email delivery waits for an email provider.
 */
export async function runScheduledReports(pool: Pool) {
  const due = await many<{ id: string; name: string; definition: Definition; owner_id: string; recipients: string[]; schedule: string }>(pool, `SELECT * FROM reports WHERE schedule <> 'none' AND next_run_at <= now() ORDER BY next_run_at LIMIT 20`);
  let ran = 0;
  for (const r of due) {
    const next = new Date(); next.setUTCHours(1, 30, 0, 0);
    if (r.schedule === 'daily') next.setUTCDate(next.getUTCDate() + 1); else if (r.schedule === 'weekly') next.setUTCDate(next.getUTCDate() + 7); else next.setUTCMonth(next.getUTCMonth() + 1, 1);
    try {
      const owner = await callService<AuthUser>(S, 'identity', 'GET', `/users/${r.owner_id}/auth-profile`);
      const token = await signAccessToken(owner, '10m');
      const fakeReq = { headers: { authorization: `Bearer ${token}` }, user: owner } as unknown as Request;
      const out = await runReport(fakeReq, r.definition);
      await tx(pool, async (c) => {
        const s = await c.query(`INSERT INTO report_snapshots (report_id, result, row_count) VALUES ($1,$2,$3) RETURNING id`, [r.id, JSON.stringify({ columns: out.columns, rows: out.rows.slice(0, 2000), totals: out.totals }), out.result_rows]);
        await c.query('UPDATE reports SET last_run_at = now(), next_run_at = $2 WHERE id = $1', [r.id, next.toISOString()]);
        for (const u of new Set([r.owner_id, ...r.recipients])) await notify(c, S, { user_id: u, kind: 'info', title: `Report ready: ${r.name}`, body: `${out.result_rows} rows`, link: `/insights/reports/${r.id}?snapshot=${s.rows[0].id}` });
      });
      ran++;
    } catch (e) {
      await pool.query('UPDATE reports SET next_run_at = $2 WHERE id = $1', [r.id, next.toISOString()]);
      console.error(`[insights] scheduled report ${r.name} failed:`, (e as Error).message);
    }
  }
  return { ran };
}

export function startInsightsAutomation(pool: Pool) {
  const run = () => runScheduledReports(pool).catch((e) => console.error('[insights] scheduler failed', (e as Error).message));
  setTimeout(run, 45_000);
  setInterval(run, 15 * 60_000).unref();
}
