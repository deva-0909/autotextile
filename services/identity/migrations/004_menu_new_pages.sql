-- New pages joining the default menus of the roles that use them.
UPDATE menu_access SET items = array_append(items, '/finance/payment-run')
WHERE scope = 'role' AND ref IN ('accounts_manager', 'accounts_executive') AND NOT ('/finance/payment-run' = ANY(items));
