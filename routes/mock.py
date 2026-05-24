from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from db import (
    delete_record,
    get_auth_config,
    get_namespace,
    get_record_by_id,
    get_records,
    get_resource_by_name,
    get_resource_by_route,
    get_schema_json,
    insert_records,
    reset_records,
    update_record,
    validate,
)

mock_bp = Blueprint("mock", __name__)


def is_expired(expires_at: str) -> bool:
    normalized = expires_at.replace("Z", "+00:00")
    expiry = datetime.fromisoformat(normalized)
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) > expiry


def check_namespace(slug):
    ns = get_namespace(slug)
    if not ns:
        return None, (jsonify({"error": "namespace not found"}), 404)
    if is_expired(ns["expires_at"]):
        return None, (jsonify({"error": "this namespace has expired"}), 410)
    return ns, None


def check_auth(slug, route_path):
    """Mock-auth check: enforces auth_config.token for protected routes.
    This is separate from namespace ownership (check_ownership)."""
    auth = get_auth_config(slug)
    if not auth:
        return None
    if route_path not in auth.get("protected_routes", []):
        return None

    auth_header = request.headers.get("Authorization", "")
    expected = f"Bearer {auth.get('token')}"
    if auth_header != expected:
        return jsonify({"error": "unauthorized"}), 401

    return None


def check_ownership(ns):
    """Platform-level ownership check using namespaces.token.
    Must be called on all write operations (POST / PUT / DELETE).
    GET operations are intentionally excluded.

    Returns a (response, status) error tuple on failure, or None on success.
    """
    ns_token = ns.get("token")
    # Treat NULL token (legacy namespace) as write-disabled.
    if not ns_token:
        return jsonify({"error": "unauthorized: this namespace has no ownership token"}), 401

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "unauthorized: missing or malformed Authorization header"}), 401

    provided_token = auth_header[len("Bearer "):]
    if provided_token != ns_token:
        return jsonify({"error": "unauthorized: invalid namespace token"}), 401

    return None


# validate_and_coerce removed — normalize_schema() + validate() from db.py
# handle both legacy flat schemas and new nested JSON-Schema-style schemas.


@mock_bp.route("/<slug>/<resource_name>", methods=["GET"])
def list_records(slug, resource_name):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    resource = get_resource_by_route(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    auth_err = check_auth(slug, resource["route_path"])
    if auth_err is not None:
        return auth_err

    return jsonify(get_records(resource["id"])), 200


@mock_bp.route("/<slug>/<resource_name>/<int:record_id>", methods=["GET"])
def get_record_route(slug, resource_name, record_id):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    resource = get_resource_by_route(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    auth_err = check_auth(slug, resource["route_path"])
    if auth_err is not None:
        return auth_err

    record = get_record_by_id(resource["id"], record_id)
    if not record:
        return jsonify({"error": f"record with id {record_id} not found"}), 404

    return jsonify(record), 200


@mock_bp.route("/<slug>/<resource_name>", methods=["POST"])
def create_record(slug, resource_name):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    # Platform ownership check — must precede all write logic.
    ownership_err = check_ownership(ns)
    if ownership_err is not None:
        return ownership_err

    resource = get_resource_by_route(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    auth_err = check_auth(slug, resource["route_path"])
    if auth_err is not None:
        return auth_err

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "request body must be a valid JSON object"}), 400

    schema = get_schema_json(resource["id"])
    if not schema:
        return jsonify({"error": "schema not found"}), 404

    # Schema in DB is always canonical (normalized at create time; migrated for
    # legacy rows). Pass directly to validate() — no runtime normalization needed.
    ok, error = validate(body, schema)
    if not ok:
        return jsonify({"error": error}), 400

    insert_records(resource["id"], [body])
    all_records = get_records(resource["id"])
    if not all_records:
        return jsonify({"error": "failed to retrieve new record"}), 500

    return jsonify(all_records[-1]), 201


@mock_bp.route("/<slug>/<resource_name>/<int:record_id>", methods=["PUT"])
def update_record_route(slug, resource_name, record_id):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    # Platform ownership check — must precede all write logic.
    ownership_err = check_ownership(ns)
    if ownership_err is not None:
        return ownership_err

    resource = get_resource_by_route(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    auth_err = check_auth(slug, resource["route_path"])
    if auth_err is not None:
        return auth_err

    existing = get_record_by_id(resource["id"], record_id)
    if not existing:
        return jsonify({"error": f"record with id {record_id} not found"}), 404

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "request body must be a valid JSON object"}), 400

    schema = get_schema_json(resource["id"])
    if not schema:
        return jsonify({"error": "schema not found"}), 404

    # Schema in DB is always canonical (normalized at create time; migrated for
    # legacy rows). Pass directly to validate() — no runtime normalization needed.
    ok, error = validate(body, schema)
    if not ok:
        return jsonify({"error": error}), 400

    update_record(resource["id"], record_id, body)
    updated = get_record_by_id(resource["id"], record_id)
    return jsonify(updated), 200


@mock_bp.route("/<slug>/<resource_name>/<int:record_id>", methods=["DELETE"])
def delete_record_route(slug, resource_name, record_id):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    # Platform ownership check — must precede all write logic.
    ownership_err = check_ownership(ns)
    if ownership_err is not None:
        return ownership_err

    resource = get_resource_by_route(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    auth_err = check_auth(slug, resource["route_path"])
    if auth_err is not None:
        return auth_err

    existing = get_record_by_id(resource["id"], record_id)
    if not existing:
        return jsonify({"error": f"record with id {record_id} not found"}), 404

    delete_record(resource["id"], record_id)
    return jsonify({"deleted": True, "id": record_id}), 200


@mock_bp.route("/<slug>/<resource_name>/records", methods=["DELETE"])
def reset_records_route(slug, resource_name):
    ns, err = check_namespace(slug)
    if err is not None:
        return err
    if ns is None:
        return jsonify({"error": "namespace not found"}), 404

    # Platform ownership check — must precede all write logic.
    ownership_err = check_ownership(ns)
    if ownership_err is not None:
        return ownership_err

    resource = get_resource_by_name(slug, resource_name)
    if not resource:
        return jsonify({"error": "resource not found"}), 404

    reset_records(resource["id"])
    return jsonify({"message": "records reset"}), 200
