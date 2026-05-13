"""Vercel 함수에서 src/api_handlers.py를 임포트하기 위한 어댑터.
Vercel은 함수 디렉터리 외부 import가 제한적이라, 핵심 로직을 함께 패키징해 둔다.
api_handlers.py 와 동일한 코드를 유지(import 호환). 변경 시 양쪽 동기화 필요."""

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


def _strip_html(text):
    return html.unescape(_TAG_RE.sub("", text or "")).strip()


def _to_number(text):
    if not text:
        return 0.0
    cleaned = text.replace(",", "").replace("+", "").replace("％", "").replace("%", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def get_stock(code):
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


def _parse_signed_int(text):
    if text is None or text == "":
        return 0
    if isinstance(text, (int, float)):
        return int(text)
    try:
        cleaned = str(text).replace(",", "").replace(" ", "").strip()
        return int(cleaned)
    except (ValueError, TypeError):
        return 0


def get_flow(code):
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
        date_fmt = f"{bd[:4]}-{bd[4:6]}-{bd[6:8]}" if len(bd) == 8 else bd
        change = _parse_signed_int(d.get("compareToPreviousClosePrice", "0"))
        direction = (d.get("compareToPreviousPrice") or {}).get("name", "")
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
    # 60일 일별 시세도 함께 (기술적 지표 계산용)
    prices_60d = []
    try:
        url2 = f"https://m.stock.naver.com/api/stock/{code}/price?pageSize=60"
        resp2 = requests.get(url2, headers=HEADERS, timeout=10)
        if resp2.status_code == 200:
            items = resp2.json()
            if isinstance(items, list):
                for d in items:
                    prices_60d.append({
                        "date": d.get("localTradedAt", ""),
                        "close": _parse_signed_int(d.get("closePrice", 0)),
                        "open": _parse_signed_int(d.get("openPrice", 0)),
                        "high": _parse_signed_int(d.get("highPrice", 0)),
                        "low": _parse_signed_int(d.get("lowPrice", 0)),
                        "volume": _parse_signed_int(d.get("accumulatedTradingVolume", 0)),
                    })
    except Exception:
        pass

    return {
        "code": code,
        "name": j.get("stockName", ""),
        "days": days,
        "prices_60d": prices_60d,
        "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_news(query, display=20):
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
            params={"query": query, "display": min(max(int(display), 1), 100), "sort": "date"},
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
