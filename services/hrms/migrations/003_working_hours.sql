-- Working hours per employee, set by HR. Blank means the employee's shift timings apply.
ALTER TABLE employees ADD COLUMN work_start time, ADD COLUMN work_end time;
