"""Upstash LIST 의 어제 KST AI 호출 로그를 archive/ai_results/{YYYY-MM}/{date}.jsonl 로 저장.

- GitHub Actions 매일 KST 02:00 cron 으로 실행
- 어제 KST 날짜 키만 처리 (오늘 키는 아직 LPUSH 중일 수 있음)
- dedup: 기존 파일에 있는 (timestamp, code) 는 건너뜀 (cron 재실행 안전성)
- 처리 완료 후 Upstash 키 DEL (TTL 3일은 안전망)
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_URL = (os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""


def _cmd(cmd_list):
    if not _URL or not _TOKEN:
        return None
    try:
        r = requests.post(
            _URL,
            headers={"Authorization": f"Bearer {_TOKEN}", "Content-Type": "application/json"},
            json=cmd_list,
            timeout=10,
        )
        if r.status_code != 200:
            print(f"[WARN] Upstash {cmd_list[0]} HTTP {r.status_code}: {r.text[:200]}")
            return None
        return r.json().get("result")
    except Exception as e:
        print(f"[WARN] Upstash {cmd_list[0]} 실패: {e}")
        return None


def archive_date(date_str):
    """date_str (YYYY-MM-DD) 의 ai_log:{date} LIST 를 파일로 저장."""
    list_key = f"ai_log:{date_str}"
    items = _cmd(["LRANGE", list_key, "0", "-1"])
    if items is None:
        print(f"[ERROR] {date_str}: Upstash 조회 실패")
        return False
    if not items:
        print(f"[INFO] {date_str}: 로그 없음 (수집된 AI 호출 없음)")
        return True

    out_dir = os.path.join(ROOT, "archive", "ai_results", date_str[:7])
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{date_str}.jsonl")

    # 기존 파일이 있으면 dedup 키 수집 (cron 재실행 안전성)
    existing = set()
    if os.path.exists(out_path):
        with open(out_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    existing.add((rec.get("timestamp"), rec.get("code")))
                except Exception:
                    pass

    # LPUSH 였으니 LIST 의 head 가 최신. 시간순 append 위해 뒤집기
    new_count = 0
    with open(out_path, "a", encoding="utf-8") as f:
        for raw in reversed(items):
            try:
                rec = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                continue
            key = (rec.get("timestamp"), rec.get("code"))
            if key in existing:
                continue
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            existing.add(key)
            new_count += 1

    print(f"[OK] {date_str}: 신규 {new_count}건 / 수신 {len(items)}건 → {out_path}")

    # 키 삭제 (TTL 도 있지만 안전하게)
    if new_count > 0 or (items and len(existing) >= len(items)):
        _cmd(["DEL", list_key])
        print(f"[OK] {list_key} DEL 완료")
    return True


def main():
    if not _URL or not _TOKEN:
        print("[ERROR] UPSTASH_REDIS_REST_URL / TOKEN 환경변수 미설정")
        sys.exit(1)
    # 어제 KST 날짜
    yesterday = (datetime.now(KST) - timedelta(days=1)).strftime("%Y-%m-%d")
    ok = archive_date(yesterday)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
