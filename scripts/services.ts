/** Every domain service definition, in boot order. Setup, the test harness and the integration tests use this list. */
import { identityService } from '../services/identity/src/service.ts';
import { organisationService } from '../services/organisation/src/service.ts';
import { mastersService } from '../services/masters/src/service.ts';
import { governanceService } from '../services/governance/src/service.ts';
import { procurementService } from '../services/procurement/src/service.ts';
import { jobworkService } from '../services/jobwork/src/service.ts';
import { inventoryService } from '../services/inventory/src/service.ts';
import { crmService } from '../services/crm/src/service.ts';
import { commerceService } from '../services/commerce/src/service.ts';
import { fulfilmentService } from '../services/fulfilment/src/service.ts';
import { financeService } from '../services/finance/src/service.ts';
import { workflowService } from '../services/workflow/src/service.ts';
import { hrmsService } from '../services/hrms/src/service.ts';
import { insightsService } from '../services/insights/src/service.ts';

export const SERVICE_DEFS = [governanceService, identityService, organisationService, mastersService, procurementService, jobworkService, inventoryService, crmService, commerceService, fulfilmentService, financeService, workflowService, hrmsService, insightsService];
