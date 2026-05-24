import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

from db import (
    insert_auth_config,
    insert_namespace,
    insert_records,
    insert_resource,
    insert_schema_json,
    is_slug_available,
    normalize_schema,
    validate,
)

create_bp = Blueprint("create", __name__)

VALID_TYPES = {"string", "integer", "number", "boolean"}


def generate_slug():
    for _ in range(5):
        slug = secrets.token_urlsafe(5)
        if is_slug_available(slug):
            return slug
    return None


def validate_request(body):
    resources = body.get("resources")
    if not isinstance(resources, list) or len(resources) == 0:
        return "resources must be a non-empty array"

    for index, resource in enumerate(resources):
        if not isinstance(resource, dict):
            return f"resource {index + 1} must be an object"

        name = resource.get("name", "").strip()
        if not name:
            return f"resource {index + 1}: resource name cannot be empty"

        route_path = resource.get("route_path", "").strip()
        if not route_path or not route_path.startswith("/"):
            return f"resource {index + 1}: route path must start with /"

        schema = resource.get("schema")
        if not isinstance(schema, dict) or len(schema) == 0:
            return f"resource {index + 1}: schema must have at least one field"

        # New JSON-Schema style (type:object / type:array at root) — trust the
        # recursive validator to catch any mistakes at record-creation time.
        if schema.get("type") not in (None, "object", "array"):
            return (
                f"resource {index + 1}: top-level schema 'type' must be "
                f"'object' or 'array' if provided"
            )

        # Legacy flat schema — validate each field definition individually.
        if schema.get("type") is None:
            for field_name, field_def in schema.items():
                if isinstance(field_def, str):
                    if field_def not in VALID_TYPES:
                        return (
                            f"resource {index + 1}: field '{field_name}' has invalid type "
                            f"'{field_def}'. Must be one of: string, integer, number, boolean"
                        )
                elif isinstance(field_def, dict):
                    if "enum" in field_def:
                        enum_vals = field_def["enum"]
                        if not isinstance(enum_vals, list) or len(enum_vals) == 0 or not all(
                            isinstance(v, str) for v in enum_vals
                        ):
                            return (
                                f"resource {index + 1}: field '{field_name}' enum must be "
                                f"a non-empty list of strings"
                            )
                    elif "type" in field_def and "format" in field_def:
                        if field_def["type"] != "string" or field_def["format"] != "email":
                            return (
                                f"resource {index + 1}: field '{field_name}' object schema "
                                f"must have type 'string' and format 'email'"
                            )
                    else:
                        return (
                            f"resource {index + 1}: field '{field_name}' has unrecognised "
                            f"schema shape — use a type string, an enum object, or a "
                            f"type/format object"
                        )
                else:
                    return (
                        f"resource {index + 1}: field '{field_name}' schema definition "
                        f"must be a string or object"
                    )

        records = resource.get("records")
        if not isinstance(records, list) or len(records) == 0:
            return f"resource {index + 1}: at least one record must be seeded"

    return None


def _is_valid_email(value):
    if not isinstance(value, str) or "@" not in value:
        return False
    local, _, domain = value.partition("@")
    return "." in domain


def coerce_record(record, schema):
    coerced = {}
    for field_name, field_def in schema.items():
        value = record.get(field_name)
        if value is None:
            return None, f"field '{field_name}' is missing from record"

        if isinstance(field_def, str):
            if field_def == "string":
                coerced[field_name] = str(value)
            elif field_def == "integer":
                if not isinstance(value, int) or isinstance(value, bool):
                    return None, f"field '{field_name}' expects integer"
                coerced[field_name] = value
            elif field_def == "number":
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    return None, f"field '{field_name}' expects number"
                coerced[field_name] = value
            elif field_def == "boolean":
                if not isinstance(value, bool):
                    return None, f"field '{field_name}' expects boolean"
                coerced[field_name] = value
        elif isinstance(field_def, dict):
            if "enum" in field_def:
                allowed = field_def["enum"]
                if not isinstance(value, str) or value not in allowed:
                    return None, f"field '{field_name}' must be one of: {', '.join(allowed)}"
                coerced[field_name] = value
            elif "type" in field_def and "format" in field_def:
                if not _is_valid_email(value):
                    return None, f"field '{field_name}' expects a valid email address"
                coerced[field_name] = value

    return coerced, None


@create_bp.route("/api/create", methods=["POST"])
def create():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "request body must be valid JSON"}), 400

    error = validate_request(body)
    if error:
        return jsonify({"error": error}), 400

    resources = body["resources"]
    auth = body.get("auth")

    coerced_resources = []
    for resource_index, resource in enumerate(resources):
        schema = resource["schema"]
        normalized = normalize_schema(schema)
        coerced_records = []
        for record_index, record in enumerate(resource["records"]):
            ok, err = validate(record, normalized)
            if not ok:
                return jsonify({"error": f"resource {resource_index + 1}, record {record_index + 1}: {err}"}), 400
            coerced_records.append(record)

        coerced_resources.append({
            "name": resource["name"].strip(),
            "route_path": resource["route_path"].strip(),
            # Store canonical (normalized) form so the DB always holds
            # JSON-Schema-style objects — avoids re-normalization on every request.
            "schema": normalized,
            "records": coerced_records,
        })

    requested_slug = body.get("slug", "").strip()
    if requested_slug:
        if is_slug_available(requested_slug):
            slug = requested_slug
        else:
            return jsonify({"error": "Namespace is not available. Please choose another."}), 409
    else:
        slug = generate_slug()
        if not slug:
            return jsonify({"error": "failed to generate unique namespace, please try again"}), 500

    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Always generate a secure ownership token for the namespace regardless of
    # whether mock auth (auth_config) is enabled. This is platform-level ownership,
    # separate from auth_config.token which is used for mock API simulation.
    namespace_token = secrets.token_hex(16)

    insert_namespace(slug, expires_at, namespace_token)

    created_resources = []
    for resource in coerced_resources:
        created_resource = insert_resource(slug, resource["name"], resource["route_path"])
        insert_schema_json(created_resource["id"], resource["schema"])
        insert_records(created_resource["id"], resource["records"])
        created_resources.append({
            "id": created_resource["id"],
            "name": created_resource["name"],
            "route_path": created_resource["route_path"],
        })

    if isinstance(auth, dict):
        login_route = auth.get("login_route", "").strip()
        token = auth.get("token", "").strip()
        protected_routes = auth.get("protected_routes", [])
        if login_route and token:
            insert_auth_config(slug, login_route, token, protected_routes)

    base_url = request.host_url.rstrip("/")
    interceptor_tag = f'<script src="{base_url}/interceptor/{slug}.js"></script>'

    return jsonify({
        "namespace": slug,
        "expires_at": expires_at,
        "token": namespace_token,
        "interceptor_tag": interceptor_tag,
        "resources": created_resources,
    }), 200
