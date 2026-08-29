export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport_json TEXT NOT NULL,
    auth_profile TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    task_handle TEXT NOT NULL,
    server_profile_id TEXT NOT NULL,

    protocol_version TEXT,
    extension_version TEXT,

    status TEXT,

    source_client TEXT,

    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,

    metadata_json TEXT,

    FOREIGN KEY(server_profile_id)
        REFERENCES server_profiles(id)
);

-- Same opaque handle on two servers is allowed.
-- Same handle on the same server is the same task.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_server_handle
    ON tasks(server_profile_id, task_handle);
`;
