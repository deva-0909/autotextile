import { config, runService } from '@erp/platform';
import { organisationService } from './service.ts';

await runService(organisationService, config.port('organisation'));
