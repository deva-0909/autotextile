import { bootService, config } from '@erp/platform';
import { goliveService } from './service.ts';
import { seedScenarios } from './readiness.ts';

const svc = await bootService(goliveService);
await seedScenarios(svc.ctx.pool);
const port = config.port('golive');
svc.app.listen(port, () => console.log(`[golive] listening on :${port}`));
