-- Run on a NEW shared database. Preserves this app's existing retention policy.
CREATE TABLE workout_auth_attempts (
  ip_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(ip_hash,bucket)
);
CREATE TABLE workout_auth_config (
  app_id TEXT PRIMARY KEY CHECK(app_id='workout'),
  key_sha256 TEXT NOT NULL
);
CREATE TABLE workout_auth_sessions (
  session_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE workout_backup_chunks (
  backup_id TEXT NOT NULL REFERENCES workout_backups(backup_id),
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  backup_json TEXT NOT NULL,
  PRIMARY KEY(backup_id,chunk_index)
);
CREATE TABLE workout_backup_retention (
  backup_id TEXT PRIMARY KEY REFERENCES workout_backups(backup_id) ON DELETE CASCADE,
  app_id TEXT NOT NULL CHECK(app_id='workout'),
  verified_at TEXT,
  version_number INTEGER,
  UNIQUE(app_id,version_number),
  CHECK((verified_at IS NULL AND version_number IS NULL) OR (verified_at IS NOT NULL AND version_number>0))
);
CREATE TABLE workout_backups (
  backup_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK(app_id='workout'),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  device_id TEXT,
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 42)
);
CREATE INDEX workout_auth_sessions_app ON workout_auth_sessions(app_id, revoked_at);
CREATE INDEX workout_backups_history ON workout_backups(app_id,received_at DESC,backup_id DESC);
CREATE TRIGGER workout_backups_no_delete BEFORE DELETE ON workout_backups
WHEN OLD.backup_id NOT IN (
  SELECT b.backup_id FROM workout_backups b JOIN workout_backup_retention r ON r.backup_id=b.backup_id
  WHERE b.app_id=OLD.app_id AND r.version_number IS NOT NULL
  ORDER BY r.version_number DESC LIMIT -1 OFFSET 3
) BEGIN SELECT RAISE(ABORT,'protected backup'); END;
CREATE TRIGGER workout_backups_no_update BEFORE UPDATE ON workout_backups BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
CREATE TRIGGER workout_chunks_no_delete BEFORE DELETE ON workout_backup_chunks
WHEN OLD.backup_id NOT IN (
  SELECT b.backup_id FROM workout_backups b JOIN workout_backup_retention r ON r.backup_id=b.backup_id
  WHERE b.app_id='workout' AND r.version_number IS NOT NULL
  ORDER BY r.version_number DESC LIMIT -1 OFFSET 3
) BEGIN SELECT RAISE(ABORT,'protected backup'); END;
CREATE TRIGGER workout_chunks_no_update BEFORE UPDATE ON workout_backup_chunks BEGIN SELECT RAISE(ABORT,'immutable backup'); END;

