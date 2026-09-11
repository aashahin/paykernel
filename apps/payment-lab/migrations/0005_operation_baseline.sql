ALTER TABLE lab_operations ADD COLUMN captured_before_minor INTEGER CHECK (captured_before_minor IS NULL OR captured_before_minor >= 0);
