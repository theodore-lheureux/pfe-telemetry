-- Early access list from the coming soon page.
CREATE TABLE signups (
  email TEXT PRIMARY KEY,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'fr')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
