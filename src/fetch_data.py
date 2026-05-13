"""
한국 주식 데이터 수집기
- 네이버 금융 인기 검색 종목 TOP 50
- 네이버 금융 주요 뉴스 (전체 섹션)
- 뉴스와 연관된 종목 매칭 → TOP 30 + 호재 종목
- 카테고리별 고정 종목 조회
"""

import requests
from bs4 import BeautifulSoup
import json
import re
import html
from datetime import datetime, timezone, timedelta
import os
import time

KST = timezone(timedelta(hours=9))
def now_kst():
    return datetime.now(KST)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def _decode_resp(resp):
    """HTTP 응답 헤더의 charset을 보고 인코딩 결정.
    네이버 페이지: item/main 등은 UTF-8, sise_market_sum 등은 EUC-KR.
    apparent_encoding(chardet)은 영문 위주 페이지에서 CP1251로 오판하니 사용하지 않음."""
    ct = (resp.headers.get("Content-Type", "") or "").lower()
    if "euc-kr" in ct or "euckr" in ct:
        resp.encoding = "euc-kr"
    else:
        resp.encoding = "utf-8"
    return resp

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(BASE_DIR, "public")  # Vercel 정적 자산 기본 디렉토리

def _load_env():
    env_path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

_load_env()
NAVER_CLIENT_ID = os.environ.get("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.environ.get("NAVER_CLIENT_SECRET", "")

# 카테고리별 고정 종목
FIXED_CATEGORIES = {
    "반도체": [
        {"code": "005930", "name": "삼성전자"}, {"code": "000660", "name": "SK하이닉스"},
        {"code": "000990", "name": "DB하이텍"}, {"code": "067310", "name": "하나마이크론"},
        {"code": "058470", "name": "리노공업"}, {"code": "095610", "name": "테스"},
    ],
    "로봇": [
        {"code": "454910", "name": "두산로보틱스"}, {"code": "277810", "name": "레인보우로보틱스"},
        {"code": "090360", "name": "로보스타"}, {"code": "348340", "name": "뉴로메카"},
        {"code": "117730", "name": "티로보틱스"}, {"code": "056080", "name": "유진로봇"},
    ],
    "2차전지": [
        {"code": "373220", "name": "LG에너지솔루션"}, {"code": "003670", "name": "포스코퓨처엠"},
        {"code": "247540", "name": "에코프로비엠"}, {"code": "066970", "name": "엘앤에프"},
        {"code": "006400", "name": "삼성SDI"}, {"code": "361610", "name": "SK아이이테크놀로지"},
    ],
    "바이오": [
        {"code": "207940", "name": "삼성바이오로직스"}, {"code": "068270", "name": "셀트리온"},
        {"code": "091990", "name": "셀트리온헬스케어"}, {"code": "326030", "name": "SK바이오팜"},
        {"code": "196170", "name": "알테오젠"}, {"code": "028300", "name": "HLB"},
    ],
    "ETF": [
        {"code": "069500", "name": "KODEX 200"}, {"code": "092230", "name": "TIGER 200"},
        {"code": "229200", "name": "KODEX 코스닥150"}, {"code": "360750", "name": "TIGER 미국S&P500"},
        {"code": "509220", "name": "ACE 미국빅테크TOP7"}, {"code": "379780", "name": "KODEX 배당성장"},
    ],
}

ALL_FIXED_CODES = set()
for cat in FIXED_CATEGORIES.values():
    for s in cat:
        ALL_FIXED_CODES.add(s["code"])

# ============================================================
# 실시간 가격 조회
# ============================================================
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch_live_prices(codes):
    """네이버 item/main 페이지에서 가격 스크래핑 (병렬 처리)"""
    def fetch_one(code):
        try:
            url = f"https://finance.naver.com/item/main.naver?code={code}"
            resp = requests.get(url, headers=HEADERS, timeout=8)
            _decode_resp(resp)
            soup = BeautifulSoup(resp.text, "lxml")

            today = soup.select_one("p.no_today span.blind")
            price = today.get_text(strip=True).replace(",", "") if today else "0"
            
            change_span = soup.select_one("p.no_exday span.blind")
            change = "0"
            if change_span:
                cr = change_span.get_text(strip=True)
                nums = re.findall(r"[+-]?[\d,]+", cr)
                if nums:
                    c = nums[0].replace(",", "")
                    if "하락" in cr: c = f"-{c}"
                    elif "상승" in cr: c = f"+{c}"
                    change = c
            
            return code, {"price": price, "change": change}
        except Exception:
            return code, {"price": "0", "change": "0"}
    
    prices = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_one, code): code for code in codes}
        for future in as_completed(futures):
            code, result = future.result()
            prices[code] = result
    print(f"   → {len(prices)}개 가격 조회 완료")
    return prices

# ============================================================
# 인기 종목 50개 수집
# ============================================================
def fetch_popular_stocks_full():
    url = "https://finance.naver.com/sise/lastsearch2.naver"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        _decode_resp(resp)
        soup = BeautifulSoup(resp.text, "lxml")
        stock_links = []
        for a in soup.select("a[href*='code=']"):
            href = a.get("href", "")
            m = re.search(r"code=(\d+)", href)
            if m:
                code = m.group(1)
                name = a.get_text(strip=True)
                if name and len(name) > 1:
                    stock_links.append({"code": code, "name": name})
        seen = set()
        unique = []
        for s in stock_links:
            if s["code"] not in seen:
                seen.add(s["code"])
                s["popularity_rank"] = len(unique) + 1
                unique.append(s)
        top50 = unique[:50]
        print(f"   → {len(top50)}개 종목 코드 수집")
        prices = fetch_live_prices([s["code"] for s in top50])
        result = []
        for s in top50:
            pi = prices.get(s["code"], {})
            result.append({
                "name": s["name"], "code": s["code"],
                "price": pi.get("price", "0"), "change": pi.get("change", "0"),
                "popularity_rank": s["popularity_rank"]
            })
        return result
    except Exception as e:
        print(f"[ERROR] 인기 종목 수집 실패: {e}")
        return []

# ============================================================
# 고정 종목 가격
# ============================================================
def fetch_fixed_stocks_prices():
    prices = fetch_live_prices(list(ALL_FIXED_CODES))
    categories = {}
    for cat_name, stocks in FIXED_CATEGORIES.items():
        cat_stocks = []
        for s in stocks:
            pi = prices.get(s["code"], {})
            cat_stocks.append({
                "name": s["name"], "code": s["code"],
                "price": pi.get("price", "0"), "change": pi.get("change", "0"),
                "category": cat_name
            })
        categories[cat_name] = cat_stocks
    print(f"   → {sum(len(v) for v in categories.values())}개 고정 종목 조회 완료")
    return categories

# ============================================================
# 뉴스 수집 - 네이버 검색 Open API
# ============================================================
NEWS_KEYWORDS = [
    "코스피", "코스닥", "증시", "주식시장", "실적", "공시",
    "반도체", "2차전지", "바이오", "로봇", "ETF",
]

_TAG_RE = re.compile(r"<[^>]+>")

def _strip_html(text):
    return html.unescape(_TAG_RE.sub("", text or "")).strip()

def fetch_news():
    """네이버 검색 Open API로 키워드별 최신 뉴스 수집"""
    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        print("[ERROR] .env에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET이 없습니다")
        return []

    api_url = "https://openapi.naver.com/v1/search/news.json"
    headers = {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    }

    news_list = []
    seen_titles = set()
    seen_links = set()

    for kw in NEWS_KEYWORDS:
        try:
            resp = requests.get(
                api_url, headers=headers, timeout=10,
                params={"query": kw, "display": 100, "sort": "date"},
            )
            if resp.status_code != 200:
                print(f"   [WARN] [{kw}] API 오류 {resp.status_code}: {resp.text[:120]}")
                continue
            items = resp.json().get("items", [])
            collected = 0
            for item in items:
                title = _strip_html(item.get("title", ""))
                if len(title) < 5 or title in seen_titles:
                    continue
                link = item.get("originallink") or item.get("link", "")
                if link and link in seen_links:
                    continue
                seen_titles.add(title)
                if link:
                    seen_links.add(link)
                news_list.append({
                    "title": title,
                    "link": link,
                    "summary": _strip_html(item.get("description", "")),
                    "related_stocks": [],
                    "source": "네이버 뉴스",
                    "pubDate": item.get("pubDate", ""),
                    "matched_keyword": kw,
                })
                collected += 1
            print(f"   [{kw}] {collected}개 수집")
            time.sleep(0.1)
        except Exception as e:
            print(f"   [WARN] [{kw}] 수집 실패: {e}")

    print(f"   → 총 {len(news_list)}개 뉴스 수집 완료")
    return news_list

# ============================================================
# 뉴스-종목 매칭
# ============================================================
def match_news_with_stocks(news_list, popular_stocks, category_stocks):
    known_stocks = {}
    for s in popular_stocks:
        known_stocks[s["code"]] = s["name"]
    for stocks in category_stocks.values():
        for s in stocks:
            if s["code"] not in known_stocks:
                known_stocks[s["code"]] = s["name"]
    
    # 뉴스에서 언급된 모든 종목 코드 수집
    all_mentioned = set()
    for news in news_list:
        for code in news["related_stocks"]:
            all_mentioned.add(code)
    
    # 알려지지 않은 종목명 조회
    unknown = all_mentioned - set(known_stocks.keys())
    if unknown:
        print(f"   [매칭] 알려지지 않은 종목 {len(unknown)}개 조회 중...")
        for code in list(unknown)[:30]:
            try:
                url = f"https://finance.naver.com/item/main.naver?code={code}"
                r = requests.get(url, headers=HEADERS, timeout=5)
                _decode_resp(r)
                s = BeautifulSoup(r.text, "lxml")
                name_tag = s.select_one("h2 a")
                if name_tag:
                    known_stocks[code] = name_tag.get_text(strip=True)
            except Exception:
                pass
            time.sleep(0.15)
    
    # 매칭
    for news in news_list:
        matched = []
        matched_names = set()

        for code in news["related_stocks"]:
            if code in known_stocks:
                name = known_stocks[code]
                if name not in matched_names:
                    matched.append({"code": code, "name": name})
                    matched_names.add(name)

        text = news["title"] + " " + news["summary"]
        text_lower = text.lower()
        for code, name in known_stocks.items():
            if name in matched_names or len(name) < 2:
                continue
            name_lower = name.lower()
            if len(name) <= 2:
                # 2글자 이하 종목명은 단어 경계 매칭 (한글/영문/숫자가 앞뒤로 붙으면 제외)
                pattern = r'(?<![가-힣A-Za-z0-9])' + re.escape(name_lower) + r'(?![가-힣A-Za-z0-9])'
                if not re.search(pattern, text_lower):
                    continue
            else:
                if name_lower not in text_lower:
                    continue
            matched.append({"code": code, "name": name})
            matched_names.add(name)

        news["matched_stocks"] = matched

    return news_list, known_stocks

# ============================================================
# TOP 50 점수 계산
# ============================================================
RANK_SCORE_MAX = 50
NEWS_SCORE_PER_ARTICLE = 15

def score_stocks(popular_stocks, news_list, all_known_stocks=None):
    """인기 1등=50점, 50등=1점, 뉴스 1건당 15점.
    인기 검색은 페이지당 30개라 한계 → 뉴스 매칭 ≥2건 종목으로 50개까지 보충."""
    stock_scores = {}
    for stock in popular_stocks:
        rank = stock["popularity_rank"]
        rank_score = max(1, RANK_SCORE_MAX + 1 - rank) if rank <= RANK_SCORE_MAX else 1
        stock_scores[stock["code"]] = {
            **stock,
            "rank_score": rank_score,
            "news_count": 0,
            "news_score": 0,
            "total_score": rank_score,
        }

    # 전체 뉴스 매칭 카운트
    news_match_count = {}
    for news in news_list:
        for ms in news["matched_stocks"]:
            news_match_count[ms["code"]] = news_match_count.get(ms["code"], 0) + 1

    # 인기 종목 점수 갱신
    for code, cnt in news_match_count.items():
        if code in stock_scores:
            stock_scores[code]["news_count"] = cnt
            stock_scores[code]["news_score"] = cnt * NEWS_SCORE_PER_ARTICLE

    # 인기 외 종목 보충 (뉴스 매칭 ≥ 2건만)
    name_map = all_known_stocks or {}
    for code, cnt in news_match_count.items():
        if code in stock_scores or cnt < 2:
            continue
        stock_scores[code] = {
            "code": code,
            "name": name_map.get(code, ""),
            "popularity_rank": 99,
            "rank_score": 0,
            "news_count": cnt,
            "news_score": cnt * NEWS_SCORE_PER_ARTICLE,
            "total_score": cnt * NEWS_SCORE_PER_ARTICLE,
            "price": "0",
            "change": "0",
        }

    for s in stock_scores.values():
        s["total_score"] = s["rank_score"] + s["news_score"]

    ranked = sorted(stock_scores.values(), key=lambda x: x["total_score"], reverse=True)
    for i, s in enumerate(ranked):
        s["final_rank"] = i + 1
    return ranked[:50]

# ============================================================
# 수급 데이터 (외국인·기관·개인 일별 순매수) - 모바일 API
# ============================================================
def fetch_daily_prices_60d(code):
    """모바일 API로 60일 일별 시세 받기.
    반환: [{date, close, open, high, low, volume}, ...] 최신 → 과거"""
    url = f"https://m.stock.naver.com/api/stock/{code}/price?pageSize=60"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=8)
        resp.raise_for_status()
        items = resp.json()
        if not isinstance(items, list):
            return []
        def _p(s):
            try:
                return int(str(s).replace(",", "").strip())
            except (TypeError, ValueError):
                try:
                    return float(str(s).replace(",", "").strip())
                except (TypeError, ValueError):
                    return 0
        out = []
        for d in items:
            out.append({
                "date": d.get("localTradedAt", ""),
                "close": _p(d.get("closePrice", 0)),
                "open": _p(d.get("openPrice", 0)),
                "high": _p(d.get("highPrice", 0)),
                "low": _p(d.get("lowPrice", 0)),
                "volume": _p(d.get("accumulatedTradingVolume", 0)),
            })
        return out
    except Exception:
        return []


def fetch_flow_for_pool(pool_codes_names):
    """추적 종목 풀에 대해 일자별 수급 데이터를 일괄 수집.
    pool_codes_names: [{code, name}, ...]
    반환: {
        "by_code": {code: {name, days: [...]}},  # 종목별 5일 수급
        "foreign_top": [{code, name, foreign_net, close, change}, ...],  # 외국인 순매수 TOP 30
        "organ_top": [...],   # 기관 순매수 TOP 30
        "both_top": [...],    # 외국인+기관 동반 매수 TOP 30
        "foreign_sell": [...], # 외국인 순매도 TOP (음수)
        "as_of": "2026-05-12"
    }
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def fetch_one(code, name):
        url = f"https://m.stock.naver.com/api/stock/{code}/integration"
        try:
            resp = requests.get(url, headers=HEADERS, timeout=8)
            resp.raise_for_status()
            j = resp.json()
            deals = j.get("dealTrendInfos") or []
            days = []
            for d in deals:
                bd = d.get("bizdate", "")
                date_fmt = f"{bd[:4]}-{bd[4:6]}-{bd[6:8]}" if len(bd) == 8 else bd

                def _p(s):
                    try:
                        return int(str(s).replace(",", "").replace(" ", "").strip())
                    except (TypeError, ValueError):
                        return 0

                change = _p(d.get("compareToPreviousClosePrice", "0"))
                direction = (d.get("compareToPreviousPrice") or {}).get("name", "")
                if direction == "FALLING" and change > 0:
                    change = -change
                days.append({
                    "date": date_fmt,
                    "close": _p(d.get("closePrice", "0")),
                    "change": change,
                    "foreign_net": _p(d.get("foreignerPureBuyQuant", "0")),
                    "organ_net": _p(d.get("organPureBuyQuant", "0")),
                    "individual_net": _p(d.get("individualPureBuyQuant", "0")),
                    "foreign_hold_ratio": d.get("foreignerHoldRatio", ""),
                    "volume": _p(d.get("accumulatedTradingVolume", "0")),
                })
            # 60일 일별 시세도 함께 수집 (기술적 지표 계산용)
            prices_60d = fetch_daily_prices_60d(code)
            return code, {"name": j.get("stockName", name), "days": days, "prices_60d": prices_60d}
        except Exception:
            return code, None

    by_code = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(fetch_one, item["code"], item["name"]): item for item in pool_codes_names}
        for fut in as_completed(futures):
            code, result = fut.result()
            if result:
                by_code[code] = result
    avg_prices = sum(len(v.get("prices_60d", [])) for v in by_code.values()) / max(len(by_code), 1)
    print(f"   → {len(by_code)}/{len(pool_codes_names)}개 수급+시세 수집 (평균 {avg_prices:.0f}일 시세)")

    # 최근 일자(첫 행) 기준 정렬
    rows = []
    for code, info in by_code.items():
        if not info["days"]:
            continue
        today = info["days"][0]
        rows.append({
            "code": code,
            "name": info["name"],
            "close": today["close"],
            "change": today["change"],
            "foreign_net": today["foreign_net"],
            "organ_net": today["organ_net"],
            "individual_net": today["individual_net"],
            "foreign_hold_ratio": today["foreign_hold_ratio"],
        })

    as_of = ""
    for info in by_code.values():
        if info["days"]:
            as_of = info["days"][0]["date"]
            break

    foreign_top = sorted([r for r in rows if r["foreign_net"] > 0], key=lambda x: x["foreign_net"], reverse=True)[:30]
    organ_top = sorted([r for r in rows if r["organ_net"] > 0], key=lambda x: x["organ_net"], reverse=True)[:30]
    individual_top = sorted([r for r in rows if r["individual_net"] > 0], key=lambda x: x["individual_net"], reverse=True)[:30]
    foreign_sell = sorted([r for r in rows if r["foreign_net"] < 0], key=lambda x: x["foreign_net"])[:20]
    organ_sell = sorted([r for r in rows if r["organ_net"] < 0], key=lambda x: x["organ_net"])[:20]
    individual_sell = sorted([r for r in rows if r["individual_net"] < 0], key=lambda x: x["individual_net"])[:20]
    both_top = sorted(
        [r for r in rows if r["foreign_net"] > 0 and r["organ_net"] > 0],
        key=lambda x: x["foreign_net"] + x["organ_net"], reverse=True,
    )[:30]

    return {
        "by_code": by_code,
        "as_of": as_of,
        "foreign_top": foreign_top,
        "organ_top": organ_top,
        "individual_top": individual_top,
        "foreign_sell": foreign_sell,
        "organ_sell": organ_sell,
        "individual_sell": individual_sell,
        "both_top": both_top,
    }


# ============================================================
# 종목 마스터 (KOSPI/KOSDAQ 전체) - 네이버 시가총액 페이지네이션
# ============================================================
def fetch_industry_map():
    """네이버 업종 그룹 페이지에서 종목 → 업종명 매핑 수집.
    반환: {code: industry_name} (예: '005930': '반도체와반도체장비')"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    # 업종 목록 받기
    list_url = "https://finance.naver.com/sise/sise_group.naver?type=upjong"
    try:
        resp = requests.get(list_url, headers=HEADERS, timeout=10)
        _decode_resp(resp)
        soup = BeautifulSoup(resp.text, "lxml")
    except Exception as e:
        print(f"   [WARN] 업종 목록 조회 실패: {e}")
        return {}

    groups = []
    seen_no = set()
    for a in soup.select("a[href*='sise_group_detail']"):
        href = a.get("href", "")
        m = re.search(r"no=(\d+)", href)
        if not m:
            continue
        no = m.group(1)
        if no in seen_no:
            continue
        seen_no.add(no)
        name = a.get_text(strip=True)
        if name and len(name) >= 2:
            groups.append({"no": no, "name": name})

    code_to_industry = {}

    def fetch_group(g):
        url = f"https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no={g['no']}"
        try:
            r = requests.get(url, headers=HEADERS, timeout=10)
            _decode_resp(r)
            s = BeautifulSoup(r.text, "lxml")
            local = {}
            for a in s.select("a[href*='code=']"):
                href = a.get("href", "")
                m = re.search(r"code=(\d{6})", href)
                if m and a.get_text(strip=True):
                    local[m.group(1)] = g["name"]
            return local
        except Exception:
            return {}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(fetch_group, g) for g in groups]
        for fut in as_completed(futures):
            code_to_industry.update(fut.result())

    print(f"   [업종] {len(groups)}개 업종, {len(code_to_industry)}개 종목 매핑")
    return code_to_industry


def fetch_stock_master():
    """네이버 시가총액 페이지를 순회해 KOSPI/KOSDAQ 전체 종목 코드/이름 수집"""
    markets = [("0", "KOSPI"), ("1", "KOSDAQ")]
    out = {}  # code → {code, name, market}

    def fetch_market(sosok, market_name):
        page = 1
        empty_streak = 0
        while page <= 60:  # 안전 상한
            url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page={page}"
            try:
                resp = requests.get(url, headers=HEADERS, timeout=10)
                _decode_resp(resp)
                soup = BeautifulSoup(resp.text, "lxml")
            except Exception as e:
                print(f"   [WARN] {market_name} p{page} 실패: {e}")
                break

            found_in_page = 0
            for a in soup.select("table.type_2 a.tltle"):
                href = a.get("href", "")
                m = re.search(r"code=(\d{6})", href)
                if not m:
                    continue
                code = m.group(1)
                name = a.get_text(strip=True)
                if code and name and code not in out:
                    out[code] = {"code": code, "name": name, "market": market_name}
                    found_in_page += 1

            if found_in_page == 0:
                empty_streak += 1
                if empty_streak >= 2:
                    break
            else:
                empty_streak = 0
            page += 1
            time.sleep(0.15)
        return page - 1

    for sosok, market_name in markets:
        last_page = fetch_market(sosok, market_name)
        print(f"   [{market_name}] {sum(1 for v in out.values() if v['market']==market_name)}개 (page {last_page}까지)")

    stocks = list(out.values())
    if not stocks:
        existing = os.path.join(SITE_DIR, "stocks.json")
        if os.path.exists(existing):
            print("   [WARN] 종목 마스터 수집 실패 — 기존 stocks.json 유지")
            return None
        return []

    # 업종 매핑 (각 종목에 industry 필드 추가)
    industry_map = fetch_industry_map()
    for s in stocks:
        s["industry"] = industry_map.get(s["code"], "")

    path = os.path.join(SITE_DIR, "stocks.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stocks, f, ensure_ascii=False)
    print(f"   → 총 {len(stocks)}개 저장: {path} (업종 {sum(1 for s in stocks if s['industry'])}개 매핑됨)")
    return stocks


# ============================================================
# 뉴스 호재/악재 감성 분석 (휴리스틱)
# ============================================================
POSITIVE_KEYWORDS = [
    # 가격/시세
    "신고가", "사상최고", "사상 최고", "최고가", "신고치", "최대치", "신기록",
    "상승", "급등", "강세", "반등", "급반등", "돌파", "회복", "오름세",
    # 실적
    "흑자", "흑자전환", "호조", "호실적", "실적개선", "어닝서프라이즈", "어닝 서프라이즈",
    "매출 증가", "영업이익 증가", "이익 증가", "성장", "확대", "확장",
    # 사업
    "수주", "신제품", "신기술", "출시", "런칭", "런치", "진출", "합병", "인수",
    "제휴", "협력", "파트너십", "체결", "공급계약", "공급 계약",
    # 평가/추천
    "매수의견", "매수 의견", "매수 추천", "추천", "호평", "긍정적", "낙관",
    "목표가 상향", "목표주가 상향", "상향조정", "투자의견 상향",
    # 일반
    "호재", "기대감", "수혜", "수익", "성공", "쾌거", "도약", "선전",
]

NEGATIVE_KEYWORDS = [
    # 가격/시세
    "하락", "급락", "약세", "급반락", "내림세", "최저가", "신저가",
    # 실적
    "적자", "적자전환", "부진", "실적 부진", "어닝쇼크", "어닝 쇼크",
    "매출 감소", "영업손실", "손실", "이익 감소", "감소", "축소",
    # 위기/리스크
    "리스크", "위기", "우려", "부정적", "비관", "불확실", "의혹",
    "논란", "소송", "제재", "조사", "행정처분", "영업정지", "회수", "리콜",
    "해킹", "침해", "구조조정", "감원", "파산", "부도", "워크아웃", "디폴트",
    "거래정지", "상장폐지",
    # 평가
    "매도의견", "매도 의견", "하향조정", "목표가 하향", "목표주가 하향", "투자의견 하향",
    # 일반
    "악재", "쇼크", "충격", "실패", "지연", "중단", "차질", "타격",
]

# 부정문 처리 — 이런 표현이 나오면 호재로 재분류
POSITIVE_NEGATION_PATTERNS = [
    r"우려.{0,4}해소", r"리스크.{0,4}해소", r"리스크.{0,4}완화",
    r"악재.{0,4}해소", r"부진.{0,4}탈출", r"적자.{0,4}탈출",
]


def classify_sentiment(text):
    """뉴스 텍스트(제목+요약)의 호재/악재 분류.
    반환: {sentiment: 'positive'|'negative'|'neutral', score: int, hits: {pos:[], neg:[]}}"""
    if not text:
        return {"sentiment": "neutral", "score": 0, "hits": {"pos": [], "neg": []}}
    t = text

    # 부정문 패턴은 호재로 카운트
    extra_pos = 0
    for pat in POSITIVE_NEGATION_PATTERNS:
        if re.search(pat, t):
            extra_pos += 1

    pos_hits = []
    for kw in POSITIVE_KEYWORDS:
        # 단어 경계: 한글 키워드는 그대로, 영문/숫자는 양쪽 경계
        if kw in t:
            pos_hits.append(kw)

    neg_hits = []
    for kw in NEGATIVE_KEYWORDS:
        if kw in t:
            neg_hits.append(kw)

    # 같은 위치에서 호재/악재가 부분 매칭(예: "악재 해소"에서 "악재"가 잡히지만 부정문으로 호재 처리됨)
    # → 부정문이 잡힌 만큼 악재 점수 차감
    score = len(pos_hits) + extra_pos - len(neg_hits)
    if extra_pos > 0:
        score += extra_pos  # 부정문 호재 가중

    if score >= 2:
        sentiment = "positive"
    elif score <= -2:
        sentiment = "negative"
    else:
        sentiment = "neutral"

    return {
        "sentiment": sentiment,
        "score": score,
        "hits": {"pos": pos_hits[:5], "neg": neg_hits[:5]},
    }


# ============================================================
# 뉴스 키워드별 그룹핑
# ============================================================
def build_news_by_keyword(news_list):
    """뉴스를 matched_keyword로 그룹핑.
    키워드별로: 매칭된 상위 종목(카운트 내림차순) + 뉴스 상위 10건"""
    groups = {}
    for n in news_list:
        kw = n.get("matched_keyword", "")
        if not kw:
            continue
        g = groups.setdefault(kw, {"keyword": kw, "news": [], "stock_counts": {}})
        if len(g["news"]) < 20:
            g["news"].append({
                "title": n.get("title", ""),
                "link": n.get("link", ""),
                "summary": n.get("summary", ""),
                "pubDate": n.get("pubDate", ""),
                "matched_stocks": n.get("matched_stocks", []),
            })
        for ms in n.get("matched_stocks", []):
            key = (ms.get("code"), ms.get("name"))
            g["stock_counts"][key] = g["stock_counts"].get(key, 0) + 1

    result = []
    for kw, g in groups.items():
        ranked_stocks = sorted(
            [{"code": k[0], "name": k[1], "count": v} for k, v in g["stock_counts"].items()],
            key=lambda x: x["count"], reverse=True,
        )[:15]
        result.append({
            "keyword": kw,
            "news_count": len(g["news"]),
            "top_stocks": ranked_stocks,
            "news": g["news"],
        })
    result.sort(key=lambda x: x["news_count"], reverse=True)
    return result


# ============================================================
# 뉴스 매칭 종목별 그룹핑 (news_by_stock)
# ============================================================
def build_news_by_stock(news_list, flow_by_code, name_map, top_n=30):
    """뉴스 매칭 횟수가 많은 종목 순으로 정렬해 시세·수급·뉴스를 묶음.
    반환: [{code, name, news_count, sentiment_pos, sentiment_neg, sentiment_neu,
            price, prev_close, change, change_pct, foreign_net, organ_net, individual_net,
            news:[{title,link,summary,pubDate,matched_keyword,sentiment,sentiment_score}]}]"""
    counts = {}
    news_by = {}
    sent_by = {}
    for n in news_list:
        s_type = n.get("sentiment", "neutral")
        s_score = n.get("sentiment_score", 0)
        for ms in n.get("matched_stocks", []):
            c, nm = ms.get("code"), ms.get("name")
            if not c:
                continue
            counts[c] = counts.get(c, 0) + 1
            if c not in name_map and nm:
                name_map[c] = nm
            news_by.setdefault(c, []).append({
                "title": n.get("title", ""),
                "link": n.get("link", ""),
                "summary": (n.get("summary", "") or "")[:140],
                "pubDate": n.get("pubDate", ""),
                "matched_keyword": n.get("matched_keyword", ""),
                "sentiment": s_type,
                "sentiment_score": s_score,
            })
            agg = sent_by.setdefault(c, {"pos": 0, "neg": 0, "neu": 0, "score_sum": 0})
            if s_type == "positive": agg["pos"] += 1
            elif s_type == "negative": agg["neg"] += 1
            else: agg["neu"] += 1
            agg["score_sum"] += s_score

    ranked = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:top_n]
    result = []
    for code, cnt in ranked:
        flow_info = flow_by_code.get(code) or {}
        days = flow_info.get("days") or []
        today = days[0] if days else {}
        close = today.get("close", 0) or 0
        change = today.get("change", 0) or 0
        prev = close - change if close else 0
        agg = sent_by.get(code, {"pos": 0, "neg": 0, "neu": 0, "score_sum": 0})
        result.append({
            "code": code,
            "name": flow_info.get("name") or name_map.get(code, ""),
            "news_count": cnt,
            "sentiment_pos": agg["pos"],
            "sentiment_neg": agg["neg"],
            "sentiment_neu": agg["neu"],
            "sentiment_score_sum": agg["score_sum"],
            "price": close,
            "prev_close": prev,
            "change": change,
            "change_pct": round(change / prev * 100, 2) if prev else 0.0,
            "foreign_net": today.get("foreign_net", 0),
            "organ_net": today.get("organ_net", 0),
            "individual_net": today.get("individual_net", 0),
            "foreign_hold_ratio": today.get("foreign_hold_ratio", ""),
            "as_of": today.get("date", ""),
            "news": news_by.get(code, [])[:5],
        })
    return result


# ============================================================
# 메인
# ============================================================
def run():
    print("=" * 60)
    print(f"📊 한국 주식 데이터 수집 시작 - {now_kst().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)
    os.makedirs(SITE_DIR, exist_ok=True)

    print("\n[1/6] 종목 마스터(KOSPI/KOSDAQ) 수집 중...")
    fetch_stock_master()

    print("\n[2/6] 인기 검색 종목 수집 중 (네이버 페이지당 최대 30개)...")
    popular_stocks = fetch_popular_stocks_full()

    print("\n[3/6] 카테고리별 고정 종목 가격 조회 중...")
    category_stocks = fetch_fixed_stocks_prices()

    print("\n[4/6] 당일 뉴스 수집 중 (전체 섹션)...")
    news = fetch_news()

    print("\n[5/6] 뉴스-종목 매칭 및 점수 산정 중...")
    news, all_known_stocks = match_news_with_stocks(news, popular_stocks, category_stocks)
    # 각 뉴스에 호재/악재 감성 분류
    pos_cnt = neg_cnt = 0
    for n in news:
        text = (n.get("title", "") + " " + n.get("summary", "")).strip()
        sent = classify_sentiment(text)
        n["sentiment"] = sent["sentiment"]
        n["sentiment_score"] = sent["score"]
        n["sentiment_hits"] = sent["hits"]
        if sent["sentiment"] == "positive": pos_cnt += 1
        elif sent["sentiment"] == "negative": neg_cnt += 1
    print(f"   → 감성 분류: 호재 {pos_cnt}건, 악재 {neg_cnt}건, 중립 {len(news)-pos_cnt-neg_cnt}건")
    top30 = score_stocks(popular_stocks, news, all_known_stocks)
    news_by_keyword = build_news_by_keyword(news)
    print(f"   → TOP 50 선정 완료, 키워드 그룹 {len(news_by_keyword)}개")

    print("\n[6/6] 추적 종목 + 뉴스 매칭 상위 종목 수급 수집 중...")
    flow_pool = []
    seen_codes_flow = set()
    for s in popular_stocks:
        if s["code"] not in seen_codes_flow:
            flow_pool.append({"code": s["code"], "name": s["name"]})
            seen_codes_flow.add(s["code"])
    for cat_list in category_stocks.values():
        for s in cat_list:
            if s["code"] not in seen_codes_flow:
                flow_pool.append({"code": s["code"], "name": s["name"]})
                seen_codes_flow.add(s["code"])
    # 뉴스 매칭 빈도 상위 50개 종목 추가
    news_stock_counts = {}
    for n in news:
        for ms in n.get("matched_stocks", []):
            c = ms.get("code")
            if c:
                news_stock_counts[c] = news_stock_counts.get(c, 0) + 1
    news_top_codes = sorted(news_stock_counts.items(), key=lambda x: x[1], reverse=True)[:50]
    for code, _ in news_top_codes:
        if code not in seen_codes_flow:
            flow_pool.append({"code": code, "name": all_known_stocks.get(code, "")})
            seen_codes_flow.add(code)
    # 시가총액 상위: KOSPI 60 + KOSDAQ 30 (stocks.json은 시총 순서로 저장됨)
    try:
        master_path = os.path.join(SITE_DIR, "stocks.json")
        if os.path.exists(master_path):
            with open(master_path, "r", encoding="utf-8") as f:
                master = json.load(f)
            kospi_top = [s for s in master if s.get("market") == "KOSPI"][:60]
            kosdaq_top = [s for s in master if s.get("market") == "KOSDAQ"][:30]
            added_top = 0
            for s in kospi_top + kosdaq_top:
                if s["code"] not in seen_codes_flow:
                    flow_pool.append({"code": s["code"], "name": s["name"]})
                    seen_codes_flow.add(s["code"])
                    added_top += 1
            print(f"   + 시총 상위 {added_top}개 추가 (KOSPI 60 + KOSDAQ 30 중 신규)")
    except Exception as e:
        print(f"   [WARN] 시총 상위 추가 실패: {e}")
    print(f"   풀 크기: {len(flow_pool)}개 (추적 + 뉴스 매칭 + 시총 상위)")
    flow_data = fetch_flow_for_pool(flow_pool)
    # top30에 종가·등락액·등락률·기준일 enrich
    by_code = flow_data["by_code"]
    for s in top30:
        info = by_code.get(s["code"])
        if info and info.get("days"):
            today = info["days"][0]
            close = today.get("close", 0) or 0
            change_val = today.get("change", 0) or 0
            prev = close - change_val if close else 0
            s["price"] = close
            s["prev_close"] = prev
            s["change"] = change_val
            s["change_pct"] = round(change_val / prev * 100, 2) if prev else 0.0
            s["as_of"] = today.get("date", "")
    news_by_stock = build_news_by_stock(news, by_code, all_known_stocks, top_n=30)
    print(f"   → 뉴스 종목 카드 {len(news_by_stock)}개 생성")

    data = {
        "generated_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "generated_date": now_kst().strftime("%Y-%m-%d"),
        "top_stocks": top30,
        "category_stocks": category_stocks,
        "news": news[:100],
        "news_by_keyword": news_by_keyword,
        "news_by_stock": news_by_stock,
        "all_stocks": [{"code": k, "name": v} for k, v in all_known_stocks.items()],
        "flow": {
            "as_of": flow_data["as_of"],
            "foreign_top": flow_data["foreign_top"],
            "organ_top": flow_data["organ_top"],
            "individual_top": flow_data["individual_top"],
            "foreign_sell": flow_data["foreign_sell"],
            "organ_sell": flow_data["organ_sell"],
            "individual_sell": flow_data["individual_sell"],
            "both_top": flow_data["both_top"],
            "pool_size": len(flow_pool),
            # by_code는 용량이 커서 별도 flow_by_code.json으로 분리 저장
        },
        "summary": {
            "total_stocks": len(popular_stocks),
            "total_news": len(news),
            "known_stocks": len(all_known_stocks)
        }
    }

    path = os.path.join(SITE_DIR, "data.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # 별도 파일로 flow.by_code 저장 (첫 화면 로딩 가속용)
    flow_by_code_path = os.path.join(SITE_DIR, "flow_by_code.json")
    with open(flow_by_code_path, "w", encoding="utf-8") as f:
        json.dump({
            "generated_at": data["generated_at"],
            "by_code": flow_data["by_code"],
        }, f, ensure_ascii=False)

    print(f"\n✅ 데이터 저장 완료: {path}")
    print(f"   + flow_by_code.json 분리 저장 ({len(flow_data['by_code'])}개 종목)")
    print(f"   - 인기 종목: {len(popular_stocks)}개")
    print(f"   - 뉴스: {len(news)}개")
    print(f"   - 인식된 종목: {len(all_known_stocks)}개")

    # ---- SBS Biz 추천 종목 ----
    try:
        from sbs_biz import update as update_sbs_biz
        stocks_path = os.path.join(SITE_DIR, "stocks.json")
        if os.path.exists(stocks_path):
            with open(stocks_path, "r", encoding="utf-8") as f:
                stocks_master_list = json.load(f)
            print()
            update_sbs_biz(stocks_master_list)
        else:
            print("[WARN] stocks.json 없음 — SBS Biz 수집 건너뜀")
    except Exception as e:
        print(f"[WARN] SBS Biz 수집 실패: {e}")

    return data

if __name__ == "__main__":
    run()