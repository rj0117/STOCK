# archive/ai_briefings/ — AI 종목 브리핑 로그

**2026-05-14 이후** AI 호출 로그 (정보 비서 스키마, 매매 권유 없음).

## 저장 흐름
1. 사용자가 종목 상세에서 "🤖 정보 받기" 버튼 클릭 (캐시 미스 시만)
2. `api/_lib.py` `get_ai_analysis` 가 Upstash LIST `ai_log:{KST 날짜}` 에 LPUSH
3. 매일 KST 02:00 GitHub Actions cron 이 어제 LIST → 이 폴더의 `{YYYY-MM}/{date}.jsonl` 로 저장

## 스키마 (새)
```json
{
  "timestamp": "2026-05-14T10:30:00+0900",
  "code": "005930",
  "name": "삼성전자",
  "input_snapshot": { ... },        // price/rsi/ma/수급/뉴스/펀더멘털
  "user_position": null | { ... },  // 평단·수량 입력 시
  "ai_output": {
    "current_situation_summary": { headline, key_points },
    "recent_news_summary":       { positive, negative, neutral },
    "fundamental_snapshot":      { per, pbr, roe, ... },
    "technical_snapshot":        { rsi, ma_alignment, ... },
    "market_context":            { kospi, usd_krw, us_market },
    "factors_to_consider":       [...]
  },
  "model": "claude-sonnet-4-6",
  "usage": { input_tokens, output_tokens },
  "cost_krw": ...
}
```

## 옛 폴더와의 관계
- 옛 buy/sell/hold 스키마는 `archive/ai_results/` 에 보존 (deprecated)
- 두 폴더는 스키마가 달라 직접 호환되지 않음
