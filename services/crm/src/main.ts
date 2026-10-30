import { bootService, config } from '@erp/platform';
import { crmService } from './service.ts';
import { startCrmAutomation } from './automation.ts';

const svc = await bootService(crmService);
startCrmAutomation(svc.ctx.pool);
const port = config.port('crm');
svc.app.listen(port, () => console.log(`[crm] listening on :${port}`));
