-- Google Timeline pins a visit to the business it guesses you were at, sometimes
-- hundreds of metres off. When the trips either side agree on where you really
-- were, latitude/longitude hold that, and Google's guess is kept here. Additive
-- only: two nullable columns; nothing else changes.
ALTER TABLE visits ADD COLUMN guess_latitude REAL;
ALTER TABLE visits ADD COLUMN guess_longitude REAL;
