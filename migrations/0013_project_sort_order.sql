-- Add sort_order column to projects for custom ordering
ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0;

-- Initialize sort_order based on current ID order (newest first)
UPDATE projects SET sort_order = (SELECT COUNT(*) FROM projects p2 WHERE p2.id >= projects.id);
