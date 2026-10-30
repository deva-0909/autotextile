import { bootService, config } from '@erp/platform';
import { inventoryService } from './service.ts';
import { startInventoryAutomation } from './automation.ts';

const svc = await bootService(inventoryService);
startInventoryAutomation(svc.ctx.pool);
const port = config.port('inventory');
svc.app.listen(port, () => console.log(`[inventory] listening on :${port}`));
