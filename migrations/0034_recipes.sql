-- The Cookbook: recipes you keep (saved from a link or written by hand) and a
-- log of each time you cooked one, with a rating and a note.
-- Ingredients and steps are JSON lists so a recipe stays one row; each
-- ingredient keeps the line as written plus the amount read from it, so the
-- apps can scale servings.
-- Additive only: two new tables and their indexes. No existing table changes.

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  source_name TEXT,
  author TEXT,
  image_url TEXT,
  servings REAL,
  yield_text TEXT,
  prep_minutes INTEGER,
  cook_minutes INTEGER,
  total_minutes INTEGER,
  -- [{text, quantity, quantity_max, unit, item, group}]
  ingredients_json TEXT NOT NULL DEFAULT '[]',
  -- [{text, group}]
  steps_json TEXT NOT NULL DEFAULT '[]',
  -- Collections, like ["Weeknight", "Baking"]
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Deleting is soft, so a recipe can come back.
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipes_updated ON recipes (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipes_source ON recipes (source_url);

CREATE TABLE IF NOT EXISTS recipe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT NOT NULL,
  -- The day you cooked it, YYYY-MM-DD (local), not when it was saved.
  cooked_on TEXT NOT NULL,
  -- 1 to 5, or empty.
  rating INTEGER,
  note TEXT,
  servings REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipe_log_recipe ON recipe_log (recipe_id, cooked_on DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_log_cooked_on ON recipe_log (cooked_on DESC);
