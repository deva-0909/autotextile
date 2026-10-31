import { bootService, config } from '@erp/platform';
import { financeService } from './service.ts';
import { startFinanceAutomation } from './automation.ts';

const svc = await bootService(financeService);
startFinanceAutomation(svc.ctx.pool);
const port = config.port('finance');
svc.app.listen(port, () => console.log(`[finance] listening on :${port}`));
