import { bootService, config } from '@erp/platform';
import { procurementService } from './service.ts';
import { startCaptureWorker } from './capture.ts';
import { startProcurementAutomation } from './automation.ts';

const svc = await bootService(procurementService);
startCaptureWorker(svc.ctx.pool);
startProcurementAutomation(svc.ctx.pool);
const port = config.port('procurement');
svc.app.listen(port, () => console.log(`[procurement] listening on :${port}${config.anthropicKey() ? ' (AI invoice extraction on)' : ' (AI extraction off: set ANTHROPIC_API_KEY)'}`));
