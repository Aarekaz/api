CREATE TABLE IF NOT EXISTS finance_plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  offer_json TEXT,
  budget_json TEXT,
  equity_json TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
