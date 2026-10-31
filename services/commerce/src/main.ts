import { bootService, config } from '@erp/platform';
import { commerceService } from './service.ts';
import { startCommerceAutomation } from './automation.ts';

const svc = await bootService(commerceService);
startCommerceAutomation(svc.ctx.pool);
const port = config.port('commerce');
svc.app.listen(port, () => console.log(`[commerce] listening on :${port} (payment gateway: ${config.paymentGateway()})`));
