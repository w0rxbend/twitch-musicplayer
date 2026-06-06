package database

import "database/sql"

// RunMigrations executes DDL for all tables and configures SQLite pragmas.
func RunMigrations(db *sql.DB) error {
	pragmas := []string{
		`PRAGMA journal_mode = WAL;`,
		`PRAGMA foreign_keys = ON;`,
	}

	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return err
		}
	}

	schema := `
CREATE TABLE IF NOT EXISTS songs (
    id         TEXT    PRIMARY KEY,
    filename   TEXT    NOT NULL,
    path       TEXT    NOT NULL UNIQUE,
    title      TEXT    NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    added_at   DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS queue (
    id       TEXT    PRIMARY KEY,
    song_id  TEXT    NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source   TEXT    NOT NULL DEFAULT 'auto',
    added_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
    id          TEXT    PRIMARY KEY,
    song_id     TEXT    NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    played_at   DATETIME NOT NULL DEFAULT (datetime('now')),
    finished_at DATETIME,
    finished    INTEGER NOT NULL DEFAULT 0
);
`

	_, err := db.Exec(schema)
	return err
}
