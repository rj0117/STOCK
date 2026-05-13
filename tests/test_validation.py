"""
fetch_data.py 의 검증 함수 mock 테스트.

실행:
    python tests/test_validation.py

성공 시: "[ALL PASS] 전체 통과 (N건)" 출력 + exit 0
실패 시: 실패 케이스 출력 + exit 1
"""
import os
import sys
import json
import tempfile
import traceback

# Windows cp949 콘솔에서도 한글/이모지 출력하도록 utf-8 강제
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# src/ 를 path 에 추가
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from fetch_data import (   # noqa: E402
    validate_collected_stocks,
    validate_enriched_change_rates,
    validate_against_previous,
    MIN_STOCKS_REQUIRED,
    PREV_DROP_RATIO_LIMIT,
    PRICE_JUMP_PCT_LIMIT,
    ABNORMAL_JUMP_COUNT_LIMIT,
)


# -------- mock 데이터 빌더 ----------------------------------------------
def _stock(code, name, price, change_pct=1.0):
    return {"code": code, "name": name, "price": price, "change_pct": change_pct}


def _valid_pool(n=20):
    """가격 정상인 종목 n개."""
    return [_stock(f"{i:06d}", f"종목{i}", 1000 + i * 10) for i in range(1, n + 1)]


# -------- 테스트 실행 헬퍼 ---------------------------------------------
PASSED = []
FAILED = []


def _expect(label, fn, expect_error=False, error_substring=None):
    """fn 실행. expect_error=False 면 에러 없어야 통과,
    expect_error=True 면 RuntimeError 발생해야 통과."""
    try:
        fn()
    except RuntimeError as e:
        if expect_error:
            msg = str(e)
            if error_substring and error_substring not in msg:
                FAILED.append(f"{label}: 에러는 났지만 메시지 불일치. expected substring={error_substring!r}, got={msg!r}")
            else:
                PASSED.append(label)
        else:
            FAILED.append(f"{label}: 예상치 못한 RuntimeError: {e}")
    except Exception as e:
        FAILED.append(f"{label}: 예상치 못한 {type(e).__name__}: {e}\n{traceback.format_exc()}")
    else:
        if expect_error:
            FAILED.append(f"{label}: RuntimeError 가 발생해야 하는데 통과함")
        else:
            PASSED.append(label)


# ========== 시나리오 ===================================================

def test_collected_stocks_normal():
    """정상 종목 20개 → 통과"""
    _expect("[V1] 정상 20개 통과",
            lambda: validate_collected_stocks(_valid_pool(20)))


def test_collected_stocks_too_few():
    """5개만 수집 → RuntimeError"""
    _expect("[V1] 5개(부족)면 에러",
            lambda: validate_collected_stocks(_valid_pool(5)),
            expect_error=True, error_substring="최소")


def test_collected_stocks_invalid_prices_excluded():
    """20개 중 5개 가격 0 → 15개 유효, 통과"""
    pool = _valid_pool(20)
    for i in range(5):
        pool[i]["price"] = 0
    _expect("[V1] 가격0 5개 제외 후 15개 통과",
            lambda: validate_collected_stocks(pool))


def test_collected_stocks_all_invalid():
    """모든 가격 0 → 에러"""
    pool = _valid_pool(20)
    for s in pool:
        s["price"] = 0
    _expect("[V1] 모든 가격0이면 에러",
            lambda: validate_collected_stocks(pool),
            expect_error=True, error_substring="유효 종목")


def test_collected_stocks_negative_and_none():
    """음수 가격 + None → 모두 제외"""
    pool = _valid_pool(20)
    pool[0]["price"] = -100
    pool[1]["price"] = None
    pool[2]["price"] = "  "  # 빈 문자열
    pool[3]["price"] = "abc"  # 파싱 실패
    _expect("[V1] 음수/None/문자열 제외 후 16개 통과",
            lambda: validate_collected_stocks(pool))


def test_collected_stocks_string_price():
    """문자열 가격 (콤마 포함) → 정상 파싱"""
    pool = _valid_pool(20)
    pool[0]["price"] = "1,234"
    pool[1]["price"] = "+5,678"
    _expect("[V1] 콤마/+ 포함 문자열 가격 파싱",
            lambda: validate_collected_stocks(pool))


def test_enriched_normal():
    """등락률 다양 → 통과"""
    top = _valid_pool(20)
    for i, s in enumerate(top):
        s["change_pct"] = (-2 + i * 0.5) if i % 2 == 0 else 0  # 일부 0, 일부 변동
    _expect("[V2] 일부만 등락률 있어도 통과",
            lambda: validate_enriched_change_rates(top))


def test_enriched_all_zero():
    """모든 등락률 0% → 에러"""
    top = _valid_pool(20)
    for s in top:
        s["change_pct"] = 0
    _expect("[V2] 모든 등락률 0%면 에러",
            lambda: validate_enriched_change_rates(top),
            expect_error=True, error_substring="0%")


def test_enriched_empty():
    """빈 리스트 → 에러"""
    _expect("[V2] 빈 리스트면 에러",
            lambda: validate_enriched_change_rates([]),
            expect_error=True)


def test_against_previous_no_file():
    """이전 파일 없음 → 검증 스킵 (통과)"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        _expect("[V3] 이전 파일 없으면 스킵",
                lambda: validate_against_previous(_valid_pool(20), path))


def test_against_previous_normal():
    """이전 50개 → 신규 50개, 가격 변동 작음 → 통과"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        prev = {"top_stocks": _valid_pool(50)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prev, f)
        new = _valid_pool(50)
        for s in new:  # 가격 +5% 정도 변동
            s["price"] = int(s["price"] * 1.05)
        _expect("[V3] 정상 50→50, 작은 변동 통과",
                lambda: validate_against_previous(new, path))


def test_against_previous_drop_50pct():
    """이전 50개 → 신규 24개 (52% 감소) → 에러"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        prev = {"top_stocks": _valid_pool(50)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prev, f)
        _expect("[V3] 50→24 (52% 감소) 에러",
                lambda: validate_against_previous(_valid_pool(24), path),
                expect_error=True, error_substring="급감")


def test_against_previous_borderline_drop():
    """이전 50개 → 신규 26개 (48% 감소, 한도 미만) → 통과"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        prev = {"top_stocks": _valid_pool(50)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prev, f)
        _expect("[V3] 50→26 (48% 감소, 한도 미만) 통과",
                lambda: validate_against_previous(_valid_pool(26), path))


def test_against_previous_price_jump():
    """동일 종목 6개 가격이 50%↑ 변동 → 에러"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        prev = {"top_stocks": _valid_pool(20)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prev, f)
        new = _valid_pool(20)
        for i in range(6):  # 6개를 2배로 (100% 변동)
            new[i]["price"] = new[i]["price"] * 2
        _expect("[V3] 가격 50%↑ 변동 6개 에러",
                lambda: validate_against_previous(new, path),
                expect_error=True, error_substring="50%")


def test_against_previous_price_jump_under_limit():
    """동일 종목 4개만 50%↑ 변동 → 통과 (한도 5 미만)"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        prev = {"top_stocks": _valid_pool(20)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prev, f)
        new = _valid_pool(20)
        for i in range(4):
            new[i]["price"] = new[i]["price"] * 2
        _expect("[V3] 가격 50%↑ 변동 4개 통과 (한도 5 미만)",
                lambda: validate_against_previous(new, path))


def test_against_previous_corrupt_file():
    """이전 data.json 깨진 JSON → 검증 스킵 (통과)"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{ not valid json")
        _expect("[V3] 손상된 JSON 이면 스킵",
                lambda: validate_against_previous(_valid_pool(20), path))


def test_constants_present():
    """상수가 import 되는지 + 기대값"""
    assert MIN_STOCKS_REQUIRED == 10, MIN_STOCKS_REQUIRED
    assert PREV_DROP_RATIO_LIMIT == 0.5, PREV_DROP_RATIO_LIMIT
    assert PRICE_JUMP_PCT_LIMIT == 50, PRICE_JUMP_PCT_LIMIT
    assert ABNORMAL_JUMP_COUNT_LIMIT == 5, ABNORMAL_JUMP_COUNT_LIMIT
    PASSED.append("[CONST] 상수 값 점검")


# ========== 실행 =======================================================

def main():
    tests = [
        test_constants_present,
        test_collected_stocks_normal,
        test_collected_stocks_too_few,
        test_collected_stocks_invalid_prices_excluded,
        test_collected_stocks_all_invalid,
        test_collected_stocks_negative_and_none,
        test_collected_stocks_string_price,
        test_enriched_normal,
        test_enriched_all_zero,
        test_enriched_empty,
        test_against_previous_no_file,
        test_against_previous_normal,
        test_against_previous_drop_50pct,
        test_against_previous_borderline_drop,
        test_against_previous_price_jump,
        test_against_previous_price_jump_under_limit,
        test_against_previous_corrupt_file,
    ]
    print("=" * 60)
    print(f"검증 함수 mock 테스트 ({len(tests)}건)")
    print("=" * 60)
    for t in tests:
        try:
            t()
        except Exception as e:
            FAILED.append(f"{t.__name__}: 테스트 실행 자체 실패: {e}")

    print()
    print("-" * 60)
    print(f"통과 {len(PASSED)}건 / 실패 {len(FAILED)}건")
    print("-" * 60)
    for p in PASSED:
        print(f"  [OK]{p}")
    if FAILED:
        print()
        for f in FAILED:
            print(f"  [FAIL]{f}")
        sys.exit(1)
    else:
        print(f"\n[ALL PASS] 전체 통과 ({len(PASSED)}건)")
        sys.exit(0)


if __name__ == "__main__":
    main()
