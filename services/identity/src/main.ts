import { bootService, config } from '@erp/platform';
import { identityService, syncRoles } from './service.ts';

const svc = await bootService(identityService);
await syncRoles(svc.ctx.pool);
const port = config.port('identity');
svc.app.listen(port, () => console.log(`[identity] listening on :${port}`));
