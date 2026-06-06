package database

import "database/sql"

// RunMigrations executes DDL for all tables and configures SQLite pragmas.
// Existing tables are upgraded with ALTER TABLE ADD COLUMN where needed.
func RunMigrations(db *sql.DB) error {
	for _, p := range []string{
		`PRAGMA journal_mode = WAL;`,
		`PRAGMA foreign_keys = ON;`,
	} {
		if _, err := db.Exec(p); err != nil {
			return err
		}
	}

	schema := `
CREATE TABLE IF NOT EXISTS songs (
    id            TEXT    PRIMARY KEY,
    filename      TEXT    NOT NULL,
    path          TEXT    NOT NULL UNIQUE,
    title         TEXT    NOT NULL,
    artist        TEXT    NOT NULL DEFAULT '',
    album         TEXT    NOT NULL DEFAULT '',
    duration_secs REAL    NOT NULL DEFAULT 0,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    added_at      DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS queue (
    id       TEXT    PRIMARY KEY,
    song_id  TEXT    NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source   TEXT    NOT NULL DEFAULT 'auto',
    added_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
`
	if _, err := db.Exec(schema); err != nil {
		return err
	}

	// Upgrade existing installations: ignore errors if column already exists.
	for _, stmt := range []string{
		`ALTER TABLE songs ADD COLUMN artist        TEXT    NOT NULL DEFAULT ''`,
		`ALTER TABLE songs ADD COLUMN album         TEXT    NOT NULL DEFAULT ''`,
		`ALTER TABLE songs ADD COLUMN duration_secs REAL    NOT NULL DEFAULT 0`,
	} {
		_, _ = db.Exec(stmt)
	}

	return nil
}
