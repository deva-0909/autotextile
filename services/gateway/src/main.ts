import { config } from '@erp/platform';
import { createGateway } from './app.ts';

const port = config.port('gateway');
createGateway().listen(port, () => console.log(`[gateway] listening on :${port} — open http://localhost:${port}`));
