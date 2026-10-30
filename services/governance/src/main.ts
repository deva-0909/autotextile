import { config, runService } from '@erp/platform';
import { governanceService } from './service.ts';

await runService(governanceService, config.port('governance'));
