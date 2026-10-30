import { bootService, config } from '@erp/platform';
import { jobworkService } from './service.ts';
import { startJobworkAutomation } from './automation.ts';

const svc = await bootService(jobworkService);
startJobworkAutomation(svc.ctx.pool);
const port = config.port('jobwork');
svc.app.listen(port, () => console.log(`[jobwork] listening on :${port}`));
