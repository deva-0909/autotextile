-- Pages added with lead management and the operations release, given to the roles that already use the pages next
-- to them (sales: My day and lead pages; accounts: manual invoices, counter sales, cash book, mill deductions; anyone
-- who sees shipments, receivables or sales orders: sales invoices; mill operations: mill losses).
UPDATE menu_access SET items = array_append(items, '/crm/my-day') WHERE scope = 'role' AND items && ARRAY['/crm/leads'] AND NOT ('/crm/my-day' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/crm/lead-tools') WHERE scope = 'role' AND items && ARRAY['/crm/allocation'] AND NOT ('/crm/lead-tools' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/crm/reports') WHERE scope = 'role' AND items && ARRAY['/crm/allocation', '/crm/performance'] AND NOT ('/crm/reports' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/crm/settings') WHERE scope = 'role' AND items && ARRAY['/crm/allocation'] AND NOT ('/crm/settings' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/crm/agents') WHERE scope = 'role' AND items && ARRAY['/crm/allocation', '/finance/payables'] AND NOT ('/crm/agents' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/fulfilment/invoices') WHERE scope = 'role' AND items && ARRAY['/fulfilment/shipments', '/finance/receivables', '/commerce/orders'] AND NOT ('/fulfilment/invoices' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/finance/invoices') WHERE scope = 'role' AND items && ARRAY['/finance/vouchers'] AND NOT ('/finance/invoices' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/finance/cash-book') WHERE scope = 'role' AND items && ARRAY['/finance/vouchers'] AND NOT ('/finance/cash-book' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/finance/counter') WHERE scope = 'role' AND items && ARRAY['/finance/vouchers', '/fulfilment/shipments'] AND NOT ('/finance/counter' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/finance/mill-deductions') WHERE scope = 'role' AND items && ARRAY['/finance/payables'] AND NOT ('/finance/mill-deductions' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/jobwork/losses') WHERE scope = 'role' AND items && ARRAY['/jobwork/claims'] AND NOT ('/jobwork/losses' = ANY(items));
