-- Extend profile table for website hero section
ALTER TABLE profile ADD COLUMN email TEXT;
ALTER TABLE profile ADD COLUMN website TEXT;
ALTER TABLE profile ADD COLUMN image_url TEXT;
ALTER TABLE profile ADD COLUMN image_alt TEXT;
ALTER TABLE profile ADD COLUMN summary_json TEXT;

-- Extend now_state table for rich now page content
ALTER TABLE now_state ADD COLUMN learning_json TEXT;
ALTER TABLE now_state ADD COLUMN projects_json TEXT;
ALTER TABLE now_state ADD COLUMN life_json TEXT;
ALTER TABLE now_state ADD COLUMN reading_goal TEXT;
ALTER TABLE now_state ADD COLUMN last_updated TEXT;
