-- A line of context for a place you saved ("Dad's office", "my dorm in Patan").
-- Additive only. (Kind may now also be 'hidden': a place that isn't one, like a
-- road or a parking lot; its visits drop out of the map and chapters.)
ALTER TABLE saved_places ADD COLUMN note TEXT;
