/** Demo mode: the role switcher's endpoints exist only with DEMO_MODE=1 and sign in without a password. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
before(async () => { process.env.DEMO_MODE = '1'; h = await bootAll('demo'); });
after(async () => { delete process.env.DEMO_MODE; await h.close(); });

describe('demo mode', () => {
  test('lists active users, owner first and partner portals last', async () => {
    const r = await h.call(null, 'GET', '/identity/auth/demo-users');
    assert.equal(r.status, 200);
    assert.equal(r.body[0].email, 'owner@textile.local');
    assert.ok(r.body.at(-1).portal);
    assert.ok(r.body.every((u: { email: string }) => !('password_hash' in u)));
  });
  test('signs in as a user without a password, with that user’s own permissions', async () => {
    const r = await h.call(null, 'POST', '/identity/auth/demo-login', { email: 'sales@textile.local' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, 'sales@textile.local');
    assert.equal((await h.call(r.body.accessToken, 'GET', '/finance/vouchers')).status, 403, 'a sales executive still cannot open the books');
    assert.equal((await h.call(null, 'POST', '/identity/auth/demo-login', { email: 'nobody@textile.local' })).status, 401);
  });
});
