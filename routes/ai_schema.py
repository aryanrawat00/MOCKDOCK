import json
import os
import urllib.request
import urllib.error

from flask import Blueprint, jsonify, request

ai_schema_bp = Blueprint("ai_schema", __name__)

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"

SYSTEM_PROMPT = """You are a JSON schema generator for a mock REST API tool called MockDock.
Given a description of a resource, return ONLY a valid JSON object JSON inside JSON is not applicable at all cost ,(no markdown, no explanation) 
that represents a MockDock schema. 

MockDock schema rules:
- Each key is a field name
- Values can be:
  - "string"   → plain text field
  - "integer"  → whole number
  - "number"   → decimal number
  - "boolean"  → true/false
  - {"enum": ["val1", "val2"]}  → one of a fixed set of string values
  - {"type": "string", "format": "email"}  → email address field

Example output for "a product with name, price, stock count, and category":
{"name":"string","price":"number","stock":"integer","category":{"enum":["electronics","clothing","food","other"]}}

Return ONLY the raw JSON object. No backticks, no explanation, no extra text."""


def call_groq(prompt: str) -> dict:
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable is not set")

    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Generate a MockDock schema for: {prompt}"}
        ],
        "temperature": 0.3,
        "max_tokens": 512,
    }).encode("utf-8")

    req = urllib.request.Request(
        GROQ_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "MockDock/1.0",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    raw_text = body["choices"][0]["message"]["content"].strip()

    # Strip any accidental markdown fences
    if raw_text.startswith("```"):
        lines = raw_text.splitlines()
        raw_text = "\n".join(
            line for line in lines if not line.startswith("```")
        ).strip()

    schema = json.loads(raw_text)
    if not isinstance(schema, dict) or len(schema) == 0:
        raise ValueError("AI returned an empty or invalid schema object")

    return schema


RECORDS_SYSTEM_PROMPT = """You are a realistic test data generator for a mock REST API tool called MockDock.

Given a resource name and its schema, return ONLY a valid JSON array (no markdown, no explanation)
containing exactly 5 realistic, varied records that match the schema exactly.

MockDock schema types:
- "string"  → realistic text value
- "integer" → realistic whole number
- "number"  → realistic decimal number
- "boolean" → true or false
- {"enum": ["a","b"]} → one of the enum values
- {"type":"string","format":"email"} → a realistic email address

Rules:
- Every record must have every field from the schema
- Values must be realistic and varied (not all zeros or empty strings)
- Return ONLY the raw JSON array. No backticks, no explanation, no extra text."""


def call_groq_records(resource_name: str, schema: dict) -> list:
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable is not set")

    schema_str = json.dumps(schema)
    user_msg = f"Generate 5 realistic records for a '{resource_name}' resource with this schema: {schema_str}"

    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": RECORDS_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg}
        ],
        "temperature": 0.7,
        "max_tokens": 1024,
    }).encode("utf-8")

    req = urllib.request.Request(
        GROQ_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "MockDock/1.0",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=20) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    raw_text = body["choices"][0]["message"]["content"].strip()

    if raw_text.startswith("```"):
        lines = raw_text.splitlines()
        raw_text = "\n".join(
            line for line in lines if not line.startswith("```")
        ).strip()

    records = json.loads(raw_text)
    
    if isinstance(records, dict):
        records = [records]
        
    if not isinstance(records, list) or len(records) == 0:
        raise ValueError("AI returned an empty or invalid records array")

    return records


@ai_schema_bp.route("/api/generate-records", methods=["POST"])
def generate_records():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Request body must be valid JSON"}), 400

    resource_name = body.get("resource_name", "").strip()
    schema = body.get("schema")

    if not resource_name:
        return jsonify({"error": "resource_name is required"}), 400
    if not isinstance(schema, dict) or len(schema) == 0:
        return jsonify({"error": "schema must be a non-empty object"}), 400

    try:
        records = call_groq_records(resource_name, schema)
        return jsonify({"records": records}), 200

    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    except urllib.error.HTTPError as e:
        try:
            raw_body = e.read().decode()
            detail = json.loads(raw_body)
            msg = detail.get("error", {}).get("message", raw_body)
        except Exception:
            msg = str(e)
        return jsonify({"error": f"Groq API error {e.code}: {msg}"}), 502

    except urllib.error.URLError as e:
        return jsonify({"error": f"Could not reach Groq API: {e.reason}"}), 502

    except json.JSONDecodeError as e:
        return jsonify({"error": f"AI returned invalid JSON: {e.msg}"}), 502

    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500


@ai_schema_bp.route("/api/generate-schema", methods=["POST"])
def generate_schema():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Request body must be valid JSON"}), 400

    prompt = body.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    if len(prompt) > 500:
        return jsonify({"error": "prompt must be 500 characters or fewer"}), 400

    try:
        schema = call_groq(prompt)
        return jsonify({"schema": schema}), 200

    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    except urllib.error.HTTPError as e:
        try:
            raw_body = e.read().decode()
            detail = json.loads(raw_body)
            msg = detail.get("error", {}).get("message", raw_body)
        except Exception:
            msg = str(e)
        return jsonify({"error": f"Groq API error {e.code}: {msg}"}), 502

    except urllib.error.URLError as e:
        return jsonify({"error": f"Could not reach Groq API: {e.reason}"}), 502

    except json.JSONDecodeError as e:
        return jsonify({"error": f"AI returned invalid JSON: {e.msg}"}), 502

    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
