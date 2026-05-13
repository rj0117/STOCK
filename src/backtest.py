"""
매수 추천 신호의 사후 성과 측정 (backtest).

정직성 보강:
1. Look-ahead bias 제거: 진입가 = 추천일 다음 거래일의 *시가* (현실적으로 살 수 있는 가격)
2. 측정가: horizon n번째 거래일의 *종가*
3. 비정상 변동 격리: 일일 절대 변동 ≥ 25%면 거래정지 복귀/액면분할/상폐 의심 → 측정 제외
4. 중복 신호: 같은 종목 5거래일 내 재추천 → duplicate. unique 기준과 전체 기준 둘 다 산출
5. 거래비용: 0.3%(왕복) 차감 시나리오 별도 표시

데이터:
- public/buy_history.json: 일별 매수 추천 스냅샷 + KOSPI/KOSDAQ 종가
- public/flow_by_code.json: 종목별 60일 시세 (prices_60d: open/high/low/close/date)

출력: public/backtest.json
"""
import json
import os
from datetime import datetime


COOLDOWN_DAYS = 5             # 같은 종목 N거래일 내 재추천은 duplicate
ABNORMAL_DAILY_THRESHOLD = 25  # 일일 절대 변동 % — 이 이상이면 비정상으로 격리
TRADING_COST_PCT = 0.3        # 왕복 거래비용 가정 (매수 0.15% + 매도 0.15%)


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _detect_abnormal(prices_asc):
    """일일 종가 변동률이 ABNORMAL_DAILY_THRESHOLD%를 넘는 날의 인덱스 리스트.
    거래정지 후 복귀, 액면분할, 무상증자 등은 이 임계를 자주 넘김."""
    flagged = []
    for i in range(1, len(prices_asc)):
        prev = prices_asc[i-1].get("close", 0)
        curr = prices_asc[i].get("close", 0)
        if prev > 0 and curr > 0:
            pct = abs((curr - prev) / prev * 100)
            if pct >= ABNORMAL_DAILY_THRESHOLD:
                flagged.append(i)
    return flagged


def _nth_trading_day_after(prices_asc, snap_date, n):
    """추천일 이후 n번째 거래일 entry 반환 (n=0: 추천일 다음 첫 거래일)."""
    idx_start = None
    for i, p in enumerate(prices_asc):
        if p.get("date", "") > snap_date:  # *추천일 이후* (다음 거래일부터)
            idx_start = i
            break
    if idx_start is None:
        return None, None
    target = idx_start + n
    if target >= len(prices_asc):
        return None, None
    return prices_asc[target], target


def _kospi_close_at_or_after(by_date, sorted_dates, target_date):
    for d in sorted_dates:
        if d >= target_date:
            v = by_date[d].get("kospi")
            if v:
                return v, d
    return None, None


def _summarize(rows):
    """rows: list of dict with 'ret' and optionally 'alpha'."""
    n = len(rows)
    if n == 0:
        return {"count": 0, "avg_ret": None, "avg_alpha": None,
                "win_rate": None, "best": None, "worst": None,
                "avg_ret_after_cost": None, "avg_alpha_after_cost": None}
    rets = [r["ret"] for r in rows if r.get("ret") is not None]
    alphas = [r["alpha"] for r in rows if r.get("alpha") is not None]
    avg_ret = sum(rets) / len(rets) if rets else None
    avg_alpha = sum(alphas) / len(alphas) if alphas else None
    win_count = sum(1 for a in alphas if a > 0)
    win_rate = (win_count / len(alphas) * 100) if alphas else None
    return {
        "count": n,
        "avg_ret": round(avg_ret, 2) if avg_ret is not None else None,
        "avg_alpha": round(avg_alpha, 2) if avg_alpha is not None else None,
        "win_rate": round(win_rate, 1) if win_rate is not None else None,
        "best": round(max(rets), 2) if rets else None,
        "worst": round(min(rets), 2) if rets else None,
        # 거래비용 0.3% 왕복 차감 후
        "avg_ret_after_cost": round(avg_ret - TRADING_COST_PCT, 2) if avg_ret is not None else None,
        "avg_alpha_after_cost": round(avg_alpha - TRADING_COST_PCT, 2) if avg_alpha is not None else None,
    }


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

    sorted_dates = sorted(by_date.keys())
    horizons = [1, 5, 10]  # 거래일

    # === 신호 평탄화 + 중복 라벨링 ===
    # (date, code) 신호 리스트 만들고, 같은 code가 직전 COOLDOWN_DAYS 내에 있으면 duplicate
    flat_signals = []  # [{date, code, name, snap_price, kospi_snap}]
    last_seen = {}  # code -> 가장 최근 추천일 (해당 종목 last_signaled date)
    for d in sorted_dates:
        snap = by_date[d]
        kospi = snap.get("kospi")
        for s in snap.get("stocks", []):
            code = s.get("code")
            if not code:
                continue
            prev = last_seen.get(code)
            is_dup = False
            if prev:
                # 영업일 정확 계산 어렵지만 캘린더 7일 = 5영업일 정도로 근사
                # 5영업일 ≈ 7캘린더일 안에 들면 duplicate
                from datetime import datetime as _dt
                d1 = _dt.strptime(d, "%Y-%m-%d")
                d2 = _dt.strptime(prev, "%Y-%m-%d")
                if (d1 - d2).days <= 7:
                    is_dup = True
            last_seen[code] = d
            flat_signals.append({
                "date": d, "code": code, "name": s.get("name", code),
                "snap_price": s.get("price", 0),
                "kospi_snap": kospi,
                "duplicate": is_dup,
            })

    # === horizon별 측정 (현실 모델: 진입가 = 추천일+1 시가, 측정가 = +N거래일 종가) ===
    rows_all = {h: [] for h in horizons}
    rows_unique = {h: [] for h in horizons}
    rows_cum_all = []
    rows_cum_unique = []
    detail = []
    abnormal_count = 0
    skipped_for_unmeasurable = 0

    for sig in flat_signals:
        info = by_code.get(sig["code"])
        if not info or not info.get("prices_60d"):
            skipped_for_unmeasurable += 1
            continue
        prices_asc = sorted(info["prices_60d"], key=lambda p: p.get("date", ""))
        if not prices_asc:
            skipped_for_unmeasurable += 1
            continue

        # 진입 거래일 = 추천일 *이후* 첫 거래일의 *시가*
        entry, entry_idx = _nth_trading_day_after(prices_asc, sig["date"], 0)
        if not entry:
            skipped_for_unmeasurable += 1
            continue
        entry_price = entry.get("open") or entry.get("close")
        if not entry_price:
            skipped_for_unmeasurable += 1
            continue

        # 비정상 변동 격리: 진입일 이후 구간에서 ±25% 일일 변동이 있으면 측정값 신뢰 ↓
        abnormal_idx_set = set(_detect_abnormal(prices_asc))
        had_abnormal_after_entry = any(i > entry_idx for i in abnormal_idx_set)
        if had_abnormal_after_entry:
            abnormal_count += 1

        row_horizons = {}
        for h in horizons:
            # h 거래일 후 종가 (entry_idx 기준)
            target_idx = entry_idx + h
            if target_idx >= len(prices_asc):
                row_horizons[str(h)] = None
                continue
            target = prices_asc[target_idx]
            if not target.get("close"):
                row_horizons[str(h)] = None
                continue
            # 비정상 구간이 entry~target 사이에 있으면 측정 제외
            in_window_abnormal = any(entry_idx < i <= target_idx for i in abnormal_idx_set)
            if in_window_abnormal:
                row_horizons[str(h)] = {"abnormal": True, "date": target["date"]}
                continue
            ret = (target["close"] - entry_price) / entry_price * 100
            # KOSPI 같은 구간
            kospi_h, _ = _kospi_close_at_or_after(by_date, sorted_dates, target["date"])
            alpha = None
            kospi_ret = None
            if kospi_h and sig["kospi_snap"]:
                kospi_ret = (kospi_h - sig["kospi_snap"]) / sig["kospi_snap"] * 100
                alpha = ret - kospi_ret
            row = {
                "date": target["date"],
                "close": target["close"],
                "ret": round(ret, 2),
                "kospi_ret": round(kospi_ret, 2) if kospi_ret is not None else None,
                "alpha": round(alpha, 2) if alpha is not None else None,
            }
            row_horizons[str(h)] = row
            rows_all[h].append({"ret": ret, "alpha": alpha})
            if not sig["duplicate"]:
                rows_unique[h].append({"ret": ret, "alpha": alpha})

        # 누적 (entry 이후 시계열의 마지막)
        latest = prices_asc[-1]
        cum_row = None
        if latest.get("date", "") > sig["date"] and latest.get("close"):
            in_window_abnormal = any(i > entry_idx for i in abnormal_idx_set)
            if in_window_abnormal:
                cum_row = {"abnormal": True, "date": latest["date"]}
            else:
                ret = (latest["close"] - entry_price) / entry_price * 100
                kospi_latest, _ = _kospi_close_at_or_after(by_date, sorted_dates, latest["date"])
                alpha = None; kospi_ret = None
                if kospi_latest and sig["kospi_snap"]:
                    kospi_ret = (kospi_latest - sig["kospi_snap"]) / sig["kospi_snap"] * 100
                    alpha = ret - kospi_ret
                cum_row = {
                    "date": latest["date"],
                    "close": latest["close"],
                    "ret": round(ret, 2),
                    "kospi_ret": round(kospi_ret, 2) if kospi_ret is not None else None,
                    "alpha": round(alpha, 2) if alpha is not None else None,
                }
                rows_cum_all.append({"ret": ret, "alpha": alpha})
                if not sig["duplicate"]:
                    rows_cum_unique.append({"ret": ret, "alpha": alpha})

        detail.append({
            "date": sig["date"],
            "code": sig["code"],
            "name": sig["name"],
            "duplicate": sig["duplicate"],
            "snap_price": sig["snap_price"],
            "entry_price": entry_price,
            "entry_date": entry.get("date"),
            "horizons": row_horizons,
            "cumulative": cum_row,
            "abnormal_in_window": had_abnormal_after_entry,
        })

    by_horizon_all = {str(h): _summarize(rows_all[h]) for h in horizons}
    by_horizon_unique = {str(h): _summarize(rows_unique[h]) for h in horizons}
    cum_all = _summarize(rows_cum_all)
    cum_unique = _summarize(rows_cum_unique)

    summary = {
        "method": {
            "entry": "추천일 다음 거래일 시가 매수 (look-ahead bias 제거)",
            "measure": "horizon = N거래일 후 종가",
            "cost_pct_roundtrip": TRADING_COST_PCT,
            "cooldown_days": COOLDOWN_DAYS,
            "abnormal_daily_threshold_pct": ABNORMAL_DAILY_THRESHOLD,
        },
        "all_signals": {
            "by_horizon": by_horizon_all,
            "cumulative": cum_all,
        },
        "unique_signals": {
            "by_horizon": by_horizon_unique,
            "cumulative": cum_unique,
        },
        "total_raw_signals": len(flat_signals),
        "duplicate_signals": sum(1 for s in flat_signals if s["duplicate"]),
        "unique_signals_count": sum(1 for s in flat_signals if not s["duplicate"]),
        "skipped_unmeasurable": skipped_for_unmeasurable,
        "abnormal_excluded": abnormal_count,
        "days_with_data": len(sorted_dates),
        "history_range": {
            "from": sorted_dates[0] if sorted_dates else None,
            "to": sorted_dates[-1] if sorted_dates else None,
        },
    }

    detail_sorted = sorted(detail, key=lambda x: x["date"], reverse=True)[:200]

    out = {
        "summary": summary,
        "detail": detail_sorted,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_path = os.path.join(site_dir, "backtest.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    # 콘솔 요약 (unique 기준이 가장 정직)
    cu = cum_unique
    if cu["count"]:
        cost_alpha = cu.get("avg_alpha_after_cost")
        print(f"   → 백테스트 (unique, look-ahead 제거):")
        print(f"      총 {cu['count']}건, 평균 수익 {cu['avg_ret']}%, "
              f"평균 알파 {cu['avg_alpha']}%, 비용차감 후 알파 {cost_alpha}%, "
              f"승률 {cu['win_rate']}%")
        if summary["abnormal_excluded"]:
            print(f"      (비정상 변동 격리 {summary['abnormal_excluded']}건, "
                  f"중복 {summary['duplicate_signals']}건, "
                  f"측정 불가 {summary['skipped_unmeasurable']}건)")
    else:
        print(f"   → 백테스트: 측정 가능한 신호 없음 (아직 데이터 누적 중)")


def _write_empty(site_dir):
    path = os.path.join(site_dir, "backtest.json")
    empty_summary = {
        "method": {}, "all_signals": {"by_horizon": {}, "cumulative": {"count": 0}},
        "unique_signals": {"by_horizon": {}, "cumulative": {"count": 0}},
        "total_raw_signals": 0, "duplicate_signals": 0, "unique_signals_count": 0,
        "skipped_unmeasurable": 0, "abnormal_excluded": 0,
        "days_with_data": 0, "history_range": {"from": None, "to": None},
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "summary": empty_summary,
            "detail": [],
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }, f, ensure_ascii=False)
