import { config, runService } from '@erp/platform';
import { mastersService } from './service.ts';

await runService(mastersService, config.port('masters'));
