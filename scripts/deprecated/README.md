# scripts/deprecated/

폐기된 스크립트 보존 폴더. 작업 디렉토리에서 분리해 실수로 재호출되지 않게 함.
git history 외에 폴더로도 보존되어 참고는 가능.

## 파일

### `backtest_ai.py` (2026-05-14 deprecated)
AI 분석 적중률 백테스트.
- 폐기 이유: AI 기능을 "매매 판단(buy/sell/hold)" → "정보 비서/브리핑(매매 권유 없음)" 으로 전환.
  새 출력 스키마엔 action 필드가 없어 적중률 측정 자체 불가.
- 재가동하려면 `scripts/` 로 옮기고 `.github/workflows/archive_ai.yml` 에 step 재추가 필요.
- 옛 호출 로그(`archive/ai_results/`) 는 그대로 보존되어 있어 분석 참고 가능.
