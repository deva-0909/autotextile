import { bootService, config } from '@erp/platform';
import { workflowService } from './service.ts';
import { startWorkflowAutomation } from './automation.ts';

const svc = await bootService(workflowService);
startWorkflowAutomation(svc.ctx.pool);
const port = config.port('workflow');
svc.app.listen(port, () => console.log(`[workflow] listening on :${port}`));
