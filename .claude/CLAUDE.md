# 프로젝트 작업 규칙 (Claude 전용)

이 파일은 Claude 가 이 저장소에서 작업할 때 지켜야 하는 약속을 정리한 것입니다.
모든 작업은 아래 7가지 규칙을 우선합니다.

## 1. 변경 전 git 상태 확인
- 코드를 수정하기 전에 항상 `git status` 로 현재 상태를 확인한다.
- **커밋되지 않은 변경사항이 있으면 먼저 사용자에게 알리고**, 의도된 변경인지 확인을 받은 뒤에야 새 작업을 시작한다.
- 충돌 위험이 보이면 `git pull --rebase` 또는 stash 여부도 함께 묻는다.

## 2. 큰 변경은 단계별 진행
- 변경이 3단계 이상이거나 여러 파일을 동시에 건드릴 때는 **TodoWrite 로 작업 계획을 세우고** 사용자에게 보여준 뒤 시작한다.
- 각 단계 완료 후 다음 단계로 넘어가기 전 핵심 결정 사항(예: 알고리즘 선택, UI 구조 결정)은 사용자에게 짧게 확인을 받는다.
- "전부 한꺼번에 처리해버리는" 패턴을 피한다 — 중간 점검 기회를 만든다.

## 3. 기존 동작 변경 시 before/after 명시
- 기존 로직·UI·계산 방식을 바꿀 때는 **변경 전과 후를 명확히 설명**한다.
- 예: "이전엔 RANK_SCORE_MAX=30 으로 인기 검색 30위까지만 점수, 이제는 50으로 확장 + 31~50위는 거래량 보충". 단순 "수정함" 으로 끝내지 않는다.
- 사용자가 체감하는 변화(예: 화면에서 사라진 항목, 숫자가 달라진 이유)를 항상 함께 설명한다.

## 4. 외부 API 호출은 에러 처리 + 로깅 필수
- 네이버 금융, 네이버 검색 Open API, Anthropic Claude API, YouTube 자막 등 **외부 호출 코드를 추가/수정할 때는 반드시**:
  - `try/except` 또는 `try/catch` 로 감싼다.
  - 실패 시 `print(f"[WARN] ... 실패: {e}")` / `console.warn` 등 명시적 로깅.
  - 호출이 실패해도 **전체 갱신 파이프라인이 무너지지 않게** fallback (`continue`, `return None` 등) 처리.
  - HTTP 응답 코드, 타임아웃, 인코딩 (`euc-kr` vs `utf-8`) 같은 알려진 함정도 함께 처리.

## 5. README ↔ 실제 코드 일치 (절차 + 자동 트리거)

`SCORING.md` 가 점수/임계값의 **single source of truth** 다.
README.md 와 사이트 `public/index.html` 의 details 섹션은 SCORING.md 와 일치해야 한다.

### 5-1. 핵심 동기화 대상 파일

다음 중 **하나라도 수정**되면 SCORING.md / README.md / public/index.html details 의 영향을 점검해야 한다:

| 시스템 | 코드 위치 | 영향 받는 문서 |
|---|---|---|
| **A. TOP 50 선정** | `src/fetch_data.py` (`score_stocks`, `RANK_SCORE_MAX`, `NEWS_SCORE_PER_ARTICLE`) | SCORING.md §A, README §A |
| **B. 시장 분위기** | `src/recommend.py` (`calc_signal`), `public/js/app.js` (`calcSignal`) | SCORING.md §B, README §B, index.html details "시장 분위기 산정 로직" |
| **C. 기술 지표** | `src/recommend.py` (`calc_technicals`, `summarize_technicals`), `public/js/app.js` (`calcTechnicals`, `summarizeTechnicals`) | SCORING.md §C, README §C, index.html details "기술적 지표 산정 로직" |
| **D. 1·2주 전망** | `src/recommend.py` (`calc_forecast`), `public/js/app.js` (`calcForecast`), `api/_lib.py` / `src/api_handlers.py` (`_ai_calc_forecast`) | SCORING.md §D, README §D |
| **E. 매수 참고 필터** | `public/js/app.js` (`renderRecommendBuy`) | SCORING.md §E, README §E, 메뉴 부제 |
| **보존/측정 기간** | `src/recommend.py` (`KEEP_DAYS`), `src/backtest.py` (`horizons`, `COOLDOWN_DAYS`, `ABNORMAL_DAILY_THRESHOLD`, `TRADING_COST_PCT`) | SCORING.md §보존, README 백테스트 섹션 |
| **데이터 파이프라인/배포** | `.github/workflows/*.yml`, `vercel.json`, `requirements.txt` | README "사용 방법" / "자동 갱신" 섹션 |

### 5-2. 작업 사이클 절차

**작업 시작 시 (자기 확인):**
- 변경할 파일이 위 표에 해당하는가?
- 해당하면: 작업 *시작 단계에 사용자에게 알림* — 형식:
  > ⚠️ [파일]의 [함수/상수] 수정 예정. [X 시스템] 해당.
  > 동기화 필요: SCORING.md [섹션] / README.md [섹션] / index.html details.
  > 계속 진행할까요?
- 같은 세션에서 동일 파일에 대해서는 한 번만 표시.

**작업 종료 시 (매핑 체크리스트 보고):**
변경 후 한 줄 보고 — 형식:
- ✅ `src/recommend.py KEEP_DAYS` 변경 → SCORING.md §보존 / README 백테스트 섹션 동기화 완료
- ⚠️ 동기화 보류된 항목이 있으면 명시 (왜 지금 못 하는지 + 언제 처리할지)

### 5-3. Commit 메시지 규칙

핵심 파일 (위 표) 수정 시 commit 메시지 본문 끝에 다음 라인 포함:

```
📝 README 영향: 있음
   - SCORING.md §B (시장 분위기 점수 임계값 변경)
   - README.md §점수 산정 / B
   - public/index.html details "시장 분위기 산정 로직"
```

또는

```
📝 README 영향: 없음 (내부 함수 리팩토링, 외부 동작 불변)
```

"있음" 으로 적었다면 **같은 commit 안에 동기화 변경이 포함**되어야 한다. 분리 commit 금지.

### 5-4. "다음 작업에서…" 금지

실제 코드를 변경했는데 README 가 옛 설명을 가지고 있다면 같은 turn 안에 갱신.
미루기 패턴을 발견하면 즉시 작업 중단하고 사용자에게 알릴 것.

## 6. 시크릿·API 키 관리
- `ANTHROPIC_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 등 모든 키는 **환경변수로만 처리**한다.
- 코드에 하드코딩 절대 금지. `.env` 는 `.gitignore` 에 포함되어 있고 추적되지 않아야 한다.
- Vercel 환경에서는 Vercel 대시보드의 환경변수, GitHub Actions 에서는 `secrets.*` 를 사용한다.
- 사용자가 채팅으로 키를 공유했더라도 코드/문서에 옮겨 적지 않는다.
- 우연히 키가 코드에 들어간 흔적을 발견하면 즉시 사용자에게 알리고 재발급을 권한다.

## 7. 응답 언어
- **사용자에게 보이는 모든 텍스트는 한국어**로 작성한다. (대화, 커밋 메시지, 콘솔 출력 포함 가능)
- 코드 내 식별자(함수명, 변수명)는 영문을 유지한다.
- 사용자가 영문으로 질문했더라도 별도 요청이 없는 한 한국어로 응답한다.

---

## 참고: 이 프로젝트 특성

- 한국 주식 정보 대시보드 (가족용)
- 백엔드 데이터 수집: `src/fetch_data.py` + GitHub Actions cron (매시 7/37분)
- 정적 사이트: `public/` 디렉토리, Vercel 배포
- 서버리스 API: `api/*.py` (Vercel Python functions, 핵심 로직은 `api/_lib.py`)
- 로컬 서버: `src/server.py` (개발용)
- `src/api_handlers.py` ↔ `api/_lib.py` 는 동일 로직을 양쪽 유지 (Vercel 외부 import 제약 때문)
- 데이터 파일: `public/data.json`, `public/flow_by_code.json`, `public/sbsbiz.json`, `public/buy_history.json`, `public/backtest.json`
- 사용자에게 "투자 자문이 아닌 정보 제공"임을 항상 의식하고, 과도한 확신을 주는 표현을 피한다.
- **AI 기능의 역할 (2026-05-14 결정)**: Claude AI 호출 기능(`get_ai_analysis`)은 *정보 비서/브리핑* 으로 제한. 매매 판단(buy/sell/hold)·행동 권고("부분 익절"·"추매 추천" 등)·미래 예측 단정 절대 추가 금지. 시스템 프롬프트 `AI_SYSTEM_PROMPT` 의 금지 어휘 목록은 단순 가이드가 아니라 **제품 정체성**임. 사용자가 명시적으로 뒤집기 전까진 매매 판단 라벨 부활 금지.
