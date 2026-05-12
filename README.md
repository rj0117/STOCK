# 📈 한국 주식 TOP 30

매일 업데이트되는 한국 주식 정보 대시보드입니다.

## 기능
- **네이버 금융 인기 검색 종목** 자동 수집
- **당일 주요 뉴스** 수집 및 종목 연관도 분석
- **TOP 30 종목** 선정 (인기 순위 + 뉴스 연관성 점수)
- **모바일 반응형** 대시보드

## 프로젝트 구조

```
📁 STOCK/
├── 📁 src/
│   ├── fetch_data.py      # 데이터 수집 + TOP 30 선정 스크립트
│   ├── debug.py           # 디버깅 도구
│   ├── debug_news.py      # 뉴스 디버깅
│   └── test_scrape.py     # 크롤링 테스트
├── 📁 site/               # GitHub Pages에 업로드할 정적 사이트
│   ├── index.html         # 메인 페이지
│   ├── data.json          # 매일 업데이트되는 데이터
│   ├── css/
│   │   └── style.css      # 스타일시트
│   └── js/
│       └── app.js         # 데이터 렌더링
├── update.bat             # Windows용 업데이트 배치파일
├── requirements.txt       # Python 의존성
└── README.md              # 이 파일
```

## 로컬 사용 방법

### 1. 설치
```bash
cd STOCK
pip install -r requirements.txt
```

### 2. 데이터 업데이트
```bash
# 방법 1: 배치 파일 실행
update.bat

# 방법 2: 직접 실행
python src/fetch_data.py
```

### 3. 사이트 확인
`site/index.html` 파일을 웹브라우저로 열면 됩니다.

## GitHub Pages 배포 방법 (외부 접속)

1. **GitHub에 저장소 만들기**
   - GitHub 계정 로그인 → New Repository
   - 이름: `stock` (또는 원하는 이름)
   - Public으로 설정
   - Create repository

2. **Git 초기화 및 푸시**
   ```bash
   cd STOCK
   git init
   git add site/
   git add README.md
   git commit -m "초기 배포"
   git branch -M main
   git remote add origin https://github.com/사용자명/stock.git
   git push -u origin main
   ```

3. **GitHub Pages 활성화**
   - GitHub 저장소 → Settings → Pages
   - Source: Deploy from a branch
   - Branch: `main`, folder: `/site` (또는 `/docs`)
   - Save

4. **매일 업데이트 자동화 (선택)**
   - GitHub Actions 또는 로컬 PC에서 `update.bat`을 매일 실행
   - 실행 후: `git add site/data.json && git commit -m "일일 업데이트" && git push`

5. **접속 URL**
   ```
   https://사용자명.github.io/stock/
   ```

## 점수 산정 방식
- **인기 순위 점수**: 1등 30점 ~ 30등 1점
- **뉴스 연관 점수**: 관련 뉴스 1건당 15점
- **종합 점수** = 인기 순위 점수 + 뉴스 연관 점수 (높을수록 추천)

## 주의사항
- 본 사이트는 참고용입니다. 실제 투자 결정은 본인의 판단에 따라 신중히 하시기 바랍니다.
- 데이터는 네이버 금융에서 수집되며, 사이트 구조 변경 시 수집이 중단될 수 있습니다.