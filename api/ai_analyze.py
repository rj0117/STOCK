"""Vercel Serverless Function: GET /api/ai_analyze?code=XXXXXX
Claude AI 종합 분석. 캐싱·rate limit·일일 비용 한도는 _lib.get_ai_analysis 안에서 처리.
"""
import json
import sys
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import get_ai_analysis


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        code = qs.get("code", [""])[0]

        # 클라이언트 IP 추출 (Vercel은 x-forwarded-for 첫 값이 신뢰 가능)
        xff = self.headers.get("x-forwarded-for", "")
        client_ip = ""
        if xff:
            client_ip = xff.split(",")[0].strip()
        elif self.headers.get("x-real-ip"):
            client_ip = self.headers.get("x-real-ip", "").strip()
        else:
            try:
                client_ip = self.client_address[0]
            except Exception:
                client_ip = ""

        avg_price = qs.get("avg_price", [""])[0] or None
        shares = qs.get("shares", [""])[0] or None
        result = get_ai_analysis(code, client_ip=client_ip, avg_price=avg_price, shares=shares)

        # 내부 신호 _http_status 를 꺼내 외부로 응답
        status = result.pop("_http_status", 200)
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        # 429/503 에는 Retry-After 헤더 (초 단위, 표준)
        if status in (429, 503):
            ra = result.get("retry_after_seconds") or result.get("reset_in_seconds")
            if ra:
                self.send_header("Retry-After", str(int(ra)))
        self.end_headers()
        self.wfile.write(body)
