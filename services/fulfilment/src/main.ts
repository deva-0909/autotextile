import { bootService, config } from '@erp/platform';
import { fulfilmentService } from './service.ts';
import { startFulfilmentAutomation } from './automation.ts';

const svc = await bootService(fulfilmentService);
startFulfilmentAutomation(svc.ctx.pool);
const port = config.port('fulfilment');
svc.app.listen(port, () => console.log(`[fulfilment] listening on :${port}`));
