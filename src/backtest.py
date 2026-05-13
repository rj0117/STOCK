"""
매수 추천 신호의 사후 성과 측정 (backtest).

데이터:
- public/buy_history.json: 일별 매수 추천 스냅샷 + 그날의 KOSPI/KOSDAQ 종가
- public/flow_by_code.json: 종목별 60일 시세 (prices_60d, 최신→과거)

측정:
- 각 (추천일, 종목)에 대해 +1일 / +5일 / +10일 / "현재" 시점의 수익률
- 같은 구간 KOSPI 수익률
- 알파 = 종목 수익률 - KOSPI 수익률
- horizon별 집계: 신호 수, 평균 알파, 양수 알파 비율(승률), 평균 수익률

출력: public/backtest.json
"""
import json
import os
from datetime import datetime


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _close_at_or_after(prices_60d_sorted_asc, target_date):
    """prices_60d_sorted_asc: 과거→최신 순. target_date 이상인 첫 항목의 close 반환."""
    for p in prices_60d_sorted_asc:
        if p.get("date", "") >= target_date and p.get("close"):
            return p["close"]
    return None


def _kospi_at_or_after(history_by_date, sorted_dates_asc, target_date):
    """오름차순 날짜 리스트에서 target_date 이상인 첫 날의 KOSPI 값."""
    for d in sorted_dates_asc:
        if d >= target_date:
            v = history_by_date[d].get("kospi")
            if v:
                return v, d
    return None, None


def _horizon_date(start_date_str, business_days_offset):
    """추천일에서 정확한 영업일 +N일을 구하기 어려우므로, 캘린더 일 기준 추정.
    실제로는 prices_60d 시계열에서 가장 가까운 종가를 찾는 방식이 더 정확."""
    # 간단 추정: 영업일 N = 캘린더 N + 주말 보정. 1주(5영업)≈7캘린더, 2주(10영업)≈14캘린더
    cal_offset = round(business_days_offset * 7 / 5)
    d = datetime.strptime(start_date_str, "%Y-%m-%d")
    from datetime import timedelta
    return (d + timedelta(days=cal_offset)).strftime("%Y-%m-%d")


def _nth_close_after(prices_60d_sorted_asc, start_date, n):
    """추천일(혹은 그 이후 첫 거래일) 이후 n번째 거래일의 종가.
    n=0이면 추천일 당일/직후 첫 거래일 종가."""
    # 추천일 이상인 인덱스부터
    idx_start = None
    for i, p in enumerate(prices_60d_sorted_asc):
        if p.get("date", "") >= start_date:
            idx_start = i
            break
    if idx_start is None:
        return None, None
    target_idx = idx_start + n
    if target_idx >= len(prices_60d_sorted_asc):
        return None, None
    p = prices_60d_sorted_asc[target_idx]
    return p.get("close"), p.get("date")


def run_backtest(site_dir, by_code=None):
    """매수 추천 사후 성과 측정. public/backtest.json 생성."""
    bh = _read_json(os.path.join(site_dir, "buy_history.json")) or {}
    by_date = bh.get("by_date", {})
    if not by_date:
        print("   → 백테스트: 누적 데이터 없음")
        _write_empty(site_dir)
        return

    if by_code is None:
        fc = _read_json(os.path.join(site_dir, "flow_by_code.json")) or {}
        by_code = fc.get("by_code", {})

    sorted_dates_asc = sorted(by_date.keys())
    horizons = [1, 5, 10]  # 거래일

    # horizon별 결과 집계
    results = {h: {"signals": [], "alphas": [], "rets": [], "wins": 0, "count": 0} for h in horizons}
    # "현재까지" (마지막 가격)
    cum = {"signals": [], "alphas": [], "rets": [], "wins": 0, "count": 0}
    # 종목별 상세 (최근 신호 위주)
    detail = []

    for snap_date in sorted_dates_asc:
        snap = by_date[snap_date]
        kospi_snap = snap.get("kospi")
        stocks = snap.get("stocks", [])
        for s in stocks:
            code = s.get("code")
            name = s.get("name", code)
            base_price = s.get("price") or 0
            if not code or not base_price:
                continue
            info = by_code.get(code)
            if not info or not info.get("prices_60d"):
                continue
            prices_asc = sorted(info["prices_60d"], key=lambda p: p.get("date", ""))

            # horizon별
            row_horizons = {}
            for h in horizons:
                close_h, date_h = _nth_close_after(prices_asc, snap_date, h)
                if not close_h or not kospi_snap:
                    row_horizons[h] = None
                    continue
                ret = (close_h - base_price) / base_price * 100
                # 같은 구간 KOSPI 수익률
                kospi_h, _ = _kospi_at_or_after(by_date, sorted_dates_asc, date_h)
                kospi_ret = ((kospi_h - kospi_snap) / kospi_snap * 100) if kospi_h else None
                alpha = (ret - kospi_ret) if kospi_ret is not None else None
                row_horizons[h] = {"close": close_h, "date": date_h, "ret": round(ret, 2),
                                    "kospi_ret": round(kospi_ret, 2) if kospi_ret is not None else None,
                                    "alpha": round(alpha, 2) if alpha is not None else None}
                results[h]["count"] += 1
                results[h]["rets"].append(ret)
                if alpha is not None:
                    results[h]["alphas"].append(alpha)
                    if alpha > 0:
                        results[h]["wins"] += 1

            # 현재까지 누적
            latest_close = prices_asc[-1]["close"] if prices_asc else None
            latest_date = prices_asc[-1]["date"] if prices_asc else None
            cum_row = None
            if latest_close and latest_date >= snap_date and kospi_snap:
                ret = (latest_close - base_price) / base_price * 100
                kospi_latest, _ = _kospi_at_or_after(by_date, sorted_dates_asc, latest_date)
                kospi_ret = ((kospi_latest - kospi_snap) / kospi_snap * 100) if kospi_latest else None
                alpha = (ret - kospi_ret) if kospi_ret is not None else None
                cum_row = {"close": latest_close, "date": latest_date, "ret": round(ret, 2),
                            "kospi_ret": round(kospi_ret, 2) if kospi_ret is not None else None,
                            "alpha": round(alpha, 2) if alpha is not None else None}
                cum["count"] += 1
                cum["rets"].append(ret)
                if alpha is not None:
                    cum["alphas"].append(alpha)
                    if alpha > 0:
                        cum["wins"] += 1

            detail.append({
                "date": snap_date,
                "code": code,
                "name": name,
                "base_price": base_price,
                "horizons": row_horizons,
                "cumulative": cum_row,
            })

    def _summarize(bucket):
        n = bucket["count"]
        if n == 0:
            return {"count": 0, "avg_ret": None, "avg_alpha": None, "win_rate": None,
                    "best": None, "worst": None}
        avg_ret = sum(bucket["rets"]) / n
        avg_alpha = sum(bucket["alphas"]) / len(bucket["alphas"]) if bucket["alphas"] else None
        win_rate = bucket["wins"] / len(bucket["alphas"]) * 100 if bucket["alphas"] else None
        return {
            "count": n,
            "avg_ret": round(avg_ret, 2),
            "avg_alpha": round(avg_alpha, 2) if avg_alpha is not None else None,
            "win_rate": round(win_rate, 1) if win_rate is not None else None,
            "best": round(max(bucket["rets"]), 2),
            "worst": round(min(bucket["rets"]), 2),
        }

    summary = {
        "by_horizon": {str(h): _summarize(results[h]) for h in horizons},
        "cumulative": _summarize(cum),
        "total_signals": sum(len(by_date[d].get("stocks", [])) for d in sorted_dates_asc),
        "days_with_data": len(sorted_dates_asc),
        "history_range": {
            "from": sorted_dates_asc[0] if sorted_dates_asc else None,
            "to": sorted_dates_asc[-1] if sorted_dates_asc else None,
        },
    }

    # 종목별 상세는 최근 30개만 보존 (용량 절감)
    detail_sorted = sorted(detail, key=lambda x: x["date"], reverse=True)[:200]

    out = {
        "summary": summary,
        "detail": detail_sorted,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_path = os.path.join(site_dir, "backtest.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    # 콘솔 요약
    cum_s = summary["cumulative"]
    if cum_s["count"]:
        print(f"   → 백테스트: 총 {cum_s['count']}건, 평균 수익 {cum_s['avg_ret']}%, "
              f"평균 알파 {cum_s['avg_alpha']}%, 승률 {cum_s['win_rate']}% "
              f"(KOSPI 대비)")
    else:
        print(f"   → 백테스트: 측정 가능한 신호 없음 (아직 데이터 누적 중)")


def _write_empty(site_dir):
    path = os.path.join(site_dir, "backtest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "summary": {"by_horizon": {}, "cumulative": {"count": 0}, "total_signals": 0, "days_with_data": 0},
            "detail": [],
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }, f, ensure_ascii=False)
