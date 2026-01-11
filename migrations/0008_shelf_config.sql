-- Add shelf_config column to settings table
ALTER TABLE settings ADD COLUMN shelf_config_json TEXT;
