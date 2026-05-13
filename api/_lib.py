"""Vercel 함수에서 src/api_handlers.py를 임포트하기 위한 어댑터.
Vercel은 함수 디렉터리 외부 import가 제한적이라, 핵심 로직을 함께 패키징해 둔다.
api_handlers.py 와 동일한 코드를 유지(import 호환). 변경 시 양쪽 동기화 필요."""

import os
import re
import math
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

    # 시간외 단일가 (모바일 basic)
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

    # 펀더멘털 (PER/PBR/시가총액) — 동일 PC 페이지에서 추출 (추가 호출 없음)
    per = pbr = None
    market_cap = ""
    industry = ""
    roe = op_margin = None
    next_earnings = ""
    try:
        per_el = soup.select_one("#_per")
        pbr_el = soup.select_one("#_pbr")
        mkt_el = soup.select_one("#_market_sum")
        if per_el:
            try: per = float(per_el.get_text(strip=True).replace(",", ""))
            except ValueError: pass
        if pbr_el:
            try: pbr = float(pbr_el.get_text(strip=True).replace(",", ""))
            except ValueError: pass
        if mkt_el:
            market_cap = mkt_el.get_text(" ", strip=True)

        # 업종명: wrap_company 내부 description 영역에 보통 "업종" 명시
        for sel in ["div.description em", "div.wrap_company em", "p.section_industry a"]:
            el = soup.select_one(sel)
            if el:
                t = el.get_text(strip=True)
                if t and len(t) < 40:
                    industry = t
                    break

        # ROE / 영업이익률 — 기업실적분석 표(table.tb_type1) th 매칭
        for table in soup.select("table.tb_type1, table.tb_type1_ifrs"):
            for tr in table.select("tr"):
                th = tr.select_one("th")
                if not th: continue
                label = th.get_text(strip=True)
                tds = tr.select("td")
                if not tds: continue
                # 가장 최근 분기 = 마지막 의미있는 td
                for td in reversed(tds):
                    txt = td.get_text(strip=True).replace(",", "")
                    if not txt or txt == "-": continue
                    try:
                        val = float(txt)
                        if "ROE" in label.upper() and roe is None:
                            roe = val
                        elif "영업이익률" in label and op_margin is None:
                            op_margin = val
                        break
                    except ValueError:
                        continue

        # 실적 발표일: 일부 종목 페이지 우상단 "다음 실적발표" 또는 비슷한 표기
        for el in soup.select(".section_strock_bottom, .section.cop_analysis"):
            text = el.get_text(" ", strip=True)
            m = re.search(r"(\d{4}[./-]\d{1,2}[./-]\d{1,2})\s*(?:예정|실적|발표|컨센서스)", text)
            if m:
                next_earnings = m.group(1)
                break
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
        "per": per,
        "pbr": pbr,
        "market_cap": market_cap,
        "industry": industry,
        "roe": roe,
        "op_margin": op_margin,
        "next_earnings": next_earnings,
        "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
    }


_MACRO_CACHE = {"ts": 0, "value": None}

def get_macro_context():
    """USD/KRW 환율 + 미국 전일 마감(다우/나스닥/S&P). 5분 캐시.
    네이버 marketindex 페이지에서 통합 파싱."""
    import time
    now = time.time()
    if _MACRO_CACHE["value"] and now - _MACRO_CACHE["ts"] < 300:
        return _MACRO_CACHE["value"]
    result = {"usd_krw": None, "dow": None, "nasdaq": None, "sp500": None}
    try:
        r = requests.get("https://finance.naver.com/marketindex/", headers=HEADERS, timeout=8)
        ct = (r.headers.get("Content-Type", "") or "").lower()
        r.encoding = "euc-kr" if ("euc-kr" in ct or "euckr" in ct) else "utf-8"
        soup = BeautifulSoup(r.text, "lxml")
        # 환율: 미국 USD
        usd_box = soup.select_one("#exchangeList li.on")
        if not usd_box:
            for li in soup.select("#exchangeList li"):
                title = li.select_one("h3.h_lst")
                if title and "미국" in title.get_text():
                    usd_box = li; break
        if usd_box:
            val_el = usd_box.select_one(".value")
            chg_el = usd_box.select_one(".change")
            blind = usd_box.select_one(".blind")
            v = _to_number(val_el.get_text(strip=True)) if val_el else 0
            chg = _to_number(chg_el.get_text(strip=True)) if chg_el else 0
            direction = (blind.get_text(strip=True) if blind else "")
            if "하락" in direction: chg = -chg
            result["usd_krw"] = {"value": round(v, 2), "change": round(chg, 2)}
        # 미국 증시 박스: id="americaWorldIndexes" 등 또는 .market_include
        # 다우/나스닥/S&P500
        idx_map = {"다우산업": "dow", "나스닥": "nasdaq", "S&P500": "sp500"}
        for li in soup.select("ul#worldIndexes li, ul.data1 li"):
            title_el = li.select_one("h3.h_lst, .lst_dot a, .blind")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            target_key = None
            for k, v in idx_map.items():
                if k in title or k.replace("&", "") in title:
                    target_key = v; break
            if not target_key:
                continue
            val_el = li.select_one(".value")
            chg_el = li.select_one(".change")
            blind = li.select_one(".blind")
            if val_el:
                v = _to_number(val_el.get_text(strip=True))
                chg = _to_number(chg_el.get_text(strip=True)) if chg_el else 0
                d = (blind.get_text(strip=True) if blind else "")
                if "하락" in d: chg = -chg
                result[target_key] = {"value": round(v, 2), "change": round(chg, 2)}
    except Exception as e:
        result["error"] = str(e)[:120]
    _MACRO_CACHE["ts"] = now
    _MACRO_CACHE["value"] = result
    return result


_INDEX_CACHE = {"ts": 0, "value": None}

def get_market_indexes():
    """KOSPI/KOSDAQ 현재 지수와 등락. 60초 캐시."""
    import time
    now = time.time()
    if _INDEX_CACHE["value"] and now - _INDEX_CACHE["ts"] < 60:
        return _INDEX_CACHE["value"]
    result = {}
    for code in ("KOSPI", "KOSDAQ"):
        try:
            url = f"https://finance.naver.com/sise/sise_index.naver?code={code}"
            r = requests.get(url, headers=HEADERS, timeout=6)
            ct = (r.headers.get("Content-Type", "") or "").lower()
            r.encoding = "euc-kr" if ("euc-kr" in ct or "euckr" in ct) else "utf-8"
            soup = BeautifulSoup(r.text, "lxml")
            now_el = soup.select_one("#now_value")
            chg_el = soup.select_one("#change_value_and_rate")
            value = _to_number(now_el.get_text(strip=True)) if now_el else 0
            change_text = chg_el.get_text(" ", strip=True) if chg_el else ""
            # change_text 예: "12.34  +0.41%" 또는 "-3.21 -0.15%"
            sign = -1.0 if "-" in change_text or "하락" in change_text else 1.0
            nums = re.findall(r"[\d.]+", change_text)
            change_val = float(nums[0]) * sign if nums else 0.0
            change_pct = (float(nums[1]) if len(nums) > 1 else 0.0) * sign
            result[code] = {
                "value": value,
                "change": round(change_val, 2),
                "change_pct": round(change_pct, 2),
            }
        except Exception as e:
            result[code] = {"value": 0, "change": 0, "change_pct": 0, "error": str(e)}
    _INDEX_CACHE["ts"] = now
    _INDEX_CACHE["value"] = result
    return result


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


def get_intraday(code):
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

    out.sort(key=lambda x: x["time"])
    date_fmt = f"{last_yyyymmdd[:4]}-{last_yyyymmdd[4:6]}-{last_yyyymmdd[6:8]}"
    return {"code": code, "date": date_fmt, "data": out, "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S")}


# ---- 기술지표/신뢰구간 (recommend.py와 동일 휴리스틱, 인라인) ----
def _ai_calc_technicals(prices_60d):
    if not prices_60d or len(prices_60d) < 5:
        return None
    ordered = list(reversed(prices_60d))
    closes = [d.get("close", 0) for d in ordered]
    n = len(closes)
    def sma(period, end):
        if end + 1 < period: return None
        return sum(closes[end - period + 1: end + 1]) / period
    last = n - 1
    ma5 = sma(5, last); ma20 = sma(20, last)
    ma5_prev = sma(5, last - 1); ma20_prev = sma(20, last - 1)
    divergence20 = ((closes[last] - ma20) / ma20 * 100) if ma20 else None
    rsi14 = None
    if n >= 15:
        g = l = 0
        for i in range(1, 15):
            d = closes[i] - closes[i-1]
            if d > 0: g += d
            else: l += -d
        avg_g, avg_l = g/14, l/14
        for i in range(15, n):
            d = closes[i] - closes[i-1]
            avg_g = (avg_g*13 + (d if d > 0 else 0)) / 14
            avg_l = (avg_l*13 + (-d if d < 0 else 0)) / 14
        rsi14 = 100 if avg_l == 0 else 100 - 100/(1 + avg_g/avg_l)
    golden = dead = False
    if None not in (ma5, ma20, ma5_prev, ma20_prev):
        golden = ma5_prev <= ma20_prev and ma5 > ma20
        dead = ma5_prev >= ma20_prev and ma5 < ma20
    low_bounce = False
    if n >= 6:
        ref = closes[max(0, last - 5)]
        if ref > 0 and closes[last - 1] > 0:
            r5 = (closes[last-1] - ref) / ref * 100
            r1 = (closes[last] - closes[last-1]) / closes[last-1] * 100
            if r5 <= -7 and r1 >= 2: low_bounce = True
    return {"rsi14": rsi14, "ma5": ma5, "ma20": ma20,
            "divergence20": divergence20, "golden_cross": golden,
            "dead_cross": dead, "low_bounce": low_bounce}


def _ai_calc_forecast(prices_60d, current_price):
    if not prices_60d or len(prices_60d) < 20 or not current_price:
        return None
    ordered = list(reversed(prices_60d))
    returns = []
    for i in range(1, len(ordered)):
        prev = ordered[i-1].get("close", 0)
        if prev > 0:
            returns.append(math.log(ordered[i].get("close", 0) / prev))
    if len(returns) < 10:
        return None
    mu = sum(returns) / len(returns)
    var = sum((r - mu) ** 2 for r in returns) / len(returns)
    sd = math.sqrt(var)
    def at(t):
        sig = sd * math.sqrt(t)
        exp = current_price * math.exp(mu * t)
        return {
            "expected_pct": round((exp/current_price - 1) * 100, 1),
            "lower_pct": round((math.exp(mu*t - 1.96*sig) - 1) * 100, 1),
            "upper_pct": round((math.exp(mu*t + 1.96*sig) - 1) * 100, 1),
        }
    return {"oneWeek": at(5), "twoWeek": at(10),
            "daily_mean_pct": round(mu * 100, 2),
            "daily_sd_pct": round(sd * 100, 2)}


def _ai_tech_summary(t):
    if not t: return "(60일 시세 부족)"
    parts = []
    if t["rsi14"] is not None:
        parts.append(f"RSI14 {t['rsi14']:.1f}" + (" [저가권]" if t['rsi14'] <= 30 else " [과열]" if t['rsi14'] >= 70 else ""))
    if t["golden_cross"]: parts.append("골든크로스 발생")
    if t["dead_cross"]: parts.append("데드크로스 발생")
    if t["low_bounce"]: parts.append("저점 반등 시그널")
    if t["divergence20"] is not None:
        d = t["divergence20"]
        parts.append(f"20일선 이격도 {d:+.1f}%")
    if t["ma5"] and t["ma20"]:
        rel = "상승 정렬" if t["ma5"] > t["ma20"] else "하락 정렬"
        parts.append(f"5일선·20일선 {rel}")
    return ", ".join(parts) if parts else "(특별한 시그널 없음)"


def get_ai_analysis(code):
    import json as _json
    code = (code or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return {"error": "유효한 6자리 종목 코드가 필요합니다"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "Anthropic API key 미설정", "detail": "Vercel 환경변수에 ANTHROPIC_API_KEY 추가 필요"}

    stock = get_stock(code)
    if stock.get("error"):
        return {"error": "시세 조회 실패", "detail": stock.get("error", "")}
    flow = get_flow(code)
    news_query = stock.get("name") or code
    news = get_news(news_query, display=10)
    news_list = [n for n in news if isinstance(n, dict) and n.get("title")][:8]
    indexes = get_market_indexes()
    macro = get_macro_context()

    name = stock.get("name") or code
    price = stock.get("price", 0)
    change = stock.get("change", 0)
    change_pct = stock.get("change_pct", 0)
    after_price = stock.get("after_price", 0)
    after_change_pct = stock.get("after_change_pct", 0)
    per = stock.get("per")
    pbr = stock.get("pbr")
    mcap = stock.get("market_cap") or ""
    industry = stock.get("industry") or ""
    roe = stock.get("roe")
    op_margin = stock.get("op_margin")
    next_earnings = stock.get("next_earnings") or ""

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
        high_60 = max(p["close"] for p in prices_60d if p.get("close"))
        low_60 = min(p["close"] for p in prices_60d if p.get("close"))
        price_summary = f"60일 최고 {high_60:,}원, 최저 {low_60:,}원"
    else:
        price_summary = "(60일 시세 부족)"

    tech = _ai_calc_technicals(prices_60d)
    tech_text = _ai_tech_summary(tech)
    forecast = _ai_calc_forecast(prices_60d, price)
    if forecast:
        forecast_text = (
            f"1주(5거래일): 기대 {forecast['oneWeek']['expected_pct']:+.1f}% / "
            f"95% 범위 {forecast['oneWeek']['lower_pct']:+.1f}% ~ {forecast['oneWeek']['upper_pct']:+.1f}%\n"
            f"2주(10거래일): 기대 {forecast['twoWeek']['expected_pct']:+.1f}% / "
            f"95% 범위 {forecast['twoWeek']['lower_pct']:+.1f}% ~ {forecast['twoWeek']['upper_pct']:+.1f}%\n"
            f"(일일 평균 수익률 {forecast['daily_mean_pct']:+.2f}%, 일일 변동성 ±{forecast['daily_sd_pct']:.2f}%)"
        )
    else:
        forecast_text = "(데이터 부족)"

    funda_parts = []
    if per is not None: funda_parts.append(f"PER {per:.2f}")
    if pbr is not None: funda_parts.append(f"PBR {pbr:.2f}")
    if roe is not None: funda_parts.append(f"ROE {roe:.2f}%")
    if op_margin is not None: funda_parts.append(f"영업이익률 {op_margin:.2f}%")
    if mcap: funda_parts.append(f"시가총액 {mcap}")
    if industry: funda_parts.append(f"업종 [{industry}]")
    funda_text = " · ".join(funda_parts) if funda_parts else "(미수집)"
    earnings_text = f"다음 실적 발표 예정: {next_earnings}" if next_earnings else "(실적 발표 일정 미수집)"

    kospi = indexes.get("KOSPI", {})
    kosdaq = indexes.get("KOSDAQ", {})
    index_text = (
        f"KOSPI {kospi.get('value', 0):,.2f} ({kospi.get('change_pct', 0):+.2f}%) · "
        f"KOSDAQ {kosdaq.get('value', 0):,.2f} ({kosdaq.get('change_pct', 0):+.2f}%)"
    )
    macro_parts = []
    usd = macro.get("usd_krw")
    if usd:
        macro_parts.append(f"USD/KRW {usd['value']:,.2f}원 ({usd['change']:+,.2f}원)")
    for k, label in [("dow", "다우"), ("nasdaq", "나스닥"), ("sp500", "S&P500")]:
        m = macro.get(k)
        if m:
            macro_parts.append(f"{label} {m['value']:,.2f} ({m['change']:+,.2f})")
    macro_text = " · ".join(macro_parts) if macro_parts else "(거시 데이터 미수집)"

    news_lines = []
    for i, n in enumerate(news_list, 1):
        title = (n.get("title") or "")[:120]
        summary = (n.get("summary") or "")[:200]
        if summary:
            news_lines.append(f"  {i}. {title}\n     └ {summary}")
        else:
            news_lines.append(f"  {i}. {title}")
    news_text = "\n".join(news_lines) or "(없음)"

    prompt = f"""당신은 한국 주식 단기 투자(1-2주) 분석가입니다. 다음 정보를 종합해 '{name}({code})' 의 매수/매도/관망 판단을 내려주세요.

[1. 종목 시세]
현재가: {price:,}원 (전일대비 {change:+,}원 / {change_pct:+.2f}%)
{f"시간외 단일가: {after_price:,}원 ({after_change_pct:+.2f}%)" if after_price else "시간외: 없음"}
{price_summary}

[2. 펀더멘털 + 업종]
{funda_text}
{earnings_text}

[3. 한국 시장 환경]
{index_text}

[3-1. 거시 (환율 / 미국 전일 마감)]
{macro_text}

[4. 기술적 지표 (60일 시세 기반)]
{tech_text}

[5. 1-2주 통계 신뢰구간 (최근 변동성 기반 95% 추정)]
{forecast_text}

[6. 최근 5일 외인/기관/개인 수급]
{days_text}

[7. 관련 뉴스 8건 (제목과 요약)]
{news_text}

---
판단 가이드:
- 신뢰구간은 변동성 기반 통계일 뿐, 실적·정책 이벤트로 무력해질 수 있다는 점 감안
- 기술 지표와 수급이 한 방향으로 정렬되면 신뢰도 ↑
- 뉴스 본문 내용을 가볍게 보지 말 것: 호재성 키워드의 진위와 임팩트 함께 평가
- 시장 환경(KOSPI/KOSDAQ)과 같은 방향이면 동조 효과 고려
- 수출주(반도체/자동차/조선 등)는 환율(USD/KRW) 방향과 미국 시장 흐름이 강한 영향
- 실적 발표 임박 시(D-7 이내) 변동성 급등 가능성 — 신뢰구간 무력화 위험 명시
- 업종 정보를 활용해 종목 특성과 같은 방향성을 가질 가능성 큰 거시 변수가 무엇인지 판단

다음 JSON 형식으로만 응답. 다른 텍스트 금지:
{{
  "action": "buy" 또는 "sell" 또는 "hold",
  "confidence": 1~10 정수,
  "analysis": "200자 내외 한국어 분석. 핵심 근거 3개 명시. 어떤 시그널들이 같은 방향인지 또는 충돌하는지 짚어주세요."
}}
"""

    try:
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        body = {
            "model": "claude-sonnet-4-6",
            "max_tokens": 800,
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
        m = re.search(r'\{[\s\S]*\}', text)
        if not m:
            return {"error": "AI 응답 파싱 실패", "detail": text[:200]}
        result = _json.loads(m.group(0))
        usage = data.get("usage", {}) or {}
        return {
            "code": code,
            "name": name,
            "action": result.get("action", "hold"),
            "confidence": result.get("confidence", 5),
            "analysis": result.get("analysis", ""),
            "model": data.get("model", "claude-sonnet-4-6"),
            "usage": {
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            },
            "fetched_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"error": "Claude API 호출 실패", "detail": str(e)[:200]}


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
