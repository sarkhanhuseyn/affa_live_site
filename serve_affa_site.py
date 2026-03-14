from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import gethostname, gethostbyname_ex


ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT / "site"
DEFAULT_STORE_PATH = SITE_DIR / "data" / "operator_store.json"
STORE_PATH = Path(os.environ.get("OPERATOR_STORE_PATH", str(DEFAULT_STORE_PATH))).expanduser()
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", os.environ.get("AFFA_PORT", "8080")))


def ensure_store() -> dict:
  STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
  if not STORE_PATH.exists():
    STORE_PATH.write_text(json.dumps({"matches": {}}, ensure_ascii=False, indent=2), encoding="utf-8")
  try:
    parsed = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    return parsed if isinstance(parsed, dict) and isinstance(parsed.get("matches"), dict) else {"matches": {}}
  except Exception:
    return {"matches": {}}


def save_store(payload: dict) -> None:
  STORE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


class AFFARequestHandler(SimpleHTTPRequestHandler):
  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(SITE_DIR), **kwargs)

  def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self) -> None:
    if self.path == "/api/overrides":
      self._send_json(ensure_store())
      return
    return super().do_GET()

  def do_PUT(self) -> None:
    if self.path != "/api/overrides":
      self.send_error(HTTPStatus.NOT_FOUND, "Not found")
      return
    try:
      length = int(self.headers.get("Content-Length", "0"))
      payload = json.loads(self.rfile.read(length) or b"{}")
      normalized = payload if isinstance(payload, dict) and isinstance(payload.get("matches"), dict) else {"matches": {}}
      save_store(normalized)
      self._send_json(normalized)
    except Exception as error:
      self._send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)


def local_addresses() -> list[str]:
  try:
    _, _, addresses = gethostbyname_ex(gethostname())
    return sorted({address for address in addresses if "." in address and not address.startswith("127.")})
  except Exception:
    return []


def main() -> None:
  ensure_store()
  server = ThreadingHTTPServer((HOST, PORT), AFFARequestHandler)
  print(f"AFFA site: http://localhost:{PORT}")
  for address in local_addresses():
    print(f"AFFA site on local network: http://{address}:{PORT}")
  print("Press Ctrl+C to stop.")
  server.serve_forever()


if __name__ == "__main__":
  main()
