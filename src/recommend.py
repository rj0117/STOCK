"""
매수 추천 스냅샷 누적 저장 (buy_history.json).
public/js/app.js의 calcSignal/calcTechnicals/summarizeTechnicals/calcForecast와
동일한 휴리스틱을 Python으로 포팅한 모듈.
"""
import json
import math
import os
from datetime import datetime
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
MAX_DAYS_KEPT = 14  # 슬라이딩 윈도우 한도


# -------- 기술적 지표 ----------------------------------------------------
def calc_technicals(prices_60d):
    """prices_60d: 최신→과거 순. 5일 미만이면 None."""
    if not prices_60d or len(prices_60d) < 5:
        return None
    ordered = list(reversed(prices_60d))  # 과거 → 최신
    closes = [d.get("close", 0) for d in ordered]
    volumes = [d.get("volume", 0) for d in ordered]
    n = len(closes)

    def sma(arr, period, end):
        if end + 1 < period:
            return None
        return sum(arr[end - period + 1: end + 1]) / period

    def sd(arr, period, end, mean):
        if end + 1 < period:
            return None
        s = sum((arr[i] - mean) ** 2 for i in range(end - period + 1, end + 1))
        return math.sqrt(s / period)

    last = n - 1
    ma5 = sma(closes, 5, last)
    ma20 = sma(closes, 20, last)
    ma5_prev = sma(closes, 5, last - 1)
    ma20_prev = sma(closes, 20, last - 1)

    divergence20 = ((closes[last] - ma20) / ma20 * 100) if ma20 else None

    rsi14 = None
    if n >= 15:
        gain_sum = loss_sum = 0
        for i in range(1, 15):
            diff = closes[i] - closes[i - 1]
            if diff > 0:
                gain_sum += diff
            else:
                loss_sum += -diff
        avg_gain = gain_sum / 14
        avg_loss = loss_sum / 14
        for i in range(15, n):
            diff = closes[i] - closes[i - 1]
            g = diff if diff > 0 else 0
            l = -diff if diff < 0 else 0
            avg_gain = (avg_gain * 13 + g) / 14
            avg_loss = (avg_loss * 13 + l) / 14
        if avg_loss == 0:
            rsi14 = 100
        else:
            rs = avg_gain / avg_loss
            rsi14 = 100 - 100 / (1 + rs)

    golden_cross = dead_cross = False
    if None not in (ma5, ma20, ma5_prev, ma20_prev):
        golden_cross = ma5_prev <= ma20_prev and ma5 > ma20
        dead_cross = ma5_prev >= ma20_prev and ma5 < ma20

    low_bounce = False
    if n >= 6:
        ref = closes[max(0, last - 5)]
        if ref > 0 and closes[last - 1] > 0:
            ret5 = (closes[last - 1] - ref) / ref * 100
            ret1 = (closes[last] - closes[last - 1]) / closes[last - 1] * 100
            if ret5 <= -7 and ret1 >= 2:
                low_bounce = True

    return {
        "rsi14": round(rsi14 * 10) / 10 if rsi14 is not None else None,
        "ma5": ma5, "ma20": ma20,
        "divergence20": round(divergence20 * 10) / 10 if divergence20 is not None else None,
        "golden_cross": golden_cross, "dead_cross": dead_cross, "low_bounce": low_bounce,
        "data_length": n,
    }


def summarize_technicals(tech):
    if not tech:
        return None
    buy = sell = 0
    signals = []
    if tech["rsi14"] is not None:
        if tech["rsi14"] <= 30:
            buy += 1; signals.append("RSI 저가권")
        elif tech["rsi14"] >= 70:
            sell += 1; signals.append("RSI 과열")
    if tech["golden_cross"]:
        buy += 1; signals.append("골든크로스")
    if tech["dead_cross"]:
        sell += 1; signals.append("데드크로스")
    if tech["low_bounce"]:
        buy += 1; signals.append("바닥 반등")
    if tech["divergence20"] is not None:
        if tech["divergence20"] <= -10:
            buy += 1; signals.append("평균선 이탈")
        elif tech["divergence20"] >= 15:
            sell += 1; signals.append("단기 과열")

    net = buy - sell
    if net >= 2:
        cls = "signal-strong-buy"; label = "매수 신호 강함"
    elif net == 1:
        cls = "signal-buy"; label = "매수 신호"
    elif net == 0 and buy == 0 and sell == 0:
        cls = "signal-neutral"; label = "중립"
    elif net == 0:
        cls = "signal-caution"; label = "혼조"
    elif net == -1:
        cls = "signal-sell"; label = "매도 신호"
    else:
        cls = "signal-strong-sell"; label = "매도 신호 강함"

    return {"cls": cls, "label": label, "buy_count": buy, "sell_count": sell, "signals": signals}


# -------- 시장 분위기(수급 + 가격 + 뉴스 sentiment) ---------------------------
def calc_signal(flow_days, sentiment=None):
    if not flow_days:
        return {"cls": "signal-na", "label": "데이터 없음", "score": 0, "reasons": []}
    score = 0
    reasons = []
    f_buy = sum(1 for d in flow_days if d.get("foreign_net", 0) > 0)
    o_buy = sum(1 for d in flow_days if d.get("organ_net", 0) > 0)
    both_buy = sum(1 for d in flow_days if d.get("foreign_net", 0) > 0 and d.get("organ_net", 0) > 0)
    both_sell = sum(1 for d in flow_days if d.get("foreign_net", 0) < 0 and d.get("organ_net", 0) < 0)
    f_sell = sum(1 for d in flow_days if d.get("foreign_net", 0) < 0)
    score += both_buy * 3
    score += f_buy * 2
    score += o_buy * 1.5
    score -= both_sell * 3
    score -= f_sell * 1

    today = flow_days[0]
    prev = (today.get("close", 0) or 0) - (today.get("change", 0) or 0)
    today_pct = (today.get("change", 0) / prev * 100) if prev > 0 else 0
    overheat = drop = False
    if today_pct >= 7:
        score -= 2; overheat = True; reasons.append(f"당일 +{today_pct:.1f}% 급등 (차익실현 압력)")
    elif today_pct <= -7:
        score -= 1; drop = True; reasons.append(f"당일 {today_pct:.1f}% 급락 (추세 약화)")

    oldest = (flow_days[-1].get("close", 0) or 0)
    latest = (today.get("close", 0) or 0)
    if oldest > 0 and latest > 0:
        ret5 = (latest - oldest) / oldest * 100
        if ret5 >= 10:
            score += 3; reasons.append(f"5일 +{ret5:.1f}% 강한 상승")
        elif ret5 >= 5:
            score += 2; reasons.append(f"5일 +{ret5:.1f}% 상승")
        elif ret5 <= -10:
            score -= 3; reasons.append(f"5일 {ret5:.1f}% 강한 하락")
        elif ret5 <= -5:
            score -= 2; reasons.append(f"5일 {ret5:.1f}% 하락")

    if sentiment and ((sentiment.get("pos") or 0) > 0 or (sentiment.get("neg") or 0) > 0):
        net = (sentiment.get("pos") or 0) - (sentiment.get("neg") or 0)
        adj = 0
        if net >= 10: adj = 10
        elif net >= 5: adj = 6
        elif net >= 3: adj = 3
        elif net >= 1: adj = 1
        elif net <= -10: adj = -10
        elif net <= -5: adj = -6
        elif net <= -3: adj = -3
        elif net <= -1: adj = -1
        score += adj

    if score >= 18:
        cls = "signal-strong-buy"; label = "강한 매수 우위"
    elif score >= 10:
        cls = "signal-buy"; label = "매수 우위"
    elif score >= 3:
        if overheat:
            cls = "signal-caution"; label = "관망"
        else:
            cls = "signal-weak-buy"; label = "약한 매수세"
    elif score >= -3:
        cls = "signal-neutral"; label = "중립"
    elif score >= -10:
        cls = "signal-sell"; label = "매도 우위"
    else:
        cls = "signal-strong-sell"; label = "강한 매도 우위"
    return {"cls": cls, "label": label, "score": score, "reasons": reasons}


# -------- 통계 신뢰구간 (1·2주) -------------------------------------------
def calc_forecast(prices_60d, current_price, tech=None, earnings_days_away=None):
    """1-2주 신뢰구간 (Historical VaR + GBM 50:50 가중, 모멘텀 보정, RSI mean reversion,
    실적 임박 σ 확장, 신뢰도 등급)."""
    if not prices_60d or len(prices_60d) < 20 or not current_price:
        return None
    ordered = list(reversed(prices_60d))
    returns = []
    for i in range(1, len(ordered)):
        prev = ordered[i - 1].get("close", 0)
        if prev > 0:
            returns.append(math.log(ordered[i].get("close", 0) / prev))
    if len(returns) < 10:
        return None

    base_mean = sum(returns) / len(returns)
    base_sd = math.sqrt(sum((r - base_mean) ** 2 for r in returns) / len(returns))

    # 1) 모멘텀 보정
    mu_adj = base_mean
    if len(returns) >= 5:
        recent_mean = sum(returns[-5:]) / 5
        mu_adj = base_mean * 0.6 + recent_mean * 0.4

    # 2) RSI mean reversion
    rsi = tech.get("rsi14") if tech else None
    if rsi is not None:
        if rsi >= 70:
            mu_adj -= 0.001 * (rsi - 70) / 30
        elif rsi <= 30:
            mu_adj += 0.001 * (30 - rsi) / 30

    # 3) 이벤트 리스크
    sd_adj = base_sd
    if earnings_days_away is not None and 0 <= earnings_days_away <= 7:
        sd_adj = base_sd * 1.5

    # 4) Historical VaR
    sorted_r = sorted(returns)
    def quantile(q):
        idx = q * (len(sorted_r) - 1)
        lo, hi = int(idx), min(int(idx) + 1, len(sorted_r) - 1)
        if lo == hi: return sorted_r[lo]
        return sorted_r[lo] + (sorted_r[hi] - sorted_r[lo]) * (idx - lo)
    r025 = quantile(0.025)
    r975 = quantile(0.975)

    def at(days):
        mu_t = mu_adj * days
        sigma_t = sd_adj * math.sqrt(days)
        low_norm = mu_t - 1.96 * sigma_t
        up_norm = mu_t + 1.96 * sigma_t
        low_hist = (r025 - base_mean) * math.sqrt(days) + mu_t
        up_hist = (r975 - base_mean) * math.sqrt(days) + mu_t
        lower = (low_norm + low_hist) / 2
        upper = (up_norm + up_hist) / 2
        expected = round(current_price * math.exp(mu_t))
        return {
            "expected": expected,
            "lower": round(current_price * math.exp(lower)),
            "upper": round(current_price * math.exp(upper)),
            "ret_pct": round((expected / current_price - 1) * 1000) / 10,
            "lower_pct": round((math.exp(lower) - 1) * 1000) / 10,
            "upper_pct": round((math.exp(upper) - 1) * 1000) / 10,
        }

    # 5) 신뢰도 등급
    grade = "stable"
    warnings = []
    reasons = []
    if len(returns) < 30:
        grade = "limited"
        warnings.append(f"표본 {len(returns)}개 (충분치 않음)")
    half = len(returns) // 2
    if half >= 10:
        r1, r2 = returns[:half], returns[half:]
        m1 = sum(r1) / len(r1); m2 = sum(r2) / len(r2)
        s1 = math.sqrt(sum((r - m1) ** 2 for r in r1) / len(r1))
        s2 = math.sqrt(sum((r - m2) ** 2 for r in r2) / len(r2))
        if s1 > 0:
            ratio = s2 / s1
            if ratio > 1.5 or ratio < 0.67:
                if grade == "stable": grade = "caution"
                warnings.append(f"변동성 변화 {ratio:.2f}× (전반기 → 후반기)")
    if earnings_days_away is not None and 0 <= earnings_days_away <= 7:
        grade = "uncertain"
        warnings.append(f"실적 발표 D-{earnings_days_away} (σ 1.5배 확장)")
    if rsi is not None:
        if rsi >= 75: reasons.append(f"RSI {rsi:.0f} 과열 → 회귀 압력 반영")
        elif rsi <= 25: reasons.append(f"RSI {rsi:.0f} 과매도 → 반등 압력 반영")

    return {
        "oneWeek": at(5),
        "twoWeek": at(10),
        "dailyMeanPct": round(mu_adj * 1000) / 10,
        "dailySdPct": round(sd_adj * 1000) / 10,
        "sampleSize": len(returns),
        "baseMeanPct": round(base_mean * 1000) / 10,
        "baseSdPct": round(base_sd * 1000) / 10,
        "grade": grade,
        "warnings": warnings,
        "reasons": reasons,
        "mu_daily": mu_adj,
        "sigma_daily": sd_adj,
    }


# -------- 매수 추천 스냅샷 누적 -------------------------------------------
BUY_MARKET = {"signal-strong-buy", "signal-buy", "signal-weak-buy"}
BUY_TECH = {"signal-strong-buy", "signal-buy"}


def _sentiment_lookup(news_by_stock):
    lookup = {}
    for s in (news_by_stock or []):
        lookup[s.get("code")] = {
            "pos": s.get("sentiment_pos", 0),
            "neg": s.get("sentiment_neg", 0),
            "neu": s.get("sentiment_neu", 0),
        }
    return lookup


def find_buy_candidates(by_code, news_by_stock=None):
    """data.json의 flow.by_code (실제로는 flow_by_code.json) + news_by_stock으로
    매수 추천 후보 리스트 추출."""
    sentiments = _sentiment_lookup(news_by_stock)
    candidates = []
    for code, info in (by_code or {}).items():
        days = info.get("days") or []
        if not days:
            continue
        sig = calc_signal(days, sentiments.get(code))
        if sig["cls"] not in BUY_MARKET:
            continue
        prices_60d = info.get("prices_60d") or []
        tech = calc_technicals(prices_60d) if len(prices_60d) >= 5 else None
        tech_sum = summarize_technicals(tech)
        if not tech_sum or tech_sum["cls"] not in BUY_TECH:
            continue
        today = days[0]
        current_price = today.get("close") or 0
        forecast = calc_forecast(prices_60d, current_price, tech=tech) if current_price else None
        candidates.append({
            "code": code,
            "name": info.get("name") or code,
            "price": current_price,
            "signal": sig["label"],
            "tech": tech_sum["label"],
            "forecast": forecast,
        })
    return candidates


def update_buy_history(site_dir, by_code, news_by_stock=None, indexes=None):
    """매수 추천 후보를 추출해 public/buy_history.json에 누적.
    같은 날짜는 첫 스냅샷만 보존. 백테스트 비교 기준선용 KOSPI/KOSDAQ 종가도 함께 저장.
    히스토리는 90일로 보존 (백테스트용)."""
    path = os.path.join(site_dir, "buy_history.json")
    history = {"by_date": {}}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                history = json.load(f) or {"by_date": {}}
                if "by_date" not in history:
                    history["by_date"] = {}
        except Exception:
            history = {"by_date": {}}

    now = datetime.now(KST)
    today_key = now.strftime("%Y-%m-%d")
    snapshot_at = now.strftime("%Y-%m-%d %H:%M")

    kospi_val = (indexes or {}).get("KOSPI", {}).get("value") or None
    kosdaq_val = (indexes or {}).get("KOSDAQ", {}).get("value") or None

    if today_key in history["by_date"]:
        # 이미 오늘 스냅샷 있음 → KOSPI 값만 갱신(가능하면 정확한 종가로 갱신)
        existing = history["by_date"][today_key]
        if kospi_val and not existing.get("kospi"):
            existing["kospi"] = kospi_val
        if kosdaq_val and not existing.get("kosdaq"):
            existing["kosdaq"] = kosdaq_val
        kept = len(history["by_date"])
        print(f"   → 오늘({today_key}) 스냅샷이 이미 있어 매수 후보는 유지 (총 {kept}일)")
    else:
        candidates = find_buy_candidates(by_code, news_by_stock)
        history["by_date"][today_key] = {
            "snapshot_at": snapshot_at,
            "kospi": kospi_val,
            "kosdaq": kosdaq_val,
            "stocks": candidates,
        }
        print(f"   → buy_history 저장: {today_key} {len(candidates)}개 매수 후보")

    # 백테스트용으로 90일까지 보존
    KEEP_DAYS = 90
    keys = sorted(history["by_date"].keys(), reverse=True)[:KEEP_DAYS]
    history["by_date"] = {k: history["by_date"][k] for k in keys}

    with open(path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    print(f"   → 누적 {len(keys)}일")
