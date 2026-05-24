import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "mockdock.db"))


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn, table_name):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,)
    ).fetchone()
    return row is not None


def _column_exists(conn, table_name, column_name):
    if not _table_exists(conn, table_name):
        return False
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return any(row["name"] == column_name for row in rows)


def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS namespaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            token TEXT
        );

        CREATE TABLE IF NOT EXISTS resources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace_slug TEXT NOT NULL,
            name TEXT NOT NULL,
            route_path TEXT NOT NULL,
            schema_json TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (namespace_slug) REFERENCES namespaces(slug)
        );

        CREATE TABLE IF NOT EXISTS schemas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            field_name TEXT NOT NULL,
            field_type TEXT NOT NULL,
            FOREIGN KEY (resource_id) REFERENCES resources(id)
        );

        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            FOREIGN KEY (resource_id) REFERENCES resources(id)
        );

        CREATE TABLE IF NOT EXISTS auth_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace_slug TEXT NOT NULL UNIQUE,
            login_route TEXT NOT NULL,
            token TEXT NOT NULL,
            protected_routes TEXT NOT NULL,
            FOREIGN KEY (namespace_slug) REFERENCES namespaces(slug)
        );

        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace_slug TEXT NOT NULL,
            resource_id INTEGER,
            method TEXT NOT NULL,
            route TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            response_time_ms INTEGER NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (namespace_slug) REFERENCES namespaces(slug),
            FOREIGN KEY (resource_id) REFERENCES resources(id)
        );
    """)

    conn.commit()
    conn.close()

    migrate_db()


def migrate_db():
    conn = get_connection()

    try:
        conn.execute("PRAGMA foreign_keys = OFF")

        if _column_exists(conn, "namespaces", "resource_name"):
            conn.execute("""
                CREATE TABLE IF NOT EXISTS resources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    namespace_slug TEXT NOT NULL,
                    name TEXT NOT NULL,
                    route_path TEXT NOT NULL,
                    FOREIGN KEY (namespace_slug) REFERENCES namespaces(slug)
                )
            """)

            namespaces = conn.execute(
                "SELECT slug, resource_name, route_path FROM namespaces"
            ).fetchall()
            for namespace in namespaces:
                existing_resource = conn.execute(
                    """
                    SELECT id FROM resources
                    WHERE namespace_slug = ? AND name = ? AND route_path = ?
                    """,
                    (namespace["slug"], namespace["resource_name"], namespace["route_path"])
                ).fetchone()
                if existing_resource is None:
                    conn.execute(
                        """
                        INSERT INTO resources (namespace_slug, name, route_path)
                        VALUES (?, ?, ?)
                        """,
                        (namespace["slug"], namespace["resource_name"], namespace["route_path"])
                    )

            if _column_exists(conn, "schemas", "namespace_slug"):
                conn.execute("DROP TABLE IF EXISTS schemas_new")
                conn.execute("""
                    CREATE TABLE schemas_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        resource_id INTEGER NOT NULL,
                        field_name TEXT NOT NULL,
                        field_type TEXT NOT NULL,
                        FOREIGN KEY (resource_id) REFERENCES resources(id)
                    )
                """)
                conn.execute("""
                    INSERT INTO schemas_new (resource_id, field_name, field_type)
                    SELECT r.id, s.field_name, s.field_type
                    FROM schemas s
                    JOIN resources r ON r.namespace_slug = s.namespace_slug
                """)
                conn.execute("DROP TABLE schemas")
                conn.execute("ALTER TABLE schemas_new RENAME TO schemas")

            if _column_exists(conn, "records", "namespace_slug"):
                conn.execute("DROP TABLE IF EXISTS records_new")
                conn.execute("""
                    CREATE TABLE records_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        resource_id INTEGER NOT NULL,
                        data TEXT NOT NULL,
                        FOREIGN KEY (resource_id) REFERENCES resources(id)
                    )
                """)
                conn.execute("""
                    INSERT INTO records_new (resource_id, data)
                    SELECT r.id, rec.data
                    FROM records rec
                    JOIN resources r ON r.namespace_slug = rec.namespace_slug
                """)
                conn.execute("DROP TABLE records")
                conn.execute("ALTER TABLE records_new RENAME TO records")

            conn.execute("DROP TABLE IF EXISTS namespaces_new")
            conn.execute("""
                CREATE TABLE namespaces_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL UNIQUE,
                    expires_at TEXT NOT NULL,
                    token TEXT
                )
            """)
            conn.execute("""
                INSERT INTO namespaces_new (id, slug, expires_at, token)
                SELECT id, slug, expires_at, NULL
                FROM namespaces
            """)
            conn.execute("DROP TABLE namespaces")
            conn.execute("ALTER TABLE namespaces_new RENAME TO namespaces")

        if not _column_exists(conn, "namespaces", "token"):
            conn.execute("ALTER TABLE namespaces ADD COLUMN token TEXT")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace_slug TEXT NOT NULL,
                resource_id INTEGER,
                method TEXT NOT NULL,
                route TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                response_time_ms INTEGER NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (namespace_slug) REFERENCES namespaces(slug),
                FOREIGN KEY (resource_id) REFERENCES resources(id)
            )
        """)

        # ── schema_json migration ─────────────────────────────────────────
        # If the old flat schemas table still exists, migrate its rows into
        # the schema_json column on resources, then drop the table.
        if _table_exists(conn, "schemas"):
            resources = conn.execute("SELECT id FROM resources").fetchall()
            for res in resources:
                rid = res["id"]
                rows = conn.execute(
                    "SELECT field_name, field_type FROM schemas WHERE resource_id = ?",
                    (rid,)
                ).fetchall()
                schema_dict = {r["field_name"]: r["field_type"] for r in rows}
                conn.execute(
                    "UPDATE resources SET schema_json = ? WHERE id = ?",
                    (json.dumps(schema_dict), rid)
                )
            conn.execute("DROP TABLE schemas")

        # Ensure schema_json column exists on resources (for DBs that never
        # had the flat schemas table at all).
        if not _column_exists(conn, "resources", "schema_json"):
            conn.execute(
                "ALTER TABLE resources ADD COLUMN schema_json TEXT NOT NULL DEFAULT '{}'"
            )

        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()


def insert_namespace(slug, expires_at, token):
    conn = get_connection()
    conn.execute(
        "INSERT INTO namespaces (slug, expires_at, token) VALUES (?, ?, ?)",
        (slug, expires_at, token)
    )
    conn.commit()
    conn.close()


def get_namespace(slug):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM namespaces WHERE slug = ?",
        (slug,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def is_slug_available(slug):
    conn = get_connection()
    row = conn.execute(
        "SELECT expires_at FROM namespaces WHERE slug = ?",
        (slug,)
    ).fetchone()
    conn.close()

    if row is None:
        return True

    expires_at = row["expires_at"]
    normalized = expires_at.replace("Z", "+00:00")
    expiry = datetime.fromisoformat(normalized)
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry <= datetime.now(timezone.utc)


def insert_resource(namespace_slug, name, route_path):
    conn = get_connection()
    cursor = conn.execute(
        """
        INSERT INTO resources (namespace_slug, name, route_path)
        VALUES (?, ?, ?)
        """,
        (namespace_slug, name, route_path)
    )
    resource_id = cursor.lastrowid
    row = conn.execute(
        "SELECT * FROM resources WHERE id = ?",
        (resource_id,)
    ).fetchone()
    conn.commit()
    conn.close()
    return dict(row)


def get_resources_by_namespace(namespace_slug):
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT * FROM resources
        WHERE namespace_slug = ?
        ORDER BY id ASC
        """,
        (namespace_slug,)
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_resource_by_route(namespace_slug, route_path):
    conn = get_connection()
    row = conn.execute(
        """
        SELECT * FROM resources
        WHERE namespace_slug = ? AND route_path = ?
        LIMIT 1
        """,
        (namespace_slug, route_path)
    ).fetchone()

    if row is None:
        row = conn.execute(
            """
            SELECT * FROM resources
            WHERE namespace_slug = ? AND name = ?
            LIMIT 1
            """,
            (namespace_slug, route_path)
        ).fetchone()

    conn.close()
    if row:
        return dict(row)

    normalized = (route_path or "").strip("/").split("/")[-1]
    if not normalized:
        return None

    for resource in get_resources_by_namespace(namespace_slug):
        if resource["route_path"].strip("/").split("/")[-1] == normalized:
            return resource

    return None


def get_resource_by_id(resource_id):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM resources WHERE id = ?",
        (resource_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def insert_schema_json(resource_id, schema: dict):
    """Store schema dict as JSON in resources.schema_json."""
    conn = get_connection()
    conn.execute(
        "UPDATE resources SET schema_json = ? WHERE id = ?",
        (json.dumps(schema), resource_id)
    )
    conn.commit()
    conn.close()


def get_schema_json(resource_id):
    """Return schema dict from resources.schema_json, or {} if absent."""
    conn = get_connection()
    row = conn.execute(
        "SELECT schema_json FROM resources WHERE id = ?",
        (resource_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return {}
    raw = row["schema_json"]
    if not raw:
        return {}
    return json.loads(raw)


def normalize_schema(schema: dict) -> dict:
    """Upgrade a legacy flat schema {"name": "string"} to JSON Schema style.

    New-style schemas that already carry ``"type": "object"`` at the top level
    are returned unchanged, so this is safe to call on every schema read.
    """
    if schema.get("type") == "object":
        return schema
    return {
        "type": "object",
        "properties": {
            k: {"type": v} if isinstance(v, str) else v
            for k, v in schema.items()
        },
        "required": [],
    }


def validate(data, schema: dict, path=None):
    """Recursively validate *data* against a JSON-Schema-style *schema*.

    Returns ``(True, None)`` on success, or ``(False, message)`` on the first
    failure. Error messages use dot-notation paths, e.g.::

        address.city: expected string
        tags.[0]: expected string
    """
    if path is None:
        path = []
    t = schema.get("type")

    if t == "object":
        if not isinstance(data, dict):
            return False, f'{".".join(path) or "root"}: expected object'
        props = schema.get("properties", {})
        required = schema.get("required", [])
        for key in required:
            if key not in data:
                return False, f'{".".join(path + [key])}: field is required'
        for key in data:
            if key not in props:
                return False, f'{".".join(path + [key])}: unknown field'
        for key, value in data.items():
            ok, err = validate(value, props[key], path + [key])
            if not ok:
                return False, err
        return True, None

    if t == "array":
        if not isinstance(data, list):
            return False, f'{".".join(path) or "root"}: expected array'
        items_schema = schema.get("items")
        if items_schema:
            for i, item in enumerate(data):
                ok, err = validate(item, items_schema, path + [str(i)])
                if not ok:
                    return False, err
        return True, None

    if t == "string":
        if not isinstance(data, str):
            return False, f'{".".join(path)}: expected string'
        if schema.get("format") == "email":
            import re
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", data):
                return False, f'{".".join(path)}: invalid email'
        if "enum" in schema and data not in schema["enum"]:
            return False, f'{".".join(path)}: invalid enum value'
        return True, None

    if t == "integer":
        if not isinstance(data, int) or isinstance(data, bool):
            return False, f'{".".join(path)}: expected integer'
        return True, None

    if t == "boolean":
        if not isinstance(data, bool):
            return False, f'{".".join(path)}: expected boolean'
        return True, None

    return False, f'{".".join(path)}: unsupported type "{t}"'


def insert_records(resource_id, records: list):
    conn = get_connection()
    for record in records:
        conn.execute(
            "INSERT INTO records (resource_id, data) VALUES (?, ?)",
            (resource_id, json.dumps(record))
        )
    conn.commit()
    conn.close()


def get_records(resource_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, data FROM records WHERE resource_id = ?",
        (resource_id,)
    ).fetchall()
    conn.close()
    result = []
    for row in rows:
        record = json.loads(row["data"])
        record["id"] = row["id"]
        result.append(record)
    return result


def get_record_by_id(resource_id, record_id):
    conn = get_connection()
    row = conn.execute(
        "SELECT id, data FROM records WHERE resource_id = ? AND id = ?",
        (resource_id, record_id)
    ).fetchone()
    conn.close()
    if row:
        record = json.loads(row["data"])
        record["id"] = row["id"]
        return record
    return None


def update_record(resource_id, record_id, new_data: dict):
    conn = get_connection()
    conn.execute(
        "UPDATE records SET data = ? WHERE resource_id = ? AND id = ?",
        (json.dumps(new_data), resource_id, record_id)
    )
    conn.commit()
    conn.close()


def delete_record(resource_id, record_id):
    conn = get_connection()
    conn.execute(
        "DELETE FROM records WHERE resource_id = ? AND id = ?",
        (resource_id, record_id)
    )
    conn.commit()
    conn.close()


def insert_auth_config(namespace_slug, login_route, token, protected_routes: list):
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO auth_config (namespace_slug, login_route, token, protected_routes)
        VALUES (?, ?, ?, ?)
        """,
        (namespace_slug, login_route, token, json.dumps(protected_routes))
    )
    conn.commit()
    conn.close()


def get_auth_config(namespace_slug):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM auth_config WHERE namespace_slug = ?",
        (namespace_slug,)
    ).fetchone()
    conn.close()
    if row:
        result = dict(row)
        result["protected_routes"] = json.loads(result["protected_routes"])
        return result
    return None


def get_resource_by_name(namespace_slug, resource_name):
    conn = get_connection()
    row = conn.execute(
        """
        SELECT * FROM resources
        WHERE namespace_slug = ? AND name = ?
        LIMIT 1
        """,
        (namespace_slug, resource_name)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def insert_log(namespace_slug, resource_id, method, route, status_code, response_time_ms, payload):
    conn = get_connection()
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        """
        INSERT INTO logs (
            namespace_slug,
            resource_id,
            method,
            route,
            status_code,
            response_time_ms,
            payload,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            namespace_slug,
            resource_id,
            method,
            route,
            status_code,
            response_time_ms,
            payload,
            created_at,
        )
    )
    conn.commit()
    conn.close()


def get_logs_by_namespace(namespace_slug):
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT * FROM logs
        WHERE namespace_slug = ?
        ORDER BY created_at DESC
        LIMIT 100
        """,
        (namespace_slug,)
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def reset_records(resource_id):
    conn = get_connection()
    conn.execute("DELETE FROM records WHERE resource_id = ?", (resource_id,))
    conn.commit()
    conn.close()


def get_last_request_status(resource_id):
    conn = get_connection()
    row = conn.execute(
        """
        SELECT status_code FROM logs
        WHERE resource_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (resource_id,)
    ).fetchone()
    conn.close()
    return int(row["status_code"]) if row else None
