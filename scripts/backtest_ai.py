"""AI 분석 적중률 백테스트 (2026-05-14 C안 부활 버전).

입력:
- archive/ai_briefings/{YYYY-MM}/{date}.jsonl: 일별 AI 브리핑 호출 로그 (캐시 미스만)
- public/flow_by_code.json: 종목별 60일 시세 (수익률 측정용)
- public/buy_history.json: KOSPI 일별 종가 (벤치마크)

판정 기준 (3단계 그룹핑):
- AI 응답의 overall_verdict.level (buy_strong/buy/neutral/caution/sell/sell_strong) 을
  3그룹으로 묶어서 적중률 계산.
  · buy_group  = buy_strong + buy   → 5거래일 후 +2% 이상 상승 시 적중
  · hold_group = neutral + caution  → 5거래일 후 |Δ| ≤ 2% 시 적중
  · sell_group = sell + sell_strong → 5거래일 후 -2% 이하 하락 시 적중

출력:
- public/backtest_ai.json: 사이트 표시용 (period/group/level 별 집계 + 최근 100건 상세)
- public/ai_stats.json: 종목 상세 페이지의 AI 카드용 (30일 분포 + 적중률)
- archive/backtest_ai/{YYYY-MM-DD}.json: 히스토리 스냅샷
"""
import glob
import json
import os
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HIT_THRESHOLD_PCT = 2.0     # buy/sell 적중 기준 (%). hold 는 |Δ| ≤ 이 값
HORIZONS = [1, 5, 10]       # 거래일
PRIMARY_HORIZON = "5"       # 적중률 산정에 사용하는 horizon
ACCURACY_MIN_SAMPLE = 5     # 표본 부족 임계 (그룹별 < 5건이면 insufficient)
STATS_MIN_TOTAL = 10        # ai_stats 전체 표본 부족 임계

LEVEL_ORDER = ["buy_strong", "buy", "neutral", "caution", "sell", "sell_strong"]

# 6단계 → 3그룹 매핑
LEVEL_TO_GROUP = {
    "buy_strong": "buy",
    "buy": "buy",
    "neutral": "hold",
    "caution": "hold",
    "sell": "sell",
    "sell_strong": "sell",
}


def _extract_level(rec):
    """AI 응답에서 overall_verdict.level 추출. 옛 action 필드도 폴백 (호환성)."""
    ai = rec.get("ai_output") or {}
    ov = ai.get("overall_verdict") or {}
    level = ov.get("level")
    if level in LEVEL_TO_GROUP:
        return level
    # 옛 스키마 폴백 (archive/ai_results/ 호환)
    old_action = ai.get("action")
    if old_action == "buy":
        return "buy"
    if old_action == "sell":
        return "sell"
    if old_action == "hold":
        return "neutral"
    return None


def _load_logs():
    """archive/ai_briefings/ + 옛 archive/ai_results/ 둘 다 로드 (호환성)."""
    patterns = [
        os.path.join(ROOT, "archive", "ai_briefings", "*", "*.jsonl"),
        os.path.join(ROOT, "archive", "ai_results", "*", "*.jsonl"),  # 옛 데이터 호환
    ]
    records = []
    for pattern in patterns:
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


def _judge_hit(group, ret_pct):
    """group: 'buy' | 'hold' | 'sell'. ret_pct: 5거래일 수익률 (%)."""
    if ret_pct is None:
        return None
    if group == "buy":
        return ret_pct >= HIT_THRESHOLD_PCT
    if group == "sell":
        return ret_pct <= -HIT_THRESHOLD_PCT
    if group == "hold":
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


def _build_ai_stats(details, now):
    """public/ai_stats.json 용 통계 (최근 30일, 종목 상세 페이지 AI 카드용)."""
    cutoff_30d = (now - timedelta(days=30)).strftime("%Y-%m-%d")
    rows = [d for d in details if d["timestamp"][:10] >= cutoff_30d]
    total = len(rows)

    if total == 0:
        period_obj = {
            "total_calls": 0,
            "insufficient": True,
            "period_range": None,
            "distribution_by_level": {},
            "distribution_by_group": {},
            "accuracy_5d": None,
        }
    else:
        level_counts = {lvl: 0 for lvl in LEVEL_ORDER}
        group_counts = {"buy": 0, "hold": 0, "sell": 0}
        for r in rows:
            lvl = r.get("level")
            if lvl in level_counts:
                level_counts[lvl] += 1
            grp = r.get("group")
            if grp in group_counts:
                group_counts[grp] += 1

        distribution_by_level = {
            lvl: {"count": c, "pct": round(c / total * 100, 1)}
            for lvl, c in level_counts.items()
        }
        distribution_by_group = {
            grp: {"count": c, "pct": round(c / total * 100, 1)}
            for grp, c in group_counts.items()
        }

        def _acc(group_key, criterion):
            sub = [r for r in rows if r.get("group") == group_key
                   and (r.get("horizons") or {}).get(PRIMARY_HORIZON)]
            n = len(sub)
            correct = sum(1 for r in sub if r["horizons"][PRIMARY_HORIZON].get("hit") is True)
            return {
                "total": n,
                "correct": correct,
                "rate": round(correct / n, 2) if n > 0 else None,
                "criterion": criterion,
                "insufficient": n < ACCURACY_MIN_SAMPLE,
            }

        earliest = min(r["timestamp"][:10] for r in rows)
        try:
            e_date = datetime.strptime(earliest, "%Y-%m-%d")
            measurable_after = (e_date + timedelta(days=7)).strftime("%Y-%m-%d")
        except Exception:
            measurable_after = None

        period_obj = {
            "total_calls": total,
            "insufficient": total < STATS_MIN_TOTAL,
            "period_range": {
                "from": min(r["timestamp"][:10] for r in rows),
                "to": max(r["timestamp"][:10] for r in rows),
            },
            "distribution_by_level": distribution_by_level,
            "distribution_by_group": distribution_by_group,
            "accuracy_5d": {
                "buy_signals":  _acc("buy",  f"+{HIT_THRESHOLD_PCT}% 이상 상승"),
                "hold_signals": _acc("hold", f"변동 ±{HIT_THRESHOLD_PCT}% 이내"),
                "sell_signals": _acc("sell", f"-{HIT_THRESHOLD_PCT}% 이상 하락"),
                "measurable_after": measurable_after,
                "insufficient_sample_threshold": ACCURACY_MIN_SAMPLE,
            },
        }

    return {
        "default_period": "30d",
        "periods": {"30d": period_obj},
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def _write_ai_stats(details, now):
    out = _build_ai_stats(details, now)
    out_path = os.path.join(ROOT, "public", "ai_stats.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    p = out["periods"]["30d"]
    dg = p.get("distribution_by_group", {})
    print(f"[OK] ai_stats.json: {p['total_calls']}건 / 30일 "
          f"(buy {dg.get('buy', {}).get('pct', 0)}% / "
          f"hold {dg.get('hold', {}).get('pct', 0)}% / "
          f"sell {dg.get('sell', {}).get('pct', 0)}%)")


def main():
    records = _load_logs()
    if not records:
        _write_empty()
        print("[INFO] AI 백테스트: archive/ai_briefings 비어있음")
        return

    by_code = _load_flow_by_code()
    kospi_map = _load_kospi_map()
    kospi_dates = sorted(kospi_map.keys())

    details = []
    skipped_no_price = skipped_no_level = 0

    for rec in records:
        ts = rec.get("timestamp", "")
        if "T" not in ts:
            continue
        snap_date = ts.split("T")[0]
        code = rec.get("code")
        snap = rec.get("input_snapshot") or {}
        base_price = snap.get("price_at_call") or 0

        level = _extract_level(rec)
        if level is None:
            skipped_no_level += 1
            continue
        group = LEVEL_TO_GROUP.get(level, "hold")

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
                "hit": _judge_hit(group, ret),
            }

        details.append({
            "timestamp": ts,
            "code": code,
            "name": rec.get("name", ""),
            "level": level,
            "group": group,
            "base_price": base_price,
            "horizons": row_horizons,
        })

    # 집계 — 그룹 단위 + 6단계 raw level 단위
    by_group = {}
    for grp in ["buy", "hold", "sell"]:
        rows = [d for d in details if d["group"] == grp]
        by_group[grp] = {
            "total_signals": len(rows),
            "by_horizon": {h: _summarize(rows, str(h)) for h in HORIZONS},
        }

    by_level = {}
    for lvl in LEVEL_ORDER:
        rows = [d for d in details if d["level"] == lvl]
        by_level[lvl] = {
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
                "level_to_group": LEVEL_TO_GROUP,
                "hit_rule": {
                    "buy":  f"buy_strong+buy   → +{PRIMARY_HORIZON}거래일 후 +{HIT_THRESHOLD_PCT}% 이상 상승 시 적중",
                    "hold": f"neutral+caution  → +{PRIMARY_HORIZON}거래일 후 |Δ| ≤ {HIT_THRESHOLD_PCT}% 시 적중",
                    "sell": f"sell+sell_strong → +{PRIMARY_HORIZON}거래일 후 -{HIT_THRESHOLD_PCT}% 이상 하락 시 적중",
                },
            },
            "total_signals": len(details),
            "skipped_no_price": skipped_no_price,
            "skipped_no_level": skipped_no_level,
            "by_period": by_period,
            "by_group": by_group,
            "by_level": by_level,
        },
        "detail": details_sorted,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    }

    out_path = os.path.join(ROOT, "public", "backtest_ai.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    arch_dir = os.path.join(ROOT, "archive", "backtest_ai")
    os.makedirs(arch_dir, exist_ok=True)
    arch_path = os.path.join(arch_dir, f"{now.strftime('%Y-%m-%d')}.json")
    with open(arch_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"[OK] AI 백테스트 완료: 측정 {len(details)}건 "
          f"(no_price {skipped_no_price}건, no_level {skipped_no_level}건, "
          f"primary horizon +{PRIMARY_HORIZON}일, hit ±{HIT_THRESHOLD_PCT}%)")

    _write_ai_stats(details, now)


def _write_empty():
    now = datetime.now(KST)
    out = {
        "summary": {
            "method": {
                "hit_threshold_pct": HIT_THRESHOLD_PCT,
                "primary_horizon": PRIMARY_HORIZON,
                "horizons": HORIZONS,
                "level_to_group": LEVEL_TO_GROUP,
            },
            "total_signals": 0,
            "skipped_no_price": 0,
            "skipped_no_level": 0,
            "by_period": {}, "by_group": {}, "by_level": {},
        },
        "detail": [],
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_path = os.path.join(ROOT, "public", "backtest_ai.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    _write_ai_stats([], now)


if __name__ == "__main__":
    main()
