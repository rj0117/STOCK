"""
로컬 개발용 서버
- site/ 정적 파일 서빙
- /api/stock?code=XXXXXX, /api/news?q=...  엔드포인트 (api_handlers와 동일 로직)
배포 환경(Vercel)에선 api/*.py 서버리스 함수가 동일 역할.
"""

import os
import sys
import json
from http import HTTPStatus
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SRC_DIR)
SITE_DIR = os.path.join(BASE_DIR, "public")

sys.path.insert(0, SRC_DIR)
from api_handlers import get_stock, get_news, get_flow, get_intraday, get_ai_analysis, load_env_file  # noqa

load_env_file(os.path.join(BASE_DIR, ".env"))


class Handler(SimpleHTTPRequestHandler):
    # 정적 .json 파일도 UTF-8 명시 (한글 깨짐 방지)
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".json": "application/json; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def log_message(self, format, *args):
        # 요청 로그 간소화
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            qs = parse_qs(parsed.query)
            try:
                if parsed.path == "/api/stock":
                    code = qs.get("code", [""])[0]
                    self._send_json(HTTPStatus.OK, get_stock(code))
                elif parsed.path == "/api/news":
                    q = qs.get("q", [""])[0]
                    display = int(qs.get("display", ["20"])[0])
                    self._send_json(HTTPStatus.OK, get_news(q, display))
                elif parsed.path == "/api/flow":
                    code = qs.get("code", [""])[0]
                    self._send_json(HTTPStatus.OK, get_flow(code))
                elif parsed.path == "/api/intraday":
                    code = qs.get("code", [""])[0]
                    self._send_json(HTTPStatus.OK, get_intraday(code))
                elif parsed.path == "/api/ai_analyze":
                    code = qs.get("code", [""])[0]
                    xff = self.headers.get("x-forwarded-for", "")
                    client_ip = (xff.split(",")[0].strip() if xff
                                 else (self.client_address[0] if self.client_address else ""))
                    result = get_ai_analysis(code, client_ip=client_ip)
                    status = result.pop("_http_status", HTTPStatus.OK)
                    self._send_json(status, result)
                else:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown api"})
            except Exception as e:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
            return
        # 정적 파일
        super().do_GET()


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"📡 로컬 서버 시작 - http://localhost:{port}/")
    print(f"   정적 디렉터리: {SITE_DIR}")
    print("   종료: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")
        server.server_close()


if __name__ == "__main__":
    main()
