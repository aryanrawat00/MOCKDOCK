"""
migrate_schemas.py
------------------
One-time migration: converts every flat schema in `resources.schema_json`
to canonical JSON-Schema style ({"type":"object","properties":{...}}).

Safe to re-run — schemas already in canonical form are left unchanged.
Run from the project root:

    python migrate_schemas.py
"""

import json
import sys
import os

# Allow import of db.py from the project root
sys.path.insert(0, os.path.dirname(__file__))

from db import get_connection, normalize_schema


def migrate():
    conn = get_connection()
    conn.row_factory = __import__("sqlite3").Row

    rows = conn.execute("SELECT id, schema_json FROM resources").fetchall()
    changed = 0
    skipped = 0

    for row in rows:
        rid = row["id"]
        raw = row["schema_json"] or "{}"

        try:
            schema = json.loads(raw)
        except json.JSONDecodeError:
            print(f"  [WARN] resource {rid}: invalid JSON in schema_json — skipped")
            skipped += 1
            continue

        canonical = normalize_schema(schema)

        if canonical == schema:
            # Already in canonical form — nothing to do
            skipped += 1
            print(f"  [SKIP] resource {rid}: already canonical")
        else:
            conn.execute(
                "UPDATE resources SET schema_json = ? WHERE id = ?",
                (json.dumps(canonical), rid),
            )
            changed += 1
            print(f"  [MIGRATED] resource {rid}: flat -> canonical")
            print(f"    before: {raw}")
            print(f"    after : {json.dumps(canonical)}")

    conn.commit()
    conn.close()

    print(f"\nDone. {changed} migrated, {skipped} already canonical / skipped.")
    return changed


if __name__ == "__main__":
    print("MockDock — schema migration\n")
    migrate()
