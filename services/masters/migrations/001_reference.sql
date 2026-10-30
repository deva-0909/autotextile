CREATE TABLE uoms (
  code text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('weight','length','count','area')),
  decimals int NOT NULL DEFAULT 3 CHECK (decimals BETWEEN 0 AND 6),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hsn_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{4,8}$'),
  description text NOT NULL,
  kind text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','service')),
  gst_rate numeric NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 28),
  cess_rate numeric NOT NULL DEFAULT 0,
  effective_from date NOT NULL DEFAULT '2017-07-01',
  ca_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  credit_days int NOT NULL DEFAULT 0 CHECK (credit_days >= 0),
  advance_percent numeric NOT NULL DEFAULT 0 CHECK (advance_percent BETWEEN 0 AND 100),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reason_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  code text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, code)
);

CREATE TABLE document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  applies_to text[] NOT NULL DEFAULT '{}',
  retention_years int NOT NULL DEFAULT 8 CHECK (retention_years >= 0),
  requires_expiry boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO uoms (code, name, category, decimals) VALUES
 ('KG', 'Kilogram', 'weight', 3), ('MTR', 'Metre', 'length', 2), ('ROLL', 'Roll', 'count', 0), ('PCS', 'Pieces', 'count', 0), ('BALE', 'Bale', 'count', 0);

-- Rates are starting values only; ca_verified stays false until the CA confirms them.
INSERT INTO hsn_codes (code, description, kind, gst_rate) VALUES
 ('6006', 'Other knitted or crocheted fabrics', 'goods', 5),
 ('6004', 'Knitted fabrics, width > 30 cm, ≥5% elastomeric yarn', 'goods', 5),
 ('6001', 'Pile fabrics, knitted (incl. long pile, terry)', 'goods', 5),
 ('6002', 'Knitted fabrics, width ≤ 30 cm, ≥5% elastomeric yarn', 'goods', 5),
 ('6003', 'Knitted fabrics, width ≤ 30 cm, other', 'goods', 5),
 ('5208', 'Woven cotton fabrics, ≥85% cotton, ≤200 g/m²', 'goods', 5),
 ('998821', 'Textile manufacturing job-work services', 'service', 5),
 ('996511', 'Road transport of goods (GTA)', 'service', 5);

INSERT INTO payment_terms (code, name, credit_days, advance_percent, description) VALUES
 ('ADV100', '100% advance', 0, 100, 'Full payment before dispatch'),
 ('TOKEN', 'Token + balance before dispatch', 0, 10, 'Token at booking, balance before dispatch'),
 ('NET15', 'Net 15 days', 15, 0, NULL),
 ('NET30', 'Net 30 days', 30, 0, NULL),
 ('NET45', 'Net 45 days', 45, 0, NULL),
 ('NET60', 'Net 60 days', 60, 0, NULL);

INSERT INTO reason_codes (category, code, description) VALUES
 ('stock_adjustment', 'COUNT_DIFF', 'Physical count difference'),
 ('stock_adjustment', 'MOISTURE', 'Weight variation due to moisture'),
 ('stock_adjustment', 'DAMAGE', 'Damaged in storage'),
 ('quality_rejection', 'SHADE', 'Shade variation'),
 ('quality_rejection', 'HOLES', 'Holes / needle lines'),
 ('quality_rejection', 'GSM', 'GSM out of tolerance'),
 ('quality_rejection', 'WIDTH', 'Width out of tolerance'),
 ('quality_rejection', 'STAIN', 'Stains / oil marks'),
 ('return', 'WRONG_ITEM', 'Wrong fabric delivered'),
 ('return', 'QUALITY', 'Quality complaint'),
 ('return', 'SHORT', 'Short quantity'),
 ('price_override', 'VOLUME', 'Volume discount'),
 ('price_override', 'COMPETITION', 'Competitor price match'),
 ('price_override', 'CLEARANCE', 'Ageing stock clearance'),
 ('dispatch_override', 'KEY_ACCOUNT', 'Key account commitment'),
 ('lost_lead', 'PRICE', 'Lost on price'),
 ('lost_lead', 'AVAILABILITY', 'Stock not available'),
 ('lost_lead', 'NO_RESPONSE', 'Customer stopped responding'),
 ('cancellation', 'CUSTOMER_REQUEST', 'Cancelled at customer request'),
 ('write_off', 'OBSOLETE', 'Dead stock write-off');

INSERT INTO document_types (code, name, applies_to, retention_years, requires_expiry) VALUES
 ('GST_CERT', 'GST registration certificate', '{customer,supplier,mill,transporter,manufacturer,legal_entity}', 8, false),
 ('PAN_CARD', 'PAN card', '{customer,supplier,mill,transporter,manufacturer}', 8, false),
 ('CANCELLED_CHEQUE', 'Cancelled cheque / bank letter', '{customer,supplier,mill,transporter}', 8, false),
 ('AGREEMENT', 'Agreement / contract', '{customer,supplier,mill,transporter,manufacturer}', 8, true),
 ('RATE_CARD', 'Rate card', '{mill,transporter}', 8, true),
 ('CREDIT_APP', 'Credit application', '{customer}', 8, false),
 ('QC_REPORT', 'Quality / lab test report', '{product,supplier,mill}', 8, false),
 ('PRODUCT_IMAGE', 'Product image / swatch', '{product}', 3, false),
 ('OTHER', 'Other', '{customer,supplier,mill,transporter,manufacturer,product,legal_entity,warehouse}', 8, false);
