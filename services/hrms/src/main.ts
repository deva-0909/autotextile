import { bootService, config } from '@erp/platform';
import { hrmsService } from './service.ts';
import { startHrAutomation } from './automation.ts';

const svc = await bootService(hrmsService);
startHrAutomation(svc.ctx.pool);
const port = config.port('hrms');
svc.app.listen(port, () => console.log(`[hrms] listening on :${port}`));
