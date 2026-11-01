-- HR pages added in the role audit: the salary register sits with payroll, the holiday calendar with attendance.
UPDATE menu_access SET items = array_append(items, '/hr/salaries')
WHERE scope = 'role' AND '/hr/payroll' = ANY(items) AND NOT ('/hr/salaries' = ANY(items));
UPDATE menu_access SET items = array_append(items, '/hr/holidays')
WHERE scope = 'role' AND '/hr/attendance' = ANY(items) AND NOT ('/hr/holidays' = ANY(items));
