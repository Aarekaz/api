-- Apple's own record of each place, matched once on a device: its point-of-
-- interest category (e.g. "MKPOICategoryCafe") and the MapKit place ID, so the
-- apps can draw Apple's icon and colour and open Apple's place card.
-- Additive only: two new nullable columns on place_names.

ALTER TABLE place_names ADD COLUMN category TEXT;
ALTER TABLE place_names ADD COLUMN map_item_id TEXT;
