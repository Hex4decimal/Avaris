#!/usr/bin/env python3
"""Serve the Avaris demo and its optional live image-analysis endpoint."""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
MODEL = os.getenv("AVARIS_OPENAI_MODEL", "gpt-5.6-terra")
MAX_REQUEST_BYTES = 12 * 1024 * 1024
DEMO_IMAGE_URL = "https://oceanservice.noaa.gov/news/sep24/helene-asheville-oct-5-960.jpg"
ALLOWED_IMAGE_PREFIXES = (
    "data:image/jpeg;base64,",
    "data:image/png;base64,",
    "data:image/webp;base64,",
)
LOCAL_ORIGIN_RE = re.compile(r"^https?://(?:localhost|127\.0\.0\.1)(?::\d+)?$")

ASSESSMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "damage_level": {
            "type": "string",
            "enum": ["none", "mild", "moderate", "severe"],
        },
        "confidence": {"type": "number"},
        "findings": {"type": "array", "items": {"type": "string"}},
        "recommended_action": {"type": "string"},
    },
    "required": ["damage_level", "confidence", "findings", "recommended_action"],
    "additionalProperties": False,
}


def openai_runtime_status() -> dict:
    installed = importlib.util.find_spec("openai") is not None
    version = None
    if installed:
        try:
            version = importlib.metadata.version("openai")
        except importlib.metadata.PackageNotFoundError:
            installed = False
    configured = bool(os.getenv("OPENAI_API_KEY"))
    return {
        "installed": installed,
        "version": version,
        "configured": configured,
        "ready": installed and configured,
    }


def analyze_image(image_input: str) -> dict:
    runtime = openai_runtime_status()
    if not runtime["configured"]:
        raise RuntimeError("OPENAI_API_KEY is not set on the Avaris server.")
    if not runtime["installed"]:
        raise RuntimeError(
            f"The openai package is not installed for {sys.executable}. "
            f"Install it with: \"{sys.executable}\" -m pip install openai"
        )
    if not (image_input.startswith(ALLOWED_IMAGE_PREFIXES) or image_input == DEMO_IMAGE_URL):
        raise ValueError("Use a JPEG, PNG, or WebP image, or the bundled NOAA demo URL.")

    from openai import OpenAI

    client = OpenAI()
    prompt = (
        "Assess this drone inspection image for post-catastrophe property damage. "
        "Focus on buildings and structures, not general storm scenery. Keep findings "
        "short and concrete. Confidence must be from 0 to 1. The recommended action "
        "should be a concise next step for an insurance or field-review team."
    )
    if image_input == DEMO_IMAGE_URL:
        prompt += " Assess the primary damaged property near the center of the frame rather than neighboring structures."
    response = client.responses.create(
        model=MODEL,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": image_input, "detail": "auto"},
                ],
            }
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": "damage_assessment",
                "strict": True,
                "schema": ASSESSMENT_SCHEMA,
            }
        },
    )
    result = json.loads(response.output_text)
    result["confidence"] = max(0.0, min(1.0, float(result["confidence"])))
    result["findings"] = [str(item) for item in result["findings"][:4]]
    return result


class AvarisHandler(SimpleHTTPRequestHandler):
    server_version = "AvarisDemo/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _allowed_origin(self) -> str | None:
        origin = self.headers.get("Origin", "")
        return origin if LOCAL_ORIGIN_RE.fullmatch(origin) else None

    def _cors_headers(self) -> None:
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API
        if urlparse(self.path).path.startswith("/api/"):
            self.send_response(204)
            self._cors_headers()
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if urlparse(self.path).path == "/api/status":
            runtime = openai_runtime_status()
            self.send_json(
                200,
                {
                    "service": "avaris-ai",
                    "configured": runtime["configured"],
                    "openai_installed": runtime["installed"],
                    "openai_version": runtime["version"],
                    "ready": runtime["ready"],
                    "model": MODEL,
                    "python_executable": sys.executable,
                },
            )
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if urlparse(self.path).path != "/api/analyze":
            self.send_json(404, {"error": "Not found."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json(400, {"error": "Invalid or oversized request."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            image_input = str(payload.get("image_data") or payload.get("image_url") or "")
            result = analyze_image(image_input)
            self.send_json(200, result)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Request body must be valid JSON."})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except RuntimeError as exc:
            self.send_json(503, {"error": str(exc)})
        except Exception as exc:
            self.log_error("AI analysis failed: %s", exc)
            self.send_json(502, {"error": f"Analysis failed: {exc}"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the Avaris web demo and local AI endpoint.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    address = (args.host, args.port)
    server = ThreadingHTTPServer(address, AvarisHandler)
    print(f"Avaris demo: http://{args.host}:{args.port}")
    runtime = openai_runtime_status()
    if runtime["ready"]:
        version = f"openai {runtime['version']}" if runtime["version"] else "openai installed"
        print(f"Live AI: ready ({MODEL}; {version})")
        print(f"Python: {sys.executable}")
    elif not runtime["installed"]:
        print(f"Live AI: unavailable (openai is not installed for {sys.executable})")
        print(f'Install: "{sys.executable}" -m pip install openai')
    else:
        print("Live AI: disabled (set OPENAI_API_KEY before starting the server)")
        print(f"Python: {sys.executable}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
