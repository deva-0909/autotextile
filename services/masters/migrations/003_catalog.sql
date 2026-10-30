CREATE TABLE fabric_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  hsn_code text REFERENCES hsn_codes(code),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

-- Configurable attribute dictionary. category_id NULL = applies to every category.
CREATE TABLE attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES fabric_categories(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text','number','select','multiselect','boolean')),
  unit text,
  options jsonb,
  min_value numeric,
  max_value numeric,
  required boolean NOT NULL DEFAULT false,
  level text NOT NULL DEFAULT 'product' CHECK (level IN ('product','lot','roll')),
  group_name text NOT NULL DEFAULT 'Specification',
  sort_order int NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX attribute_definitions_key ON attribute_definitions (COALESCE(category_id, '00000000-0000-0000-0000-000000000000'), key);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category_id uuid NOT NULL REFERENCES fabric_categories(id),
  hsn_code text NOT NULL REFERENCES hsn_codes(code),
  uom_code text NOT NULL DEFAULT 'KG' REFERENCES uoms(code),
  attributes jsonb NOT NULL DEFAULT '{}',
  min_order_qty numeric CHECK (min_order_qty IS NULL OR min_order_qty > 0),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','discontinued')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_attributes ON products USING gin (attributes);

CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_list_items (
  price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  rate_per_uom numeric NOT NULL CHECK (rate_per_uom > 0),
  min_qty numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (price_list_id, product_id, min_qty)
);

INSERT INTO fabric_categories (code, name, hsn_code, description) VALUES
 ('SJ', 'Single Jersey', '6006', 'Plain weft-knit fabric'),
 ('SJL', 'Single Jersey Lycra', '6004', 'Single jersey with elastane'),
 ('INT', 'Interlock', '6006', 'Double-knit interlock'),
 ('RIB', 'Rib', '6006', '1x1 / 2x2 rib'),
 ('PIQ', 'Pique', '6006', 'Lacoste / pique structures'),
 ('FLC', 'Fleece', '6001', 'Brushed fleece and loopknit'),
 ('TER', 'Terry', '6001', 'French terry and loop terry');

INSERT INTO attribute_definitions (key, label, data_type, unit, options, min_value, max_value, required, level, group_name, sort_order) VALUES
 ('knit_type', 'Knit type', 'select', NULL, '["Single jersey","Interlock","Rib 1x1","Rib 2x2","Pique","Fleece","Terry","Waffle","Mesh"]', NULL, NULL, true, 'product', 'Construction', 10),
 ('composition', 'Composition', 'text', NULL, NULL, NULL, NULL, true, 'product', 'Construction', 20),
 ('gsm', 'GSM', 'number', 'g/m²', NULL, 60, 600, true, 'product', 'Construction', 30),
 ('width', 'Width', 'number', 'inch', NULL, 10, 120, true, 'product', 'Construction', 40),
 ('width_form', 'Open / tubular', 'select', NULL, '["Open width","Tubular"]', NULL, NULL, true, 'product', 'Construction', 50),
 ('yarn_count', 'Yarn count', 'text', NULL, NULL, NULL, NULL, false, 'product', 'Construction', 60),
 ('colour', 'Colour', 'text', NULL, NULL, NULL, NULL, false, 'product', 'Appearance', 110),
 ('design', 'Design / pattern', 'select', NULL, '["Solid","Melange","Yarn-dyed stripe","Printed","Jacquard","Auto stripe"]', NULL, NULL, false, 'product', 'Appearance', 120),
 ('finish', 'Finish', 'multiselect', NULL, '["Bio-wash","Silicone soft","Peach","Brushed","Compacted","Anti-pilling","Moisture management"]', NULL, NULL, false, 'product', 'Appearance', 130),
 ('processing_type', 'Processing type', 'select', NULL, '["Greige","RFD","Dyed","Printed","Yarn dyed"]', NULL, NULL, true, 'product', 'Appearance', 140),
 ('shade_no', 'Shade number', 'text', NULL, NULL, NULL, NULL, false, 'lot', 'Lot quality', 210),
 ('dye_lot', 'Dye lot', 'text', NULL, NULL, NULL, NULL, false, 'lot', 'Lot quality', 220),
 ('shrinkage_pct', 'Shrinkage', 'number', '%', NULL, 0, 20, false, 'lot', 'Lot quality', 230),
 ('pilling_grade', 'Pilling grade', 'select', NULL, '["1","2","3","4","5"]', NULL, NULL, false, 'lot', 'Lot quality', 240),
 ('colour_fastness', 'Colour fastness grade', 'select', NULL, '["1","2","3","4","5"]', NULL, NULL, false, 'lot', 'Lot quality', 250),
 ('quality_grade', 'Quality grade', 'select', NULL, '["A","B","C","Rejected"]', NULL, NULL, false, 'roll', 'Lot quality', 260),
 ('weight_tolerance_pct', 'Weight tolerance', 'number', '±%', NULL, 0, 15, false, 'product', 'Tolerances', 310),
 ('width_tolerance_pct', 'Width tolerance', 'number', '±%', NULL, 0, 15, false, 'product', 'Tolerances', 320);

-- Elastane content only matters for lycra categories.
INSERT INTO attribute_definitions (category_id, key, label, data_type, unit, min_value, max_value, required, group_name, sort_order)
SELECT id, 'elastane_pct', 'Elastane content', 'number', '%', 1, 30, true, 'Construction', 25 FROM fabric_categories WHERE code = 'SJL';
