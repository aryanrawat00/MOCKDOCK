import time

from flask import g, request

from db import get_resource_by_name, insert_log


def register_request_logger(app):
    @app.before_request
    def store_request_start_time():
        g.request_start_time = time.perf_counter()

    @app.after_request
    def log_request(response):
        try:
            path = request.path or ""

            if path.startswith("/api/") or path.startswith("/interceptor/") or path.endswith("/check"):
                return response

            segments = [segment for segment in path.split("/") if segment]
            if len(segments) != 2:
                return response

            namespace_slug = segments[0]
            resource_name = segments[1]
            resource = get_resource_by_name(namespace_slug, resource_name)
            if not resource:
                return response

            start_time = getattr(g, "request_start_time", None)
            if start_time is None:
                response_time_ms = 0
            else:
                response_time_ms = int((time.perf_counter() - start_time) * 1000)

            payload = request.get_data(cache=True, as_text=True) or ""

            insert_log(
                namespace_slug,
                resource["id"],
                request.method,
                path,
                response.status_code,
                response_time_ms,
                payload,
            )
        except Exception:
            pass

        return response
