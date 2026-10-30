import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { CheckCircle2, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, humanize } from '../lib/format';
import { useToast } from '../components/overlay';
import { Avatar, Badge, Button, Card, Input, KeyValue, Notice, PageHeader } from '../components/ui';
import { PasswordRules } from './Login';

interface Me { id: string; name: string; email: string; designation: string | null; mfa_enabled: boolean; last_login_at: string | null; roles: string[]; permissions: string[]; scope: Record<string, '*' | string[]> }

export function AccountPage() {
  const { reload } = useAuth();
  const toast = useToast();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/identity/me') });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [disableCode, setDisableCode] = useState('');

  useEffect(() => { setCode(''); setMfaError(null); }, [setup]);
  if (!me.data) return null;
  const m = me.data;

  return (
    <>
      <PageHeader title="Account & security" breadcrumbs={[{ label: 'Account' }]} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card>
          <div className="flex items-center gap-4">
            <Avatar name={m.name} size="lg" />
            <div><p className="text-[16px] font-semibold">{m.name}</p><p className="text-[13px] text-slate-500">{m.email}</p></div>
          </div>
          <div className="mt-6">
            <KeyValue columns={1} items={[
              { label: 'Designation', value: m.designation },
              { label: 'Roles', value: <span className="flex flex-wrap gap-1">{m.roles.map((r) => <Badge key={r} tone="brand">{humanize(r)}</Badge>)}</span> },
              { label: 'Permissions', value: `${m.permissions.length} granted` },
              { label: 'Warehouse scope', value: m.scope.warehouse === '*' ? 'All warehouses' : `${(m.scope.warehouse as string[]).length} warehouse(s)` },
              { label: 'Last sign-in', value: fmtDateTime(m.last_login_at) },
            ]} />
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Smartphone className="size-4" />Two-step verification</span>} description="Use Google Authenticator, Microsoft Authenticator or any TOTP app.">
          {m.mfa_enabled ? (
            <div className="space-y-4">
              <Notice tone="success" icon={<CheckCircle2 className="size-4" />} title="MFA is on">You’ll be asked for a code each time you sign in.</Notice>
              <Input label="To turn it off, enter a current code" value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))} maxLength={6} />
              <Button variant="danger" disabled={disableCode.length !== 6} onClick={async () => {
                try { await api.post('/identity/me/mfa/disable', { code: disableCode }); setDisableCode(''); me.refetch(); toast({ tone: 'warning', title: 'MFA turned off' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
              }}>Turn off MFA</Button>
            </div>
          ) : setup ? (
            <div className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-[13px] text-slate-600"><li>Scan the QR code with your authenticator app.</li><li>Enter the 6-digit code it shows.</li></ol>
              <div className="flex justify-center rounded-lg border border-slate-200 bg-white p-3"><img src={setup.qr} alt="MFA QR code" className="size-44" /></div>
              <p className="text-center font-mono text-[11.5px] break-all text-slate-500">{setup.secret}</p>
              {mfaError && <Notice tone="danger">{mfaError}</Notice>}
              <Input label="Verification code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="font-mono" />
              <div className="flex gap-2">
                <Button onClick={() => setSetup(null)}>Cancel</Button>
                <Button variant="primary" disabled={code.length !== 6} onClick={async () => {
                  try { await api.post('/identity/me/mfa/enable', { code }); setSetup(null); me.refetch(); toast({ tone: 'success', title: 'MFA enabled' }); } catch (e) { setMfaError((e as Error).message); }
                }}>Verify and enable</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Notice tone="warning" icon={<ShieldCheck className="size-4" />}>MFA is required for privileged users by policy. Enable it to protect your account.</Notice>
              <Button variant="primary" onClick={async () => {
                const r = await api.post<{ secret: string; otpauthUrl: string }>('/identity/me/mfa/setup');
                setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 352 }) });
              }}>Set up MFA</Button>
            </div>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4" />Change password</span>} description="Other sessions are signed out when you change it.">
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            setPwError(null);
            try { await api.post('/identity/me/password', pw); setPw({ current: '', next: '' }); await reload(); toast({ tone: 'success', title: 'Password changed' }); } catch (err) { setPwError((err as Error).message); }
          }}>
            {pwError && <Notice tone="danger">{pwError}</Notice>}
            <Input label="Current password" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <Input label="New password" type="password" autoComplete="new-password" required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <PasswordRules value={pw.next} />
            <Button type="submit" variant="primary">Update password</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
