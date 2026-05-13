# 📈 한국 주식 대시보드

> 🎓 개인 학습 프로젝트 | 📊 데이터 시각화 | ⚠️ 투자 자문 아님

가족과 함께 보려고 만든 한국 주식 정보 대시보드입니다.
네이버 금융 데이터와 뉴스를 자동 수집해 시각화하고, 단순 휴리스틱으로 시장 분위기·기술 지표·통계 신뢰구간을 함께 표시합니다.

**라이브 사이트:** Vercel 배포 (가족 공유용 URL)

---

## ✅ 현재 동작 중인 기능

- [x] **TOP 50 종목** — 인기 검색(1~30위) + 당일 거래량(31~50위) 보충
- [x] **매수 참고 신호** — 시장 분위기·기술 지표 둘 다 매수 쪽인 종목만 필터
- [x] **뉴스 이슈별 종목 참고** — 관련 뉴스 매칭 + 호재/악재 자동 분류
- [x] **수급 상위** — 외국인/기관/개인 5일 순매수 순위
- [x] **SBS Biz 참고 항목** — YouTube 채널 자막에서 종목 자동 추출
- [x] **즐겨찾기** — localStorage 기반 종목 핀
- [x] **종목 검색** — 6자리 코드 또는 종목명
- [x] **시장 분위기 라벨** — 수급+모멘텀+뉴스 휴리스틱 (강한 매수 우위 ~ 강한 매도 우위)
- [x] **기술 지표 라벨** — RSI/MA/골든·데드크로스/이격도/저점반등 종합
- [x] **1·2주 통계 전망** — Historical VaR + GBM 50:50, 모멘텀·RSI 보정, 신뢰도 등급
- [x] **Claude AI 분석** — 시세·수급·뉴스·기술·거시·펀더멘털을 종합한 매수/매도/관망 판단 (Sonnet 4.6). system 프롬프트로 단정 표현·미공개 정보 추측 차단. Upstash Redis 기반 캐싱/IP 분당 5·일당 50 rate limit/일일 2,000원 비용 한도
- [x] **매수 참고 트렌드 추적** — 일별 스냅샷 누적, 신호 시점 forecast 곡선과 실제 종가 비교
- [x] **백테스트 (매수 참고 신호)** — KOSPI 대비 알파 측정 (look-ahead bias 제거, 중복/비정상 격리, 거래비용 차감)
- [x] **백테스트 (AI 적중률)** — Claude 호출 로그 누적 → +1/+5/+10거래일 후 수익률·적중률 측정 + confidence 구간별 검증 (가족 클릭한 종목만, 표본 ≥50 권장)
- [x] **GitHub Actions 자동 갱신** — 매시 7분/37분 cron
- [x] **첫 진입 면책 모달** — localStorage 기반 1회 동의

---

## 📁 프로젝트 구조

```
STOCK/
├── 📁 src/
│   ├── fetch_data.py          # 메인 데이터 수집 + TOP 50 선정
│   ├── recommend.py           # 시장 분위기·기술 지표·forecast·매수 스냅샷
│   ├── backtest.py            # 매수 참고 신호 사후 성과 측정
│   ├── sbs_biz.py             # SBS Biz YouTube 자막 → 종목 추출
│   ├── api_handlers.py        # 종목/뉴스/수급/AI 분석 공통 로직
│   ├── server.py              # 로컬 개발 서버
│   ├── debug.py / debug_news.py / test_scrape.py  # 디버깅·테스트 도구
│   └── …
├── 📁 api/                    # Vercel 서버리스 함수
│   ├── _lib.py                # api 함수 공통 라이브러리 (api_handlers.py 와 동기 유지)
│   ├── stock.py / news.py / flow.py / intraday.py / ai_analyze.py
│   └── …
├── 📁 public/                 # Vercel 배포 정적 자산
│   ├── index.html             # 메인 페이지
│   ├── data.json              # 자동 갱신되는 메인 데이터
│   ├── flow_by_code.json      # 종목별 60일 시세 (용량 큰 부분 분리)
│   ├── buy_history.json       # 일별 매수 참고 스냅샷 (90일 슬라이딩)
│   ├── backtest.json          # 매수 참고 신호 백테스트 결과
│   ├── backtest_ai.json       # AI 분석 적중률 백테스트 결과
│   ├── sbsbiz.json            # SBS Biz YouTube 추출 데이터
│   ├── stocks.json            # KOSPI/KOSDAQ 종목 마스터
│   ├── css/style.css
│   └── js/app.js
├── 📁 .github/workflows/
│   ├── update-data.yml        # 매시 7/37분 자동 데이터 갱신
│   └── archive_ai.yml         # 매일 KST 02:00 AI 호출 로그 archive + 적중률 백테스트
├── 📁 scripts/
│   ├── archive_ai_log.py      # Upstash LIST → archive/ai_results/*.jsonl
│   └── backtest_ai.py         # archive 읽고 적중률 산출 → public/backtest_ai.json
├── 📁 archive/
│   ├── ai_results/{YYYY-MM}/{date}.jsonl   # 일별 AI 호출 로그 (Git 보존)
│   └── backtest_ai/{YYYY-MM-DD}.json       # 백테스트 히스토리 스냅샷
├── 📁 .claude/
│   ├── CLAUDE.md              # Claude 작업 규칙
│   └── settings.local.json
├── run.bat                    # Windows 로컬: 데이터 갱신 + 로컬 서버 실행
├── update.bat                 # Windows 로컬: 데이터 갱신만
├── vercel.json                # Vercel 라우팅·캐시 설정
├── requirements.txt
└── README.md                  # 이 파일
```

---

## 🏗 프로젝트 히스토리

1. **2026-05 초** 단순 인기 종목 TOP 30 + 뉴스 매칭으로 시작
2. 시장 분위기·기술 지표 라벨 추가, 매수 추천 메뉴 신설
3. 1·2주 통계 신뢰구간 + Claude AI 분석 카드 추가
4. TOP 50 확장, 매수 추천 일별 트렌드 추적 + 백테스트 시스템 도입
5. **2026-05-14** 정직성 보강 — Historical VaR, 모멘텀/RSI 보정, look-ahead bias 제거, 거래비용 차감. "추천" 표현을 "참고 신호"로 정리, 면책 모달·라벨 안내 배너 추가

---

## 🚀 사용 방법

### 로컬 실행
```bash
cd STOCK
pip install -r requirements.txt
```

`.env` 파일을 만들어 키를 넣습니다 (gitignore 됨):
```
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
ANTHROPIC_API_KEY=...                 # AI 분석 기능을 쓸 때만
UPSTASH_REDIS_REST_URL=...            # AI 분석 캐싱/rate limit/비용 한도용 (선택)
UPSTASH_REDIS_REST_TOKEN=...
DAILY_BUDGET_KRW=2000                 # AI 분석 일일 한도 (기본 2000원)
ANTHROPIC_USD_KRW=1380                # USD→KRW 환산율 (Sonnet 비용 산정)
```

> Upstash 환경변수 없이도 AI 분석은 작동합니다 (안전장치만 자동 비활성, 단 비용 한도·rate limit 보호 없음).

데이터 갱신 + 로컬 서버 실행:
```bash
run.bat
# 또는 데이터만 갱신:
update.bat
```
브라우저에서 `http://localhost:8000/` 접속.

### Vercel 배포
- `vercel --prod` 또는 Vercel 대시보드에서 GitHub 연동
- 환경 변수 (Settings → Environment Variables) 에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `ANTHROPIC_API_KEY` 등록

### 자동 갱신
- `.github/workflows/update-data.yml` 이 **매시 7분/37분** 에 `fetch_data.py` 를 돌려 `public/*.json` 파일을 갱신·푸시
- GitHub Secrets 에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 등록 필요
- Vercel 은 main 브랜치 push 를 감지해 자동 재배포

---

## 🎯 점수 산정 방식

라벨 시스템은 5개로 분리되어 있습니다. 사이트 사이드바 **"📈 시장 분위기 산정 로직"** / **"📐 기술적 지표 산정 로직"** details 섹션에 시각적으로 정리되어 있으니 같이 확인하시면 편합니다.

> 📌 **정확한 임계값·라벨 기준의 단일 진실의 원천은 [SCORING.md](SCORING.md)** 입니다. 이 README 의 표와 SCORING.md 가 어긋나면 SCORING.md 를 기준으로 봐주세요.

### A. TOP 50 종목 선정 ([src/fetch_data.py](src/fetch_data.py) `score_stocks`)
**1~30위 (인기 검색 + 뉴스 점수):**
- 인기 순위 점수: 1등 30점 ~ 30등 1점 (`RANK_SCORE_MAX = 30`)
- 뉴스 점수: 관련 뉴스 1건당 +15점 (`NEWS_SCORE_PER_ARTICLE = 15`)
- 합산 점수 내림차순 정렬

**31~50위 (당일 거래량 보충):**
- 네이버 거래량 상위 페이지(KOSPI + KOSDAQ)에서 1~30위에 없는 종목을 거래량 순으로 추가
- 점수 0 (정렬엔 영향 없음, 단순 보충)

### B. 시장 분위기 점수 ([public/js/app.js](public/js/app.js) `calcSignal` / [src/recommend.py](src/recommend.py) `calc_signal`)
5일 수급 + 5일 가격 추세 + 당일 모멘텀 + 뉴스 호재/악재 net 을 합산.

| 가산 (매수 우위) | 감산 (매도 우위) |
|---|---|
| 외인+기관 동반 매수일 × **+3**/일 | 외인+기관 동반 매도일 × **-3**/일 |
| 외국인 매수일 × **+2**/일 | 외국인 매도일 × **-1**/일 |
| 기관 매수일 × **+1.5**/일 | 5일 -10% 이상 하락 **-3** |
| 5일 +10% 이상 상승 **+3** | 5일 -5~-10% 하락 **-2** |
| 5일 +5~10% 상승 **+2** | 당일 +7% 이상 급등 (과열) **-2** |
| 뉴스 호재 net ≥10 **+10** / ≥5 **+6** / ≥3 **+3** / ≥1 **+1** | 당일 -7% 이상 급락 **-1** |
| | 뉴스 악재 net ≤-10 **-10** / ≤-5 **-6** / ≤-3 **-3** / ≤-1 **-1** |

**점수 → 라벨:**
| 점수 | 라벨 |
|---|---|
| ≥ 18 | 강한 매수 우위 |
| 10 ~ 17 | 매수 우위 |
| 3 ~ 9 | 약한 매수세 (단, 당일 +7%↑ 급등이면 **관망**) |
| -3 ~ 2 | 중립 |
| -10 ~ -4 | 매도 우위 |
| ≤ -11 | 강한 매도 우위 |

### C. 기술 지표 ([public/js/app.js](public/js/app.js) `calcTechnicals` + `summarizeTechnicals`)
60일 시세로 매수 신호 4종 / 매도 신호 3종 카운트 → `net = 매수 - 매도`.

| 매수 신호 (각 +1) | 매도 신호 (각 -1) |
|---|---|
| RSI(14) ≤ 30 (저가권) | RSI(14) ≥ 70 (과열) |
| 골든크로스 (5일선 ↗ 20일선) | 데드크로스 (5일선 ↘ 20일선) |
| 바닥 반등 (5일 -7%↓ + 어제 +2%↑) | 20일선 이격도 ≥ +15% (단기 과열) |
| 20일선 이격도 ≤ -10% (평균선 이탈) | |

**net → 라벨:** ≥2 매수 신호 강함 / 1 매수 신호 / 0+신호없음 중립 / 0+신호있음 혼조 / -1 매도 신호 / ≤-2 매도 신호 강함

### D. 1·2주 통계 전망 ([public/js/app.js](public/js/app.js) `calcForecast`)
60일 로그 수익률의 평균 μ·표준편차 σ 에 다음 보정 적용:
- **Historical VaR + 정규모델 50:50** — fat tail 일부 반영
- **모멘텀 보정** — 60일 μ × 0.6 + 최근 5일 μ × 0.4
- **RSI mean reversion** — 과열/과매도 시 μ 회귀 압력
- **이벤트 리스크** — 실적 발표 D-7 이내면 σ × 1.5

**신뢰도 등급:** stable (안정) / caution (주의) / limited (표본 부족) / uncertain (실적 임박 등)

### E. 매수 참고 메뉴 필터
**시장 분위기 ∈ {강한 매수 우위, 매수 우위, 약한 매수세}** 그리고 **기술 지표 ∈ {매수 신호 강함, 매수 신호}** 인 종목만.

---

## 📊 백테스트 시스템

매수 참고 신호가 KOSPI 대비 의미 있는 알파를 만드는지 정량 검증합니다 ([src/backtest.py](src/backtest.py)).

### 측정 방법론 (정직성 보강)
| 항목 | 처리 |
|---|---|
| Look-ahead bias | 진입가 = 신호일 **다음 거래일 시가** / 측정가 = horizon N거래일 후 종가 |
| 생존 편향 | 일일 절대 변동 ±25% 이상은 거래정지·액면분할·상폐 의심으로 격리 |
| 중복 신호 | 같은 종목 5거래일 내 재발생은 duplicate. unique 기준(메인) + 전체 기준(참고) 둘 다 산출 |
| 거래비용 | 왕복 0.3% 차감 시나리오를 별도 컬럼으로 |
| 보존 | 일별 스냅샷 90일 슬라이딩 윈도우 |

### 라벨 기준 (unique·비용 차감 알파 기준)
| 라벨 | 조건 |
|---|---|
| 🟢 의미 있는 알파 | 평균 알파 > +1.0% **AND** 승률 > 55% |
| ⚪ 시장 수준 | 그 사이 |
| 🔴 시장 미달 | 평균 알파 < -1.0% **OR** 승률 < 45% |
| 데이터 부족 | 표본 < 20 |

### 한계 (정직히)
- 시가 진입 가정도 호가 슬리피지·갭 상승은 못 잡음
- ±25% 임계는 휴리스틱 (액면분할 즉시 변동은 잡지만 점진적 위험은 한계)
- 의미 있는 검증에 표본 50건 이상 + 3개월 이상 데이터 권장
- 단기 1·2주 매매 자체가 통계적으로 시장을 이기기 어려움 — 모든 결정은 본인 판단

---

## ⚠️ 주의사항 / 면책 조항

본 프로젝트는 **개인 학습 목적의 데이터 시각화 도구**입니다.
제공되는 정보는 **투자 자문이 아니며**, 모든 투자 결정과 그 결과에 대한 책임은 **이용자 본인**에게 있습니다.

- 데이터의 정확성을 보장하지 않습니다 (외부 사이트 구조 변경 시 수집이 중단/왜곡될 수 있음)
- 휴리스틱과 통계 모델은 모든 시장 상황을 반영하지 못합니다 (실적·정책·지정학 쇼크 등)
- AI 분석은 LLM 의 일반 지식 + 입력 데이터에 기반한 한 가지 의견일 뿐이며, hallucination 가능성이 있습니다
- 단기 매매 (1~2주) 자체가 통계적으로 시장을 이기기 어려운 활동입니다

투자는 본인의 충분한 학습·분석·자기책임 하에 신중히 결정하세요.

---

## 🔗 데이터 출처
- 네이버 금융 ([finance.naver.com](https://finance.naver.com))
- 네이버 검색 Open API ([developers.naver.com](https://developers.naver.com))
- YouTube Transcript API (SBS Biz 채널 자막)
- Anthropic Claude API (claude-sonnet-4-6)

---

**📅 README 최종 업데이트:** 2026-05-14 (AI 호출 로깅 + 적중률 백테스트 추가)
