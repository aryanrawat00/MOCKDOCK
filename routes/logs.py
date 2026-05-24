from datetime import datetime, timezone

from flask import Blueprint, jsonify

from db import get_last_request_status, get_logs_by_namespace, get_namespace, get_resources_by_namespace

logs_bp = Blueprint("logs", __name__)


def is_expired(expires_at):
    normalized = expires_at.replace("Z", "+00:00")
    expiry = datetime.fromisoformat(normalized)
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) > expiry


@logs_bp.route("/<slug>/logs", methods=["GET"])
def get_logs(slug):
    namespace = get_namespace(slug)
    if not namespace or is_expired(namespace["expires_at"]):
        return jsonify({"error": "namespace not found"}), 404

    return jsonify(get_logs_by_namespace(slug)), 200


@logs_bp.route("/<slug>/health", methods=["GET"])
def get_health(slug):
    namespace = get_namespace(slug)
    if not namespace or is_expired(namespace["expires_at"]):
        return jsonify({"error": "namespace not found"}), 404

    resources = get_resources_by_namespace(slug)
    result = []
    for resource in resources:
        last_status_code = get_last_request_status(resource["id"])
        result.append({
            "id": resource["id"],
            "name": resource["name"],
            "route_path": resource["route_path"],
            "last_status_code": last_status_code,
            "health": "green" if last_status_code is not None and last_status_code < 400 else "red",
        })

    return jsonify(result), 200
