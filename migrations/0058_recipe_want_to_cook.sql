-- One way to keep a recipe for later: Want to Cook. Before this it was two
-- (a "Want to cook" tag, and the favourite heart); the app now has only the
-- bookmark. The new column starts true for recipes that had either, so nothing
-- you marked is lost. `favorite` and the tags stay as they are.
-- Additive only: one new column, filled from existing rows; no existing column changes.
ALTER TABLE recipes ADD COLUMN want_to_cook INTEGER NOT NULL DEFAULT 0;

UPDATE recipes SET want_to_cook = 1
WHERE favorite = 1
   OR EXISTS (SELECT 1 FROM json_each(recipes.tags_json) t WHERE lower(t.value) = 'want to cook');
