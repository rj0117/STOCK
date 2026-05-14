# SCORING.md — 점수·라벨 시스템 단일 진실의 원천

> 📌 **이 문서의 역할**: 이 프로젝트의 모든 점수·임계값·라벨 기준은 **이 문서가 단일 진실의 원천(single source of truth)** 입니다.
> `README.md`, `public/index.html` 의 details 섹션, 코드 주석 등은 모두 이 문서와 일치해야 합니다.
> 변경 시 *코드 → 이 문서 → README → index.html details* 순서로 동기화하세요. ([.claude/CLAUDE.md §5](.claude/CLAUDE.md) 참조)

**📅 마지막 동기화 일자: 2026-05-14** (overall_verdict 단기 1-2주 종합 평가 부활 — C안)
**🔖 다음 점검 권장 시기:** 점수 로직 변경 시 즉시 / 그 외 월 1회 자율 점검

---

## 시스템 개요

| 시스템 | 역할 | 출력 |
|---|---|---|
| **A. TOP 50 선정** | 어떤 종목 50개를 메인 화면에 노출할지 결정 | 정렬된 종목 리스트 |
| **B. 시장 분위기** | 한 종목의 단기 시장 동향(수급+가격+뉴스) 점수화 | "강한 매수 우위 ~ 강한 매도 우위" 7단계 라벨 |
| **C. 기술 지표** | 60일 시세 기반 기술적 매수/매도 신호 종합 | "매수 신호 강함 ~ 매도 신호 강함" 6단계 라벨 |
| **D. 1·2주 통계 전망** | 변동성·모멘텀·RSI보정·이벤트 리스크 종합 95% 신뢰구간 | 1주/2주 기대 + 범위 + 신뢰도 등급 |
| **E. 매수 참고 필터** | B + C 의 교집합으로 매수 참고 종목 선별 | 매수 참고 신호 메뉴의 종목 리스트 |

---

## §A. TOP 50 선정 점수

**코드 위치:** [src/fetch_data.py:366-421](src/fetch_data.py#L366-L421) `score_stocks`

### 상수

| 이름 | 값 | 위치 | 의미 |
|---|---|---|---|
| `RANK_SCORE_MAX` | **30** | fetch_data.py:366 | 인기 검색 1등이 받는 최대 점수 |
| `NEWS_SCORE_PER_ARTICLE` | **15** | fetch_data.py:367 | 관련 뉴스 1건당 부여 점수 |

### 산식

```
rank_score = max(1, RANK_SCORE_MAX + 1 - popularity_rank)    if rank <= 30
news_score = matched_news_count × NEWS_SCORE_PER_ARTICLE
total_score = rank_score + news_score
```

### 1~30위 선정
- 네이버 인기 검색 페이지(`finance.naver.com/sise/lastsearch2.naver`) 종목을 `popularity_rank` 부여
- 위 산식으로 `total_score` 산출, 내림차순 정렬

### 31~50위 보충
- 1~30위에 안 들어간 종목을 **네이버 거래량 상위(KOSPI + KOSDAQ)** 에서 거래량 순으로 추가
- 점수 = 0 (정렬에 영향 없음, 단순 보충)
- 이유: 인기 검색 페이지가 페이지당 30개 한계라 그 이상 못 받기 때문

---

## §B. 시장 분위기 점수

**코드 위치:**
- Python: [src/recommend.py](src/recommend.py) `calc_signal` (현재 100~190줄 부근)
- JavaScript: [public/js/app.js:1690-1768](public/js/app.js#L1690-L1768) `calcSignal`

두 구현은 **동일 로직**. 변경 시 양쪽 동기화 필수.

### 가산 (매수 우위)

#### 일별 수급 (5일 합산)
| 항목 | 점수 |
|---|---|
| 외인+기관 동반 매수일 × 일수 | **+3 / 일** |
| 외국인 매수일 × 일수 | **+2 / 일** |
| 기관 매수일 × 일수 | **+1.5 / 일** |

#### 5일 가격 추세
| 강도 | 항목 | 점수 |
|---|---|---|
| 강 | 5일 +10% 이상 상승 | **+3** |
| 중 | 5일 +5~10% 상승 | **+2** |

#### 뉴스 호재 net (호재 - 악재)
| 강도 | net 범위 | 점수 |
|---|---|---|
| 강 | net ≥ 10 (압도적) | **+10** |
| 강 | net 5~9 (우세) | **+6** |
| 중 | net 3~4 | **+3** |
| 약 | net 1~2 | **+1** |

### 감산 (매도 우위)

#### 일별 수급 (5일 합산)
| 항목 | 점수 |
|---|---|
| 외인+기관 동반 매도일 × 일수 | **-3 / 일** |
| 외국인 매도일 × 일수 | **-1 / 일** |

#### 5일 가격 추세
| 강도 | 항목 | 점수 |
|---|---|---|
| 강 | 5일 -10% 이상 하락 | **-3** |
| 중 | 5일 -5~-10% 하락 | **-2** |

#### 당일 모멘텀 페널티
| 강도 | 항목 | 점수 | 비고 |
|---|---|---|---|
| 강 | 당일 +7% 이상 급등 (과열) | **-2** | "관망" 라벨 트리거 |
| 중 | 당일 -7% 이상 급락 | **-1** | |

#### 뉴스 악재 net (악재 - 호재)
| 강도 | net 범위 | 점수 |
|---|---|---|
| 강 | net ≤ -10 (압도적) | **-10** |
| 강 | net -5~-9 (우세) | **-6** |
| 중 | net -3~-4 | **-3** |
| 약 | net -1~-2 | **-1** |

### 점수 → 라벨

| 점수 | 라벨 | CSS 클래스 |
|---|---|---|
| ≥ 18 | 강한 매수 우위 | `signal-strong-buy` |
| 10 ~ 17 | 매수 우위 | `signal-buy` |
| 3 ~ 9 | 약한 매수세 | `signal-weak-buy` |
| 3 ~ 9 + 당일 +7%↑ 급등 | **관망** | `signal-caution` |
| -3 ~ 2 | 중립 | `signal-neutral` |
| -10 ~ -4 | 매도 우위 | `signal-sell` |
| ≤ -11 | 강한 매도 우위 | `signal-strong-sell` |

---

## §C. 기술 지표

**코드 위치:**
- Python: [src/recommend.py](src/recommend.py) `calc_technicals` + `summarize_technicals`
- JavaScript: [public/js/app.js:1560-1681](public/js/app.js#L1560-L1681) `calcTechnicals` + [public/js/app.js:385-410](public/js/app.js#L385-L410) `summarizeTechnicals`

### 매수 신호 (각 +1)
| 신호 | 조건 |
|---|---|
| RSI 저가권 | `rsi14 <= 30` |
| 골든크로스 | 5일선이 20일선을 위로 돌파 (`ma5_prev <= ma20_prev && ma5 > ma20`) |
| 바닥 반등 | 최근 5일 ≤ -7% 후 어제 ≥ +2% |
| 평균선 이탈 (회귀 기대) | 20일선 이격도 ≤ -10% |

### 매도 신호 (각 -1)
| 신호 | 조건 |
|---|---|
| RSI 과열 | `rsi14 >= 70` |
| 데드크로스 | 5일선이 20일선을 아래로 이탈 (`ma5_prev >= ma20_prev && ma5 < ma20`) |
| 단기 과열 | 20일선 이격도 ≥ +15% |

### `net = 매수 - 매도` → 라벨

| net | 라벨 | CSS 클래스 |
|---|---|---|
| ≥ 2 | 매수 신호 강함 | `signal-strong-buy` |
| 1 | 매수 신호 | `signal-buy` |
| 0 + 신호 없음 | 중립 | `signal-neutral` |
| 0 + 매수=매도 발생 | 혼조 | `signal-caution` |
| -1 | 매도 신호 | `signal-sell` |
| ≤ -2 | 매도 신호 강함 | `signal-strong-sell` |

---

## §D. 1·2주 통계 전망

**코드 위치:**
- Python: [src/recommend.py](src/recommend.py) `calc_forecast`
- JavaScript: [public/js/app.js:1129-1259](public/js/app.js#L1129-L1259) `calcForecast`
- AI prompt 인라인: [api/_lib.py](api/_lib.py) `_ai_calc_forecast`, [src/api_handlers.py](src/api_handlers.py) `_ai_calc_forecast`

### 기본 통계
- 60일 일별 로그 수익률 → 평균 μ, 표준편차 σ
- 표본 < 20 또는 returns < 10 → `null` 반환

### 보정 단계 (순차 적용)

#### 1. 모멘텀 보정
```
μ_adj = baseMean × 0.6 + recentMean(최근 5일) × 0.4
```

#### 2. RSI mean reversion
```
RSI ≥ 70 → μ_adj -= 0.001 × (rsi - 70) / 30   # 회귀 압력
RSI ≤ 30 → μ_adj += 0.001 × (30 - rsi) / 30   # 반등 압력
```

#### 3. 이벤트 리스크
```
실적 발표 D-7 이내 → σ_adj = baseSd × 1.5
```

#### 4. Historical VaR + 정규모델 50:50 가중
```
lower = (정규모델 lower + Historical VaR lower) / 2
upper = (정규모델 upper + Historical VaR upper) / 2
```

### 신뢰도 등급

| 등급 | 조건 | CSS |
|---|---|---|
| stable (안정) | 표본 ≥ 30 + 변동성 안정 + 이벤트 없음 | `fc-grade-stable` |
| caution (주의) | 전반기/후반기 σ 비율 > 1.5 또는 < 0.67 | `fc-grade-caution` |
| limited (표본 부족) | 표본 < 30 | `fc-grade-limited` |
| uncertain (불확실) | 실적 발표 D-7 이내 (최우선 적용) | `fc-grade-uncertain` |

---

## §E. 매수 참고 필터

**코드 위치:** [public/js/app.js:644-739](public/js/app.js#L644-L739) `renderRecommendBuy`

### 필터 조건
다음 두 조건을 **동시에** 만족하는 종목만 매수 참고 메뉴에 표시:

```
시장 분위기(B) ∈ { 강한 매수 우위, 매수 우위, 약한 매수세 }
                  AND
기술 지표(C)   ∈ { 매수 신호 강함, 매수 신호 }
```

**JS 표현 ([app.js:657-660](public/js/app.js#L657-L660)):**
```javascript
const buyMarket = new Set(["signal-strong-buy", "signal-buy", "signal-weak-buy"]);
const buyTech   = new Set(["signal-strong-buy", "signal-buy"]);
```

### 정렬 순서
```
rankScore = marketRank × 3 + techRank
  marketRank: strong-buy=3, buy=2, weak-buy=1
  techRank:   strong-buy=2, buy=1
```
내림차순 정렬.

---

## §보존/측정 기간

### buy_history.json 슬라이딩 윈도우
**코드 위치:** [src/recommend.py:16](src/recommend.py#L16)
- `KEEP_DAYS = 90` (캘린더일 기준, 거래일 아님)
- 같은 날짜는 첫 스냅샷만 보존 (중복 갱신 방지)

### 백테스트 horizon
**코드 위치:** [src/backtest.py:115](src/backtest.py#L115)
- `horizons = [1, 5, 10]` (거래일)
  - +1거래일 (다음날)
  - +5거래일 (≈1주)
  - +10거래일 (≈2주)
- + 누적 (현재까지)

### 백테스트 정직성 보강 상수
**코드 위치:** [src/backtest.py:14-16](src/backtest.py#L14-L16)

| 이름 | 값 | 의미 |
|---|---|---|
| `COOLDOWN_DAYS` | **5** | 같은 종목 N거래일 내 재발생 신호는 duplicate 라벨링 |
| `ABNORMAL_DAILY_THRESHOLD` | **25** | 일일 절대 변동 N% 이상은 거래정지/액면분할/상폐 의심으로 격리 |
| `TRADING_COST_PCT` | **0.3** | 왕복 거래비용 가정 (매수 0.15% + 매도 0.15%) |

### 평가 라벨 임계값 (백테스트 결과)
**코드 위치:** [public/js/app.js](public/js/app.js) `renderBacktest` 의 verdict 분기

| 라벨 | 조건 |
|---|---|
| 🟢 의미 있는 알파 | 비용 차감 후 평균 알파 > +1.0% **AND** 승률 > 55% |
| 🔴 시장 미달 | 비용 차감 후 평균 알파 < -1.0% **OR** 승률 < 45% |
| ⚪ 시장 수준 | 그 사이 |
| 데이터 부족 | 표본 < 20 |

---

## §데이터 갱신 주기

**코드 위치:** [.github/workflows/update-data.yml](.github/workflows/update-data.yml)

- cron: `7,37 * * * *` (UTC, KST 와 동일)
- 매시 7분 / 37분 (총 일 48회, 30분 간격)
- 비정시 선택: 매시 0/30분은 GitHub Actions 글로벌 부하 시간대라 누락 잦음
- 갱신 파일: `data.json`, `flow_by_code.json`, `sbsbiz.json`, `buy_history.json`, `backtest.json`, `stocks.json`

---

## §AI 종목 브리핑 (2026-05-14 정보 비서로 방향 전환)

**역할 (2026-05-14 두 번째 결정 — C안):**
- 기본 7개 섹션은 정보 수집·요약·분류·정리 (사실 진술)
- **`overall_verdict` 한 필드에 한해** 단기 1-2주 종합 분위기 평가 (buy_strong/buy/neutral/caution/sell/sell_strong) 허용
- 종합 평가 박스 하단에 강한 면책 ("매매 권유 아님, 결정은 본인") 필수

**코드 위치:** [api/_lib.py](api/_lib.py) / [src/api_handlers.py](src/api_handlers.py) `get_ai_analysis`

- 모델: **`claude-sonnet-4-6`**
- `max_tokens`: 800
- **system 프롬프트** (`AI_SYSTEM_PROMPT`): 정보 비서 역할 명시 / 매매 권유 어휘 금지 / 행동 권고 금지 / 미래 예측 단정 금지 / 미공개 정보 추측 금지 / 사실 진술 표현 강제
- 사용자가 "📋 정보 받기" 버튼을 누를 때만 호출 (수동 트리거)
- prompt 입력 토큰: 약 5,000~6,000 (평단 입력 시 약간 증가)

**출력 스키마:**
```json
{
  "overall_verdict": {                  // 신규 (C안, 2026-05-14)
    "level": "buy_strong|buy|neutral|caution|sell|sell_strong",
    "horizon": "단기 1-2주",
    "summary": "100자 내외 한 줄 결론",
    "aligned_signals": ["...", "..."],     // level 과 같은 방향 신호
    "conflicting_signals": ["...", "..."], // 반대·주의 신호
    "label": "🟢 매수 분위기 우세",        // 코드가 매핑
    "cls":   "verdict-buy"                  // UI 색상
  },
  "current_situation_summary": { "headline", "key_points": [...] },
  "recent_news_summary":       { "positive": [...], "negative": [...], "neutral": [...] },
  "fundamental_snapshot":      { "per", "pbr", "roe", "op_margin", "market_cap", "industry", "notes" },
  "technical_snapshot":        { "rsi", "ma_alignment", "key_events", "support_resistance", "daily_volatility_pct" },
  "market_context":            { "kospi_today_pct", "kospi_5d_pct", "usd_krw", "us_market_yesterday" },
  "user_position": null | {     // 평단 입력 시
    "avg_price", "shares?", "current_price",
    "unrealized_pct", "unrealized_amount?", "total_cost?", "current_value?",
    "unrealized_text", "context_notes": [...]
  },
  "factors_to_consider": [...],
  "metadata": { model, usage, cost_krw, cached, is_information_only: true, disclaimer }
}
```

❌ **제거됨**: `action`, `confidence`, `analysis` (매매 결정 어휘 일체)

**평단/수량 입력 (선택):**
- 평단만 입력 → `user_position` 의 손익률 + `context_notes`
- 평단 + 수량 입력 → 손익률 + 손익액(원) + 매수원가 + 현재 평가액
- 손익 계산은 백엔드 코드에서 (모델에 맡기지 않음 — 사실 정확성)
- 캐시 키 분리: `aib:{code}:{date}:p{avg}q{shares}`

**관련 변경 (2026-05-14):**
- 옛 buy/sell/hold 백테스트 시스템 → `scripts/deprecated/backtest_ai.py` 이동 (보존)
- 옛 분포 카드 (`renderAiStatsCard`) → 호출 제거, 함수는 deprecated 주석으로 1주일 보존
- 옛 호출 로그 → `archive/ai_results/` 그대로 보존, 새 로그는 `archive/ai_briefings/` 로 분리

### AI 안전장치 (Upstash Redis 기반)

| 항목 | 동작 | 위치 |
|---|---|---|
| **캐싱** | 같은 종목 + 같은 날짜는 캐시 응답. TTL: 평일 장중(KST 09~16) 1시간, 그 외 다음 09시까지 | `_kv_get/set` + `_calc_ai_cache_ttl` |
| **Rate Limit** | IP당 분당 **5회**, 일당 **50회**. 초과 시 HTTP 429 + Retry-After 헤더 | `_check_rate_limit`, 상수 `_RL_PER_MIN=5`, `_RL_PER_DAY=50` |
| **일일 비용 한도** | `DAILY_BUDGET_KRW`(기본 2000원) 초과 시 HTTP 503. Sonnet 4.6 토큰가로 매 호출 비용 추정 → 자정 KST 리셋 | `_estimate_cost_krw`, 키 `cost:{YYYY-MM-DD}` |

### AI 적중률 백테스트 (정확도 측정)

| 항목 | 동작 | 위치 |
|---|---|---|
| **호출 로깅** | 캐시 미스(실제 Claude 호출)만 Upstash LIST `ai_log:{YYYY-MM-DD}` 에 LPUSH (input_snapshot + ai_output + usage) | `_log_ai_call` + `_build_input_snapshot` |
| **아카이브** | 매일 KST 02:00 GitHub Actions cron 이 어제 LIST → `archive/ai_results/{YYYY-MM}/{date}.jsonl` 로 옮기고 LIST DEL | `scripts/archive_ai_log.py`, `.github/workflows/archive_ai.yml` |
| **백테스트** | 같은 cron 안에서 archive 전체 + `flow_by_code.json` + `buy_history.json` 의 KOSPI 으로 +1/+5/+10거래일 후 수익률·알파·적중률 산출 → `public/backtest_ai.json` 갱신 + `archive/backtest_ai/{date}.json` 보존 | `scripts/backtest_ai.py` |
| **적중 기준** | buy: +5거래일 후 ≥ +2% / sell: ≤ -2% / hold: \|Δ\| ≤ 2% (상수 `HIT_THRESHOLD_PCT=2.0`, `PRIMARY_HORIZON='5'`) | `scripts/backtest_ai.py` 상단 |
| **사이트 표시** | 사이드바 **📈 백테스트 → AI 분석 적중률** 탭. 기간별(7d/30d/all) + action별(buy/sell/hold) + confidence 구간(9~10/7~8/5~6/1~4) 적중률 표 | `public/js/app.js` `renderBacktestAI` |
| **사용자 컨텍스트 카드** | 종목 상세의 AI 분석 카드 **아래에 항상 표시**. 최근 30일 buy/sell/hold 분포 + 평균 확신도 + (≥5건 시) +5거래일 적중률. hold 비율에 따라 동적 안내 메시지 4종. `public/ai_stats.json` (정적, 매일 02:00 cron 갱신) | `scripts/backtest_ai.py` `_build_ai_stats`, `public/js/app.js` `renderAiStatsCard` |

**ai_stats.json 구조 (확장 가능):**
```json
{
  "default_period": "30d",
  "periods": {
    "30d": {
      "total_calls": N,
      "insufficient": <10건 여부,
      "distribution": { "buy/sell/hold": { count, pct } },
      "confidence": { "avg", "median", "by_bucket": {…} },
      "accuracy_5d": {
        "buy_signals":  { total, correct, rate, criterion, insufficient },
        "sell_signals": {…},
        "hold_signals": {…},
        "measurable_after": "YYYY-MM-DD",
        "insufficient_sample_threshold": 5
      }
    }
  },
  "generated_at": "…"
}
```
미래에 `7d` / `all` 추가 시 `periods` 에 키 추가만 하면 됨.

**환경변수:**
| 이름 | 기본값 | 설명 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | (필수, 없으면 안전장치 비활성) | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | (필수) | Upstash 인증 토큰 |
| `DAILY_BUDGET_KRW` | `2000` | AI 분석 일일 한도 (KRW) |
| `ANTHROPIC_USD_KRW` | `1380` | USD → KRW 환산율 (Sonnet 가격 산정용) |

---

## 동기화 체크리스트 (작업 후)

코드의 점수/임계값을 바꿨다면 이 문서 같은 섹션을 함께 갱신하고, 그 후 `README.md` 와 `public/index.html` 의 details 섹션에 영향이 있는지 확인하세요.

- [ ] `SCORING.md` 해당 §섹션 갱신
- [ ] `README.md` 해당 §섹션 갱신 (사용자에게 노출되는 표/숫자)
- [ ] `public/index.html` 의 `<details class="sidebar-logic">` 섹션 갱신 (사이트 우측 패널에 표시되는 라벨/점수)
- [ ] Commit 메시지에 `📝 README 영향: 있음` + 변경 섹션 명시
- [ ] **마지막 동기화 일자 갱신** (이 문서 상단)
