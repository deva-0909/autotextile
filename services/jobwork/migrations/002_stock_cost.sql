-- Grey cost per kg from the purchase order, so finished lots can be valued (P4).
ALTER TABLE mill_stock ADD COLUMN cost_per_kg numeric;
