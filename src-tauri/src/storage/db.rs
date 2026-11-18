//! Local-first SQLite store at `%APPDATA%\winglass\winglass.db`.

use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub list_id: String,
    pub text: String,
    pub done: bool,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTimeApp {
    pub app: String,
    pub domain: Option<String>,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTimeDay {
    pub day: String,
    pub total_seconds: i64,
    pub hourly: Vec<i64>,
    pub top_apps: Vec<ScreenTimeApp>,
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("winglass")
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    note_id    TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    TEXT NOT NULL,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_list ON todos(list_id, position);
CREATE TABLE IF NOT EXISTS screen_time (
    day     TEXT NOT NULL,
    hour    INTEGER NOT NULL,
    app     TEXT NOT NULL,
    domain  TEXT NOT NULL DEFAULT '',
    seconds INTEGER NOT NULL,
    PRIMARY KEY (day, hour, app, domain)
);
CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT PRIMARY KEY,
    blob       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Db {
    pub fn open() -> rusqlite::Result<Db> {
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let conn = Connection::open(dir.join("winglass.db"))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    // ---------- key/value ----------

    pub fn kv_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO kv(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ts()],
        )?;
        Ok(())
    }

    // ---------- notes ----------

    pub fn get_note(&self, note_id: &str) -> String {
        let conn = self.conn.lock();
        conn.query_row("SELECT content FROM notes WHERE note_id = ?1", params![note_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    pub fn save_note(&self, note_id: &str, content: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO notes(note_id, content, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(note_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params![note_id, content, now_ts()],
        )?;
        Ok(())
    }

    // ---------- todos ----------

    pub fn list_todos(&self, list_id: &str) -> rusqlite::Result<Vec<Todo>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, list_id, text, done, position, created_at FROM todos
             WHERE list_id = ?1 ORDER BY done ASC, position ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![list_id], |r| {
            Ok(Todo {
                id: r.get(0)?,
                list_id: r.get(1)?,
                text: r.get(2)?,
                done: r.get::<_, i64>(3)? != 0,
                position: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_todo(&self, list_id: &str, text: &str) -> rusqlite::Result<i64> {
        let conn = self.conn.lock();
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE list_id = ?1",
            params![list_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO todos(list_id, text, done, position, created_at) VALUES (?1, ?2, 0, ?3, ?4)",
            params![list_id, text, next, now_ts()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_todo_done(&self, id: i64, done: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE todos SET done = ?2 WHERE id = ?1", params![id, done as i64])?;
        Ok(())
    }

    pub fn delete_todo(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM todos WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_done_todos(&self, list_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM todos WHERE list_id = ?1 AND done = 1", params![list_id])?;
        Ok(())
    }

    // ---------- screen time ----------

    pub fn add_screen_time(&self, entries: &[(String, u32, String, String, i64)]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO screen_time(day, hour, app, domain, seconds) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(day, hour, app, domain) DO UPDATE SET seconds = seconds + excluded.seconds",
            )?;
            for (day, hour, app, domain, secs) in entries {
                stmt.execute(params![day, hour, app, domain, secs])?;
            }
        }
        tx.commit()
    }

    pub fn screen_time_day(&self, day: &str) -> rusqlite::Result<ScreenTimeDay> {
        let conn = self.conn.lock();
        let mut hourly = vec![0i64; 24];
        {
            let mut stmt =
                conn.prepare("SELECT hour, SUM(seconds) FROM screen_time WHERE day = ?1 GROUP BY hour")?;
            let rows = stmt.query_map(params![day], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
            for row in rows {
                let (hour, secs) = row?;
                if (0..24).contains(&hour) {
                    hourly[hour as usize] = secs;
                }
            }
        }
        let mut stmt = conn.prepare(
            "SELECT app, domain, SUM(seconds) AS s FROM screen_time WHERE day = ?1
             GROUP BY app, domain ORDER BY s DESC LIMIT 8",
        )?;
        let top_apps = stmt
            .query_map(params![day], |r| {
                let domain: String = r.get(1)?;
                Ok(ScreenTimeApp {
                    app: r.get(0)?,
                    domain: if domain.is_empty() { None } else { Some(domain) },
                    seconds: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ScreenTimeDay {
            day: day.to_string(),
            total_seconds: hourly.iter().sum(),
            hourly,
            top_apps,
        })
    }

    pub fn prune_screen_time(&self, keep_days: i64) -> rusqlite::Result<()> {
        let cutoff = (chrono::Local::now() - chrono::Duration::days(keep_days)).format("%Y-%m-%d").to_string();
        let conn = self.conn.lock();
        conn.execute("DELETE FROM screen_time WHERE day < ?1", params![cutoff])?;
        Ok(())
    }

    // ---------- secrets (values are DPAPI blobs, base64) ----------

    pub fn put_secret_blob(&self, name: &str, blob_b64: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO secrets(name, blob, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
            params![name, blob_b64, now_ts()],
        )?;
        Ok(())
    }

    pub fn get_secret_blob(&self, name: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row("SELECT blob FROM secrets WHERE name = ?1", params![name], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn delete_secret(&self, name: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM secrets WHERE name = ?1", params![name])?;
        Ok(())
    }

    pub fn secret_names(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT name FROM secrets ORDER BY name")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    }
}
