"""AI 분석 적중률 백테스트.

입력:
- archive/ai_results/*.jsonl: 일별 AI 호출 로그 (캐시 미스만)
- public/flow_by_code.json: 종목별 60일 시세 (수익률 측정용)
- public/buy_history.json: KOSPI 일별 종가 (벤치마크)

측정:
- 각 (호출 timestamp, code, action, confidence) 에 대해 +1/+5/+10거래일 후 종가
- 종목 수익률, KOSPI 수익률, 알파
- 적중 판정:
  · buy  → +5거래일 후 +HIT% 이상 상승
  · sell → +5거래일 후 -HIT% 이하 하락
  · hold → +5거래일 후 |Δ| ≤ HIT% (변동 없음에 가까움)
- action별 / confidence 구간별 / 기간별 (7d / 30d / all) 집계

출력:
- public/backtest_ai.json (사이트 표시용)
- archive/backtest_ai/{YYYY-MM-DD}.json (히스토리 스냅샷)
"""
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HIT_THRESHOLD_PCT = 2.0   # buy/sell 적중 기준 (%). hold 는 |Δ| ≤ 이 값
HORIZONS = [1, 5, 10]     # 거래일
PRIMARY_HORIZON = "5"     # action 적중률 산정에 사용하는 horizon


def _load_logs():
    pattern = os.path.join(ROOT, "archive", "ai_results", "*", "*.jsonl")
    records = []
    for path in sorted(glob.glob(pattern)):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except Exception:
                        pass
        except Exception as e:
            print(f"[WARN] {path} 읽기 실패: {e}")
    return records


def _load_flow_by_code():
    path = os.path.join(ROOT, "public", "flow_by_code.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("by_code", {})
    except Exception:
        return {}


def _load_kospi_map():
    """buy_history.json의 by_date에서 KOSPI 종가만 추출."""
    path = os.path.join(ROOT, "public", "buy_history.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f) or {}
    except Exception:
        return {}
    out = {}
    for date, snap in (d.get("by_date") or {}).items():
        k = snap.get("kospi")
        if k:
            out[date] = k
    return out


def _kospi_at_or_after(kospi_map, sorted_dates, target_date):
    for d in sorted_dates:
        if d >= target_date:
            return kospi_map[d], d
    return None, None


def _nth_close_after(prices_asc, snap_date, n):
    """snap_date 이후 n번째 거래일 entry (n=0 이면 다음 첫 거래일)."""
    idx_start = None
    for i, p in enumerate(prices_asc):
        if p.get("date", "") > snap_date:
            idx_start = i
            break
    if idx_start is None:
        return None
    target = idx_start + n
    if target >= len(prices_asc):
        return None
    return prices_asc[target]


def _judge_hit(action, ret_pct):
    if ret_pct is None:
        return None
    if action == "buy":
        return ret_pct >= HIT_THRESHOLD_PCT
    if action == "sell":
        return ret_pct <= -HIT_THRESHOLD_PCT
    if action == "hold":
        return abs(ret_pct) <= HIT_THRESHOLD_PCT
    return None


def _summarize(rows, horizon_key):
    """rows: detail dict 리스트. horizon_key: '1'/'5'/'10'."""
    rets, alphas = [], []
    hits = total = 0
    for r in rows:
        h = (r.get("horizons") or {}).get(horizon_key)
        if not h:
            continue
        total += 1
        rets.append(h["ret"])
        if h.get("alpha") is not None:
            alphas.append(h["alpha"])
        if h.get("hit") is True:
            hits += 1
    if total == 0:
        return {
            "count": 0, "avg_ret": None, "avg_alpha": None,
            "hit_rate": None, "best": None, "worst": None,
        }
    return {
        "count": total,
        "avg_ret": round(sum(rets) / len(rets), 2),
        "avg_alpha": round(sum(alphas) / len(alphas), 2) if alphas else None,
        "hit_rate": round(hits / total * 100, 1),
        "best": round(max(rets), 2),
        "worst": round(min(rets), 2),
    }


def _confidence_bucket(c):
    try:
        c = int(c)
    except Exception:
        return "1-4"
    if c >= 9: return "9-10"
    if c >= 7: return "7-8"
    if c >= 5: return "5-6"
    return "1-4"


def main():
    records = _load_logs()
    if not records:
        _write_empty()
        print("[INFO] AI 백테스트: archive/ai_results 비어있음")
        return

    by_code = _load_flow_by_code()
    kospi_map = _load_kospi_map()
    kospi_dates = sorted(kospi_map.keys())

    details = []
    skipped_no_price = 0

    for rec in records:
        ts = rec.get("timestamp", "")
        if "T" not in ts:
            continue
        snap_date = ts.split("T")[0]
        code = rec.get("code")
        snap = rec.get("input_snapshot") or {}
        ai = rec.get("ai_output") or {}
        base_price = snap.get("price_at_call") or 0
        action = ai.get("action") or "hold"
        confidence = ai.get("confidence") or 5

        info = by_code.get(code)
        if not info or not info.get("prices_60d") or not base_price:
            skipped_no_price += 1
            continue

        prices_asc = sorted(info["prices_60d"], key=lambda p: p.get("date", ""))
        kospi_snap, _ = _kospi_at_or_after(kospi_map, kospi_dates, snap_date)

        row_horizons = {}
        for h in HORIZONS:
            target = _nth_close_after(prices_asc, snap_date, h - 1)
            if not target or not target.get("close"):
                continue
            close = target["close"]
            ret = (close - base_price) / base_price * 100
            kospi_h, _ = _kospi_at_or_after(kospi_map, kospi_dates, target["date"])
            kospi_ret = None
            alpha = None
            if kospi_h and kospi_snap:
                kospi_ret = (kospi_h - kospi_snap) / kospi_snap * 100
                alpha = ret - kospi_ret
            row_horizons[str(h)] = {
                "date": target["date"],
                "close": close,
                "ret": round(ret, 2),
                "kospi_ret": round(kospi_ret, 2) if kospi_ret is not None else None,
                "alpha": round(alpha, 2) if alpha is not None else None,
                "hit": _judge_hit(action, ret),
            }

        details.append({
            "timestamp": ts,
            "code": code,
            "name": rec.get("name", ""),
            "action": action,
            "confidence": confidence,
            "base_price": base_price,
            "horizons": row_horizons,
        })

    # 집계
    by_action = {}
    for action in ["buy", "sell", "hold"]:
        rows = [d for d in details if d["action"] == action]
        by_action[action] = {
            "total_signals": len(rows),
            "by_horizon": {h: _summarize(rows, str(h)) for h in HORIZONS},
        }

    by_confidence = {}
    for b in ["9-10", "7-8", "5-6", "1-4"]:
        rows = [d for d in details if _confidence_bucket(d["confidence"]) == b]
        by_confidence[b] = {
            "total_signals": len(rows),
            "by_horizon": {h: _summarize(rows, str(h)) for h in HORIZONS},
        }

    now = datetime.now(KST)

    def _filter_recent(rows, days):
        cutoff = (now - timedelta(days=days)).strftime("%Y-%m-%d")
        return [r for r in rows if r["timestamp"][:10] >= cutoff]

    by_period = {
        "all": {
            "total_signals": len(details),
            "by_horizon": {h: _summarize(details, str(h)) for h in HORIZONS},
        },
        "30d": {
            "total_signals": len(_filter_recent(details, 30)),
            "by_horizon": {h: _summarize(_filter_recent(details, 30), str(h)) for h in HORIZONS},
        },
        "7d": {
            "total_signals": len(_filter_recent(details, 7)),
            "by_horizon": {h: _summarize(_filter_recent(details, 7), str(h)) for h in HORIZONS},
        },
    }

    details_sorted = sorted(details, key=lambda d: d["timestamp"], reverse=True)[:100]

    out = {
        "summary": {
            "method": {
                "hit_threshold_pct": HIT_THRESHOLD_PCT,
                "primary_horizon": PRIMARY_HORIZON,
                "horizons": HORIZONS,
                "hit_rule": {
                    "buy": f"+{PRIMARY_HORIZON}거래일 후 +{HIT_THRESHOLD_PCT}% 이상 상승",
                    "sell": f"+{PRIMARY_HORIZON}거래일 후 -{HIT_THRESHOLD_PCT}% 이하 하락",
                    "hold": f"+{PRIMARY_HORIZON}거래일 후 |Δ| ≤ {HIT_THRESHOLD_PCT}%",
                },
            },
            "total_signals": len(details),
            "skipped_no_price": skipped_no_price,
            "by_period": by_period,
            "by_action": by_action,
            "by_confidence": by_confidence,
        },
        "detail": details_sorted,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # 사이트용
    out_path = os.path.join(ROOT, "public", "backtest_ai.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    # 히스토리 보존
    arch_dir = os.path.join(ROOT, "archive", "backtest_ai")
    os.makedirs(arch_dir, exist_ok=True)
    arch_path = os.path.join(arch_dir, f"{now.strftime('%Y-%m-%d')}.json")
    with open(arch_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"[OK] AI 백테스트 완료: 측정 {len(details)}건 "
          f"(skipped {skipped_no_price}건, primary horizon +{PRIMARY_HORIZON}일, "
          f"hit ±{HIT_THRESHOLD_PCT}%)")


def _write_empty():
    out = {
        "summary": {
            "method": {
                "hit_threshold_pct": HIT_THRESHOLD_PCT,
                "primary_horizon": PRIMARY_HORIZON,
                "horizons": HORIZONS,
            },
            "total_signals": 0,
            "skipped_no_price": 0,
            "by_period": {}, "by_action": {}, "by_confidence": {},
        },
        "detail": [],
        "generated_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_path = os.path.join(ROOT, "public", "backtest_ai.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
