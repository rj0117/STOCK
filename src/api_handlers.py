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

    # 시간외 단일가 (모바일 basic API)
    after_price = 0
    after_change = 0
    after_change_pct = 0.0
    try:
        r2 = requests.get(f"https://m.stock.naver.com/api/stock/{code}/basic", headers=HEADERS, timeout=6)
        if r2.status_code == 200:
            jb = r2.json()
            ovr = jb.get("overMarketPriceInfo") or {}
            ap_s = ovr.get("overPrice") or ""
            if ap_s:
                after_price = _to_number(ap_s)
                ac_s = ovr.get("compareToPreviousClosePrice") or "0"
                after_change = int(_to_number(ac_s))
                fr = ovr.get("fluctuationsRatio")
                after_change_pct = float(fr) if fr else 0.0
    except Exception:
        pass

    return {
        "code": code,
        "name": name,
        "price": int(price) if price else 0,
        "prev_close": int(prev_close) if prev_close else 0,
        "change": int(round(change)),
        "change_pct": round(change_pct, 2),
        "after_price": int(after_price) if after_price else 0,
        "after_change": after_change,
        "after_change_pct": round(after_change_pct, 2),
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


def _parse_signed_int(text) -> int:
    """'+1,599,184' / '-7,997,922' / 71686077(int) → int"""
    if text is None or text == "":
        return 0
    if isinstance(text, (int, float)):
        return int(text)
    try:
        cleaned = str(text).replace(",", "").replace(" ", "").strip()
        return int(cleaned)
    except (ValueError, TypeError):
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
    # 60일 일별 시세도 함께 (기술적 지표 계산용)
    prices_60d = []
    try:
        url2 = f"https://m.stock.naver.com/api/stock/{code}/price?pageSize=60"
        resp2 = requests.get(url2, headers=HEADERS, timeout=8)
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


def get_intraday(code: str) -> dict:
    """당일 분봉 시세 (네이버 fchart). 반환: {code, date, data: [{time, close, volume}]}"""
    code = (code or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return {"error": "유효한 6자리 종목 코드가 필요합니다", "code": code}
    url = f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=minute&count=400&requestType=0"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=8)
        resp.raise_for_status()
        text = resp.content.decode("euc-kr", errors="replace")
    except Exception as e:
        return {"error": f"요청 실패: {e}", "code": code}

    items = re.findall(r'data="([^"]+)"', text)
    if not items:
        return {"code": code, "date": "", "data": []}

    # 마지막(최신) 영업일만 추출
    last_yyyymmdd = items[-1].split("|")[0][:8]
    out = []
    for it in items:
        parts = it.split("|")
        if not parts or parts[0][:8] != last_yyyymmdd:
            continue
        ts = parts[0]
        if len(ts) < 12:
            continue
        time_hhmm = ts[8:12]
        try:
            close_val = parts[4]
            vol_val = parts[5] if len(parts) > 5 else "0"
            if close_val == "null" or close_val == "":
                continue
            close = int(close_val)
            volume = int(vol_val) if vol_val not in ("null", "") else 0
        except (ValueError, IndexError):
            continue
        out.append({"time": time_hhmm, "close": close, "volume": volume})

    # 시간순 정렬
    out.sort(key=lambda x: x["time"])
    date_fmt = f"{last_yyyymmdd[:4]}-{last_yyyymmdd[4:6]}-{last_yyyymmdd[6:8]}"
    return {"code": code, "date": date_fmt, "data": out, "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S")}


def get_ai_analysis(code: str) -> dict:
    """Claude AI에게 종목 종합 판단 요청."""
    code = (code or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return {"error": "유효한 6자리 종목 코드가 필요합니다"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "Anthropic API key 미설정", "detail": "Vercel 환경변수에 ANTHROPIC_API_KEY를 추가해주세요."}

    # 종목 데이터 수집
    stock = get_stock(code)
    if stock.get("error"):
        return {"error": "시세 조회 실패", "detail": stock.get("error", "")}
    flow = get_flow(code)
    news_query = stock.get("name") or code
    news = get_news(news_query, display=10)
    news_list = [n for n in news if isinstance(n, dict) and n.get("title")][:8]

    # 프롬프트 구성
    name = stock.get("name") or code
    price = stock.get("price", 0)
    change = stock.get("change", 0)
    change_pct = stock.get("change_pct", 0)
    after_price = stock.get("after_price", 0)
    after_change_pct = stock.get("after_change_pct", 0)
    days = flow.get("days") or []
    days_summary = []
    for d in days[:5]:
        days_summary.append(
            f"  {d.get('date')}: 종가 {d.get('close'):,}원 ({d.get('change'):+,}) · "
            f"외인 {d.get('foreign_net'):+,} · 기관 {d.get('organ_net'):+,} · 개인 {d.get('individual_net'):+,}"
        )
    days_text = "\n".join(days_summary) if days_summary else "(데이터 없음)"

    prices_60d = flow.get("prices_60d") or []
    if len(prices_60d) >= 20:
        recent_closes = [p["close"] for p in prices_60d[:20] if p.get("close")]
        high_60 = max(p["close"] for p in prices_60d if p.get("close"))
        low_60 = min(p["close"] for p in prices_60d if p.get("close"))
        sma5 = sum(p["close"] for p in prices_60d[:5]) / 5
        sma20 = sum(recent_closes) / len(recent_closes)
        price_summary = f"60일 최고 {high_60:,}원, 최저 {low_60:,}원 / 5일 평균 {sma5:,.0f}원, 20일 평균 {sma20:,.0f}원"
    else:
        price_summary = "(60일 시세 부족)"

    news_text = "\n".join(f"  - {n.get('title', '')[:100]}" for n in news_list) or "(없음)"

    prompt = f"""다음은 한국 주식 '{name}({code})'의 현재 정보입니다. 이 정보를 바탕으로 단기(1-2주) 투자 판단을 내려주세요.

[시세]
현재가: {price:,}원 (정규장 종가, 전일대비 {change:+,}원 / {change_pct:+.2f}%)
{f"시간외 단일가: {after_price:,}원 ({after_change_pct:+.2f}%)" if after_price else ""}
{price_summary}

[최근 5일 수급 (단위: 주식 수, + 순매수 / - 순매도)]
{days_text}

[관련 뉴스 헤드라인 8건]
{news_text}

다음 JSON 형식으로만 응답해주세요. 다른 텍스트 금지:
{{
  "action": "buy" 또는 "sell" 또는 "hold",
  "confidence": 1~10 정수 (확신도),
  "analysis": "150자 내외 한국어 분석. 핵심 근거 2~3개 위주. 매수/매도/관망 이유 명확히."
}}
"""

    # Claude API 호출
    try:
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        body = {
            "model": "claude-haiku-4-5",
            "max_tokens": 600,
            "messages": [{"role": "user", "content": prompt}],
        }
        resp = requests.post("https://api.anthropic.com/v1/messages", json=body, headers=headers, timeout=30)
        if resp.status_code != 200:
            return {"error": f"Claude API 오류 {resp.status_code}", "detail": resp.text[:200]}
        data = resp.json()
        content = data.get("content", [])
        text = ""
        for c in content:
            if c.get("type") == "text":
                text += c.get("text", "")
        # JSON 추출
        import json as _json
        # ```json ... ``` 또는 직접 JSON 텍스트에서 추출
        m = re.search(r'\{[\s\S]*\}', text)
        if not m:
            return {"error": "AI 응답 파싱 실패", "detail": text[:200]}
        result = _json.loads(m.group(0))
        return {
            "code": code,
            "name": name,
            "action": result.get("action", "hold"),
            "confidence": result.get("confidence", 5),
            "analysis": result.get("analysis", ""),
            "model": data.get("model", "claude-haiku-4-5"),
            "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"error": "Claude API 호출 실패", "detail": str(e)[:200]}


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
