-- The words a recipe was read from: a saved reel's caption and what is said in
-- it, or the text of a scanned cookbook page. Kept beside the recipe so the app
-- can read amounts from it again without going back to the source (a post can
-- be taken down). Written only when you confirm a review in the app.
-- Additive only: one nullable column, no existing row changes.
ALTER TABLE recipes ADD COLUMN source_text TEXT;
