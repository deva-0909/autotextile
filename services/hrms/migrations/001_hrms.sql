-- HRMS (P9): employee lifecycle, recruitment, shifts and attendance, leave and comp-off, payroll with Indian statutory deductions.

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE, name text NOT NULL,
  start_time time NOT NULL, end_time time NOT NULL, grace_minutes int NOT NULL DEFAULT 10,
  hours numeric NOT NULL DEFAULT 8
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  user_id uuid UNIQUE,
  name text NOT NULL, email text, phone text,
  designation text NOT NULL, department text NOT NULL,
  location text NOT NULL,
  manager_id uuid REFERENCES employees(id),
  date_of_joining date NOT NULL, probation_months int NOT NULL DEFAULT 6, confirmed_on date,
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','probation','active','notice','exited')),
  resignation_date date, last_working_day date, exit_reason text, exited_on date,
  pan text, uan text, esic_no text, bank_account text, ifsc text,
  shift_id uuid REFERENCES shifts(id), weekly_off int NOT NULL DEFAULT 0 CHECK (weekly_off BETWEEN 0 AND 6),
  pt_state text NOT NULL DEFAULT '24',
  overtime_eligible boolean NOT NULL DEFAULT false,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE salary_structures (
  employee_id uuid NOT NULL REFERENCES employees(id),
  effective_from date NOT NULL,
  basic numeric NOT NULL CHECK (basic >= 0), hra numeric NOT NULL DEFAULT 0, conveyance numeric NOT NULL DEFAULT 0, special numeric NOT NULL DEFAULT 0, other numeric NOT NULL DEFAULT 0,
  pf_applicable boolean NOT NULL DEFAULT true, pf_on_capped_wage boolean NOT NULL DEFAULT true,
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, effective_from)
);

CREATE TABLE employee_events (
  id bigserial PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  kind text NOT NULL, detail text, effective_date date, by_name text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  stage text NOT NULL CHECK (stage IN ('onboarding','exit')),
  item text NOT NULL, done boolean NOT NULL DEFAULT false, done_by_name text, done_at timestamptz
);

CREATE TABLE openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL, department text NOT NULL, location text NOT NULL, positions int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','on_hold','closed')),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id uuid NOT NULL REFERENCES openings(id),
  name text NOT NULL, phone text, email text, source text,
  stage text NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','screening','interview','offer','hired','rejected')),
  notes text, employee_id uuid REFERENCES employees(id),
  updated_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE holidays (day date NOT NULL, name text NOT NULL, state_code text, PRIMARY KEY (day, name));

CREATE TABLE attendance (
  employee_id uuid NOT NULL REFERENCES employees(id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','half_day','leave','weekly_off','holiday')),
  in_time time, out_time time, late_minutes int NOT NULL DEFAULT 0, overtime_minutes int NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','biometric','mobile','import','leave')),
  lat numeric, lng numeric, note text,
  marked_by_name text, marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, day)
);

CREATE TABLE leave_types (
  code text PRIMARY KEY, name text NOT NULL, annual_quota numeric NOT NULL DEFAULT 0, paid boolean NOT NULL DEFAULT true, carry_forward boolean NOT NULL DEFAULT false
);
CREATE TABLE leave_balances (
  employee_id uuid NOT NULL REFERENCES employees(id), leave_type text NOT NULL REFERENCES leave_types(code), fy text NOT NULL,
  entitled numeric NOT NULL DEFAULT 0, used numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, leave_type, fy)
);
CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  leave_type text NOT NULL REFERENCES leave_types(code),
  from_date date NOT NULL, to_date date NOT NULL CHECK (to_date >= from_date), half_day boolean NOT NULL DEFAULT false,
  days numeric NOT NULL CHECK (days > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  applied_by_name text NOT NULL, decided_by_name text, decided_at timestamptz, comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE comp_offs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  worked_on date NOT NULL, days numeric NOT NULL, expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','used','expired')),
  UNIQUE (employee_id, worked_on)
);

CREATE TABLE pt_slabs (
  state_code text NOT NULL, min_gross numeric NOT NULL, max_gross numeric, amount numeric NOT NULL, feb_amount numeric,
  PRIMARY KEY (state_code, min_gross)
);

CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL UNIQUE CHECK (extract(day FROM month) = 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','paid')),
  employees int NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0, deductions numeric NOT NULL DEFAULT 0, net numeric NOT NULL DEFAULT 0, employer_cost numeric NOT NULL DEFAULT 0,
  totals jsonb NOT NULL DEFAULT '{}',
  prepared_by_name text, approved_by_name text, approved_at timestamptz, paid_on date, paid_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  employee_code text NOT NULL, employee_name text NOT NULL, designation text, department text, location text, pan text, uan text, bank_account text, ifsc text,
  days_in_month int NOT NULL, paid_days numeric NOT NULL, lop_days numeric NOT NULL, overtime_hours numeric NOT NULL DEFAULT 0,
  earnings jsonb NOT NULL, gross numeric NOT NULL,
  deductions jsonb NOT NULL, total_deductions numeric NOT NULL,
  employer jsonb NOT NULL, net numeric NOT NULL,
  UNIQUE (run_id, employee_id)
);

CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL);

INSERT INTO shifts (code, name, start_time, end_time, grace_minutes, hours) VALUES
 ('GEN', 'General (office)', '09:30', '18:30', 15, 8), ('WH1', 'Warehouse morning', '08:00', '16:30', 10, 8), ('WH2', 'Warehouse evening', '14:00', '22:30', 10, 8);
INSERT INTO leave_types (code, name, annual_quota, paid, carry_forward) VALUES
 ('CL', 'Casual leave', 8, true, false), ('SL', 'Sick leave', 8, true, false), ('EL', 'Earned leave', 15, true, true), ('CO', 'Compensatory off', 0, true, false), ('LOP', 'Leave without pay', 0, false, false);
-- Professional tax (monthly, on gross). Gujarat, West Bengal and Tamil Nadu (TN levies half-yearly; shown as the monthly equivalent). Confirm with the payroll consultant.
INSERT INTO pt_slabs (state_code, min_gross, max_gross, amount, feb_amount) VALUES
 ('24', 0, 11999, 0, NULL), ('24', 12000, NULL, 200, NULL),
 ('19', 0, 10000, 0, NULL), ('19', 10001, 15000, 110, NULL), ('19', 15001, 25000, 130, NULL), ('19', 25001, 40000, 150, NULL), ('19', 40001, NULL, 200, NULL),
 ('33', 0, 21000, 0, NULL), ('33', 21001, 30000, 30, NULL), ('33', 30001, 45000, 85, NULL), ('33', 45001, 60000, 125, NULL), ('33', 60001, 75000, 165, NULL), ('33', 75001, NULL, 208, NULL),
 ('27', 0, 7500, 0, NULL), ('27', 7501, 10000, 175, NULL), ('27', 10001, NULL, 200, 300);
INSERT INTO holidays (day, name, state_code) VALUES
 ('2026-08-15', 'Independence Day', NULL), ('2026-10-02', 'Gandhi Jayanti', NULL), ('2026-11-08', 'Diwali', NULL), ('2026-11-09', 'Gujarati New Year', '24'), ('2027-01-26', 'Republic Day', NULL), ('2027-03-04', 'Holi', NULL);
