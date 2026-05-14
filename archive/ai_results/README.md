# archive/ai_results/ — [DEPRECATED]

**2026-05-14 이전** AI 분석 호출 로그 (buy/sell/hold action 스키마).

## 상태
- 🔒 **새 호출은 더 이상 이 폴더에 저장되지 않음**
- 새 호출은 `archive/ai_briefings/` 에 저장 (정보 비서 스키마)
- 기존 로그는 참고용·이력용으로 보존

## 스키마 (옛)
```json
{
  "timestamp": "2026-05-14T08:00:00+0900",
  "code": "005930",
  "name": "삼성전자",
  "input_snapshot": { ... },
  "ai_output": {
    "action": "buy|sell|hold",
    "confidence": 1~10,
    "analysis": "..."
  },
  "model": "...",
  "usage": { ... }
}
```

## 폐기 이유
2026-05-14 AI 기능을 "매매 판단" 에서 "정보 비서/브리핑(매매 권유 없음)" 으로
방향 전환. action 라벨 자체가 매매 권유로 해석될 위험을 제거.
