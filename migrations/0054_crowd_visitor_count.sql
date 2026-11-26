-- The crowd's all-time total (COUNT(DISTINCT visitor_hash) over every visit)
-- kept as a number instead of counted on each public request.
--
-- crowd_visitors holds each visitor once; crowd_totals holds the count. The
-- trigger keeps both in step with crowd_visits, so every writer (any version
-- of the Worker, wrangler, a script) keeps the total right, including visits
-- recorded between applying this and deploying the code that reads it. A
-- repeat visit the same day is an upsert's UPDATE and never fires it.
CREATE TABLE IF NOT EXISTS crowd_visitors (
  visitor_hash TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS crowd_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  visitors INTEGER NOT NULL
);

INSERT OR IGNORE INTO crowd_visitors (visitor_hash)
  SELECT DISTINCT visitor_hash FROM crowd_visits;

INSERT OR IGNORE INTO crowd_totals (id, visitors)
  VALUES (1, (SELECT COUNT(*) FROM crowd_visitors));

CREATE TRIGGER IF NOT EXISTS crowd_visits_new_visitor AFTER INSERT ON crowd_visits
WHEN NOT EXISTS (SELECT 1 FROM crowd_visitors WHERE visitor_hash = NEW.visitor_hash)
BEGIN
  INSERT INTO crowd_visitors (visitor_hash) VALUES (NEW.visitor_hash);
  UPDATE crowd_totals SET visitors = visitors + 1 WHERE id = 1;
END;
