-- Customer returns (P7) bring dispatched rolls back into a warehouse.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN ('inward','qc','putaway','move','reserve','release','allocate','pick','transfer_out','transfer_in','issue_to_mill','consume_at_mill','split','adjust_in','adjust_out','weight_adjust','damage','write_off','return_in'));
