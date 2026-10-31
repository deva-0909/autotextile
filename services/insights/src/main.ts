import { bootService, config } from '@erp/platform';
import { insightsService } from './service.ts';
import { startInsightsAutomation } from './automation.ts';

const svc = await bootService(insightsService);
startInsightsAutomation(svc.ctx.pool);
const port = config.port('insights');
svc.app.listen(port, () => console.log(`[insights] listening on :${port}`));
