"""
공유 API 로직 - 로컬 server.py와 Vercel api/*.py에서 함께 사용
- get_stock(code): 네이버 금융에서 실시간 시세 조회
- get_news(query): 네이버 검색 Open API로 뉴스 조회
"""

import os
import re
import html
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
def now_kst():
    return datetime.now(KST)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36"
}

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    return html.unescape(_TAG_RE.sub("", text or "")).strip()


def _to_number(text: str) -> float:
    if not text:
        return 0.0
    cleaned = text.replace(",", "").replace("+", "").replace("％", "").replace("%", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def get_stock(code: str) -> dict:
    """네이버 금융 item/main 페이지에서 현재가/전일종가/등락률 추출"""
    code = (code or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return {"error": "유효한 6자리 종목 코드가 필요합니다", "code": code}

    url = f"https://finance.naver.com/item/main.naver?code={code}"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=8)
        ct = (resp.headers.get("Content-Type", "") or "").lower()
        resp.encoding = "euc-kr" if ("euc-kr" in ct or "euckr" in ct) else "utf-8"
        html_text = resp.text
    except Exception as e:
        return {"error": f"요청 실패: {e}", "code": code}

    soup = BeautifulSoup(html_text, "lxml")

    name_tag = soup.select_one("div.wrap_company h2 a") or soup.select_one("h2 a")
    name = name_tag.get_text(strip=True) if name_tag else ""

    today_tag = soup.select_one("p.no_today span.blind")
    price = _to_number(today_tag.get_text(strip=True)) if today_tag else 0.0

    # 전일종가 - table.no_info에 있음
    prev_close = 0.0
    for td in soup.select("table.no_info td"):
        label = td.select_one(".sptxt")
        if not label:
            continue
        if "전일" in label.get_text():
            val = td.select_one(".blind")
            if val:
                prev_close = _to_number(val.get_text(strip=True))
                break

    # 등락폭/등락률
    change = price - prev_close if prev_close else 0.0
    change_pct = (change / prev_close * 100.0) if prev_close else 0.0

    return {
        "code": code,
        "name": name,
        "price": int(price) if price else 0,
        "prev_close": int(prev_close) if prev_close else 0,
        "change": int(round(change)),
        "change_pct": round(change_pct, 2),
        "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_news(query: str, display: int = 20) -> list:
    """네이버 검색 Open API로 뉴스 검색"""
    query = (query or "").strip()
    if not query:
        return []

    client_id = os.environ.get("NAVER_CLIENT_ID", "")
    client_secret = os.environ.get("NAVER_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return [{"error": "NAVER_CLIENT_ID/SECRET 환경변수가 설정되지 않았습니다"}]

    api_url = "https://openapi.naver.com/v1/search/news.json"
    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }

    try:
        resp = requests.get(
            api_url, headers=headers, timeout=10,
            params={"query": query, "display": min(max(display, 1), 100), "sort": "date"},
        )
        if resp.status_code != 200:
            return [{"error": f"API 오류 {resp.status_code}"}]
        items = resp.json().get("items", [])
    except Exception as e:
        return [{"error": f"요청 실패: {e}"}]

    out = []
    for item in items:
        title = _strip_html(item.get("title", ""))
        if not title:
            continue
        out.append({
            "title": title,
            "link": item.get("originallink") or item.get("link", ""),
            "summary": _strip_html(item.get("description", "")),
            "pubDate": item.get("pubDate", ""),
        })
    return out


def _parse_signed_int(text: str) -> int:
    """'+1,599,184' / '-7,997,922' → int"""
    if not text:
        return 0
    cleaned = text.replace(",", "").replace(" ", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return 0


def get_flow(code: str) -> dict:
    """모바일 API로 종목별 최근 일자 수급(외국인/기관/개인) 조회.
    반환: {code, name, days: [{date, close, change, foreign_net, organ_net, individual_net, foreign_hold_ratio}, ...]}
    """
    code = (code or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return {"error": "유효한 6자리 종목 코드가 필요합니다", "code": code}

    url = f"https://m.stock.naver.com/api/stock/{code}/integration"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=8)
        resp.raise_for_status()
        j = resp.json()
    except Exception as e:
        return {"error": f"요청 실패: {e}", "code": code}

    deals = j.get("dealTrendInfos") or []
    days = []
    for d in deals:
        bd = d.get("bizdate", "")
        # YYYYMMDD → YYYY-MM-DD
        date_fmt = f"{bd[:4]}-{bd[4:6]}-{bd[6:8]}" if len(bd) == 8 else bd
        change = _parse_signed_int(d.get("compareToPreviousClosePrice", "0"))
        direction = (d.get("compareToPreviousPrice") or {}).get("name", "")
        # FALLING이면 음수
        if direction == "FALLING" and change > 0:
            change = -change
        days.append({
            "date": date_fmt,
            "close": _parse_signed_int(d.get("closePrice", "0")),
            "change": change,
            "foreign_net": _parse_signed_int(d.get("foreignerPureBuyQuant", "0")),
            "organ_net": _parse_signed_int(d.get("organPureBuyQuant", "0")),
            "individual_net": _parse_signed_int(d.get("individualPureBuyQuant", "0")),
            "foreign_hold_ratio": d.get("foreignerHoldRatio", ""),
            "volume": _parse_signed_int(d.get("accumulatedTradingVolume", "0")),
        })
    return {
        "code": code,
        "name": j.get("stockName", ""),
        "days": days,
        "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
    }


def load_env_file(env_path: str) -> None:
    """로컬 .env 파일 로드 (Vercel에선 환경변수가 이미 주입되므로 호출 안 함)"""
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
