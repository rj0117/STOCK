/**
 * 한국 주식 대시보드 - 프론트엔드 라우터
 * 뷰: top30 / news / favorites / search
 */

const FAV_KEY = "stock-favorites";
const state = {
    data: null,           // data.json
    stocks: null,         // stocks.json - 종목 마스터
    sbsbiz: null,         // sbsbiz.json - SBS Biz YouTube 추천
    buyHistory: null,     // buy_history.json - 일별 매수 추천 스냅샷
    backtest: null,       // backtest.json - 사후 성과 측정
    favorites: loadFavorites(),
    currentView: null,
};

// ============ 유틸 ============
function formatPrice(n) {
    n = Number(n) || 0;
    return n.toLocaleString("ko-KR");
}

function formatChange(change, changePct) {
    const c = Number(change) || 0;
    const pct = Number(changePct) || 0;
    if (c === 0) return { text: "0 (0.00%)", cls: "flat" };
    const sign = c > 0 ? "+" : "";
    const cls = c > 0 ? "up" : "down";
    return {
        text: `${sign}${formatPrice(c)} (${sign}${pct.toFixed(2)}%)`,
        cls,
    };
}

function formatChangeFromBackend(stock) {
    // data.json 의 top30 종목은 change 필드가 "+1,500" 같은 문자열 (등락액)
    if (typeof stock.change_pct === "number") {
        return formatChange(stock.change, stock.change_pct);
    }
    const raw = String(stock.change || "0").replace(/,/g, "");
    const c = Number(raw) || 0;
    if (c === 0) return { text: "0", cls: "flat" };
    const sign = c > 0 ? "+" : "";
    const cls = c > 0 ? "up" : "down";
    return { text: `${sign}${formatPrice(c)}`, cls };
}

function escapeHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function loadFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAV_KEY)) || [];
    } catch (e) {
        return [];
    }
}

function saveFavorites() {
    localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites));
    document.getElementById("fav-count").textContent = state.favorites.length;
}

function isFavorite(code) {
    return state.favorites.includes(code);
}

function toggleFavorite(code) {
    const i = state.favorites.indexOf(code);
    if (i >= 0) state.favorites.splice(i, 1);
    else state.favorites.push(code);
    saveFavorites();
}

// ============ 데이터 로딩 ============
// 서버가 charset 헤더를 안 보낼 때를 대비해 항상 UTF-8로 디코딩
async function fetchJsonUtf8(url, fallback) {
    try {
        const r = await fetch(url);
        if (!r.ok) return fallback;
        const buf = await r.arrayBuffer();
        return JSON.parse(new TextDecoder("utf-8").decode(buf));
    } catch (e) {
        return fallback;
    }
}

async function loadData() {
    try {
        // 1단계: 가벼운 파일만 먼저 로드 → 첫 화면 즉시 표시
        const [data, stocks, sbsbiz, buyHistory, backtest] = await Promise.all([
            fetchJsonUtf8("data.json", null),
            fetchJsonUtf8("stocks.json", []),
            fetchJsonUtf8("sbsbiz.json", null),
            fetchJsonUtf8("buy_history.json", null),
            fetchJsonUtf8("backtest.json", null),
        ]);
        if (!data) throw new Error("data.json 로드 실패");
        state.data = data;
        state.stocks = Array.isArray(stocks) ? stocks : [];
        state.sbsbiz = sbsbiz;
        state.buyHistory = buyHistory;
        state.backtest = backtest;
        if (data.flow && !data.flow.by_code) data.flow.by_code = {};
        populateRecommendHistoryMenu();
        const gen = document.getElementById("generated-at");
        if (gen && data.generated_at) gen.textContent = `· 업데이트: ${data.generated_at}`;
        const sideTime = document.getElementById("sidebar-update-time");
        if (sideTime && data.generated_at) sideTime.textContent = `${data.generated_at} (KST)`;
    } catch (e) {
        console.error(e);
        document.getElementById("view").innerHTML =
            `<div class="placeholder">데이터를 불러오지 못했습니다. <br>먼저 <code>run.bat</code>으로 데이터를 수집해주세요.</div>`;
    }
}

// 2단계: 무거운 flow_by_code 백그라운드 로드 → _flowCache 채우고 현재 뷰 재렌더
async function loadFlowByCode() {
    try {
        const payload = await fetchJsonUtf8("flow_by_code.json", null);
        if (!payload || !payload.by_code) return;
        const byCode = payload.by_code;
        if (state.data && state.data.flow) {
            state.data.flow.by_code = byCode;
        }
        for (const code in byCode) {
            _flowCache.set(code, Promise.resolve({
                code,
                name: byCode[code].name,
                days: byCode[code].days,
                prices_60d: byCode[code].prices_60d || [],
            }));
        }
        state.flowReady = true;
        // 첫 화면이 by_code에 의존하는 뷰면 재렌더
        try { render(); } catch (e) { console.error(e); }
    } catch (e) {
        console.warn("flow_by_code 로드 실패:", e);
    }
}

// ============ 공용 헬퍼: 즐겨찾기 토글 + 시그널 뱃지 ============
function favIconHTML(code) {
    const active = isFavorite(code);
    return `<button class="fav-icon ${active ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavAt(event, '${code}')" title="${active ? '즐겨찾기 해제' : '즐겨찾기 추가'}" aria-label="즐겨찾기">★</button>`;
}

function toggleFavAt(event, code) {
    event.stopPropagation();
    toggleFavorite(code);
    const btn = event.currentTarget;
    btn.classList.toggle('active', isFavorite(code));
    btn.title = isFavorite(code) ? '즐겨찾기 해제' : '즐겨찾기 추가';
}
window.toggleFavAt = toggleFavAt;

/**
 * 5일 종가 데이터 → 미니 SVG 스파크라인 HTML.
 * @param {Array} days - flow.days 형태. [{date, close, change}, ...] 최신 → 과거 순서
 */
function sparklineHTML(days, opts = {}) {
    if (!days || days.length < 2) {
        return `<div class="sparkline-empty">차트 없음</div>`;
    }
    const w = opts.width || 100;
    const h = opts.height || 36;
    // days는 최신→과거 → 시각화는 과거→최신
    const prices = [...days].reverse().map(d => d.close);
    const dates = [...days].reverse().map(d => d.date);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const padTop = 3, padBottom = 3;
    const innerH = h - padTop - padBottom;
    const stepX = prices.length > 1 ? w / (prices.length - 1) : w;

    const pts = prices.map((p, i) => {
        const x = i * stepX;
        const y = padTop + (1 - (p - min) / range) * innerH;
        return [x, y];
    });

    const isUp = prices[prices.length - 1] >= prices[0];
    const stroke = isUp ? "#e53935" : "#1e88e5";
    const fill = isUp ? "rgba(229,57,53,0.12)" : "rgba(30,136,229,0.12)";
    const lastX = pts[pts.length - 1][0];
    const lastY = pts[pts.length - 1][1];

    const linePoints = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const areaPoints = `0,${h} ${linePoints} ${w},${h}`;

    // 툴팁용 데이터
    const change = prices[prices.length - 1] - prices[0];
    const changePct = prices[0] ? (change / prices[0] * 100) : 0;
    const sign = change >= 0 ? "+" : "";
    const title = `5일 ${sign}${change.toLocaleString("ko-KR")}원 (${sign}${changePct.toFixed(2)}%)\n${dates[0]} ${prices[0].toLocaleString("ko-KR")} → ${dates[dates.length-1]} ${prices[prices.length-1].toLocaleString("ko-KR")}`;

    return `
        <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="5일 종가 추이" style="width:${w}px;max-width:100%;height:auto;">
            <title>${escapeHtml(title)}</title>
            <polygon points="${areaPoints}" fill="${fill}"/>
            <polyline points="${linePoints}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${stroke}"/>
        </svg>
    `;
}

/**
 * 5일 종가 데이터 → 가격/날짜 라벨 포함한 큰 SVG 차트.
 * 검색 페이지처럼 큰 영역에 적합.
 */
function chartHTML(days, opts = {}) {
    if (!days || days.length < 2) return `<div class="sparkline-empty">차트 없음</div>`;
    const w = opts.width || 400;
    const h = opts.height || 170;
    const data = [...days].reverse();  // 과거 → 최신
    const prices = data.map(d => d.close);
    const dates = data.map(d => d.date);

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    const padT = 22, padB = 28, padL = 16, padR = 16;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const stepX = prices.length > 1 ? innerW / (prices.length - 1) : innerW;

    const pts = prices.map((p, i) => {
        const x = padL + i * stepX;
        const y = padT + (1 - (p - min) / range) * innerH;
        return { x, y, price: p, date: dates[i] };
    });

    const isUp = prices[prices.length - 1] >= prices[0];
    const stroke = isUp ? "#e53935" : "#1e88e5";
    const fill = isUp ? "rgba(229,57,53,0.10)" : "rgba(30,136,229,0.10)";

    const linePts = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPts = `${padL},${h - padB} ${linePts} ${padL + innerW},${h - padB}`;

    // 가격 라벨 (점 위에 위치, 최상단이면 점 아래로)
    const priceLabels = pts.map((p, i) => {
        const isLast = i === pts.length - 1;
        const above = p.y - 8;
        const ySafe = above < padT + 6 ? p.y + 14 : above;
        return `<text x="${p.x.toFixed(1)}" y="${ySafe.toFixed(1)}" class="chart-price ${isLast ? 'chart-price-last' : ''}" text-anchor="middle">${p.price.toLocaleString('ko-KR')}</text>`;
    }).join("");

    // x축 일자 (MM/DD)
    const dateLabels = pts.map(p => {
        const md = p.date && p.date.length >= 10 ? p.date.slice(5).replace('-', '/') : p.date;
        return `<text x="${p.x.toFixed(1)}" y="${h - 8}" class="chart-date" text-anchor="middle">${md}</text>`;
    }).join("");

    // 데이터 점
    const circles = pts.map((p, i) => {
        const isLast = i === pts.length - 1;
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isLast ? 3.5 : 2.5}" fill="${stroke}" ${isLast ? `stroke="#fff" stroke-width="1.5"` : ""}/>`;
    }).join("");

    return `
        <svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" style="width:100%;height:auto;max-width:${w}px;">
            <polygon points="${areaPts}" fill="${fill}"/>
            <polyline points="${linePts}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            ${circles}
            ${priceLabels}
            ${dateLabels}
        </svg>
    `;
}

/**
 * 분봉(intraday) 데이터 → 당일 시간대별 가격 차트.
 * @param {Object} intraday - { date, data: [{time, close, volume}] }
 */
function intradayChartHTML(intraday, opts = {}) {
    if (!intraday || !intraday.data || intraday.data.length < 2) {
        return `<div class="sparkline-empty">분봉 데이터 없음</div>`;
    }
    const w = opts.width || 400;
    const h = opts.height || 170;
    const data = intraday.data;
    const prices = data.map(d => d.close);
    const times = data.map(d => d.time);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const padT = 22, padB = 28, padL = 16, padR = 16;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

    const first = prices[0];
    const last = prices[prices.length - 1];
    const isUp = last >= first;
    const stroke = isUp ? "#e53935" : "#1e88e5";
    const fill = isUp ? "rgba(229,57,53,0.10)" : "rgba(30,136,229,0.10)";

    const pts = prices.map((p, i) => ({
        x: padL + i * stepX,
        y: padT + (1 - (p - min) / range) * innerH,
        price: p,
        time: times[i],
    }));
    const linePts = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPts = `${padL},${h - padB} ${linePts} ${padL + innerW},${h - padB}`;
    const lastPt = pts[pts.length - 1];

    // 시간 축 라벨 - 9:00, 10:30, 12:00, 13:30, 15:00 같은 주요 시점
    const targetTimes = ["0900", "1030", "1200", "1330", "1500", "1530"];
    const timeLabels = targetTimes.map(t => {
        // 가장 가까운 데이터 포인트 찾기
        const idx = data.findIndex(d => d.time === t);
        if (idx < 0) return "";
        const x = pts[idx].x;
        const label = `${t.slice(0, 2)}:${t.slice(2)}`;
        return `<text x="${x.toFixed(1)}" y="${h - 8}" class="chart-date" text-anchor="middle">${label}</text>`;
    }).join("");

    // 가격 라벨 - 시작가, 최고가, 최저가, 마지막
    const minIdx = prices.indexOf(min);
    const maxIdx = prices.indexOf(max);
    const labels = new Set([0, prices.length - 1, minIdx, maxIdx]);
    const priceLabels = Array.from(labels).map(i => {
        const p = pts[i];
        const isLast = i === prices.length - 1;
        const above = p.y - 8;
        const ySafe = above < padT + 6 ? p.y + 14 : above;
        return `<text x="${p.x.toFixed(1)}" y="${ySafe.toFixed(1)}" class="chart-price ${isLast ? 'chart-price-last' : ''}" text-anchor="middle">${p.price.toLocaleString('ko-KR')}</text>`;
    }).join("");

    return `
        <svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" style="width:100%;height:auto;max-width:${w}px;">
            <polygon points="${areaPts}" fill="${fill}"/>
            <polyline points="${linePts}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="3" fill="${stroke}" stroke="#fff" stroke-width="1.5"/>
            ${priceLabels}
            ${timeLabels}
        </svg>
    `;
}

function sentBadgeHTML(sentiment) {
    if (sentiment === "positive") return `<span class="sent-badge sent-pos" title="호재">호재</span>`;
    if (sentiment === "negative") return `<span class="sent-badge sent-neg" title="악재">악재</span>`;
    return "";
}

// JS측 휴리스틱 (검색 페이지 등 백엔드 sentiment 없는 뉴스용)
const POS_KW_JS = ["신고가","사상최고","사상 최고","최고가","신고치","최대치","신기록","상승","급등","강세","반등","돌파","회복","흑자","호조","호실적","어닝서프라이즈","수주","신제품","출시","합병","인수","제휴","매수의견","매수 의견","추천","호평","긍정","낙관","상향","호재","수혜","쾌거"];
const NEG_KW_JS = ["하락","급락","약세","최저가","신저가","적자","부진","어닝쇼크","손실","감소","리스크","위기","우려","부정","비관","논란","소송","제재","조사","리콜","구조조정","파산","부도","워크아웃","상장폐지","거래정지","하향","매도의견","악재","쇼크","충격","실패","지연","중단","차질","타격"];

function classifySentimentJS(text) {
    if (!text) return "neutral";
    let pos = 0, neg = 0;
    for (const k of POS_KW_JS) if (text.indexOf(k) >= 0) pos++;
    for (const k of NEG_KW_JS) if (text.indexOf(k) >= 0) neg++;
    // 부정문(악재 해소 등)은 호재 가산
    if (/우려.{0,4}해소|리스크.{0,4}(해소|완화)|악재.{0,4}해소|부진.{0,4}탈출|적자.{0,4}탈출/.test(text)) pos += 2;
    const score = pos - neg;
    if (score >= 2) return "positive";
    if (score <= -2) return "negative";
    return "neutral";
}

// 종목 코드 → sentiment 카운트 캐시 (data.json.news_by_stock에서 lookup)
function getSentimentForCode(code) {
    const nbs = state.data && state.data.news_by_stock;
    if (!nbs) return null;
    const found = nbs.find(s => s.code === code);
    if (!found) return null;
    return { pos: found.sentiment_pos || 0, neg: found.sentiment_neg || 0, neu: found.sentiment_neu || 0 };
}

/** 기술적 지표 종합 라벨 — 미니 시그널과 같은 형식.
 * @param {Object} tech - calcTechnicals 결과
 * @returns {{label, cls, score, signals: Array}} 라벨 + 매수/매도 신호 개수 */
function summarizeTechnicals(tech) {
    if (!tech) return null;
    let buyCount = 0, sellCount = 0;
    const signals = [];

    if (tech.rsi14 !== null) {
        if (tech.rsi14 <= 30) { buyCount++; signals.push("RSI 저가권"); }
        else if (tech.rsi14 >= 70) { sellCount++; signals.push("RSI 과열"); }
    }
    if (tech.goldenCross) { buyCount++; signals.push("골든크로스"); }
    if (tech.deadCross) { sellCount++; signals.push("데드크로스"); }
    if (tech.lowBounce) { buyCount++; signals.push("바닥 반등"); }
    if (tech.divergence20 !== null) {
        if (tech.divergence20 <= -10) { buyCount++; signals.push("평균선 이탈"); }
        else if (tech.divergence20 >= 15) { sellCount++; signals.push("단기 과열"); }
    }

    const net = buyCount - sellCount;
    let label, cls;
    if (net >= 2) { label = "매수 신호 강함"; cls = "signal-strong-buy"; }
    else if (net === 1) { label = "매수 신호"; cls = "signal-buy"; }
    else if (net === 0 && buyCount === 0 && sellCount === 0) { label = "중립"; cls = "signal-neutral"; }
    else if (net === 0) { label = "혼조"; cls = "signal-caution"; }
    else if (net === -1) { label = "매도 신호"; cls = "signal-sell"; }
    else { label = "매도 신호 강함"; cls = "signal-strong-sell"; }

    return { label, cls, buyCount, sellCount, signals };
}

/** 종목의 핵심 기술적 지표 한 줄 요약 (RSI + 발생 이벤트).
 * 모든 종목 카드/행에 컴팩트하게 추가 가능. */
/** 종목 코드 → 업종명 lookup */
function getIndustry(code) {
    if (!state.stocks) return "";
    const s = state.stocks.find(x => x.code === code);
    return (s && s.industry) || "";
}

/** 종목 옆 작은 업종 뱃지 */
function industryBadgeHTML(code) {
    const ind = getIndustry(code);
    if (!ind) return "";
    return `<span class="industry-badge" title="${escapeHtml(ind)}">${escapeHtml(ind)}</span>`;
}

/** 종목 코드 → 60일 시세 배열 lookup (캐시 → API 응답 직접 전달 우선) */
function _getPrices60dForCode(code, override) {
    if (override && override.length >= 5) return override;
    const cached = state.data && state.data.flow && state.data.flow.by_code && state.data.flow.by_code[code];
    return cached && cached.prices_60d && cached.prices_60d.length >= 5 ? cached.prices_60d : null;
}

/** 기술적 지표 종합 뱃지 — 시장 분위기 뱃지와 같은 모양 (한 줄 컴팩트) */
function techBadgeHTML(code, opts = {}) {
    const prices = _getPrices60dForCode(code, opts.prices60d);
    if (!prices) {
        return `<span class="signal-mini signal-na ${opts.compact ? 'compact' : ''}">기술 지표 —</span>`;
    }
    const tech = calcTechnicals(prices);
    const sum = summarizeTechnicals(tech);
    if (!sum) return "";
    const compact = opts.compact ? "compact" : "";
    const tip = sum.signals.length > 0 ? sum.signals.join(" · ") : "특별한 시그널 없음";
    return `<span class="signal-mini ${sum.cls} ${compact}" title="${escapeHtml(tip)}">${sum.label}</span>`;
}

function techMiniHTML(code, opts = {}) {
    const prices = _getPrices60dForCode(code, opts.prices60d);
    if (!prices) return "";
    const t = calcTechnicals(prices);
    if (!t) return "";

    const parts = [];
    // RSI: 30 이하 = 매수 기회, 70 이상 = 매도 신호
    if (t.rsi14 !== null) {
        if (t.rsi14 <= 30) {
            parts.push(`<span class="tm-evt up" title="RSI ${Math.round(t.rsi14)} - 너무 많이 떨어진 상태. 저가에 들어갈 만한 자리로 자주 활용됩니다">🟢 매수 <span class="tm-why">RSI ${Math.round(t.rsi14)} 저가권</span></span>`);
        } else if (t.rsi14 >= 70) {
            parts.push(`<span class="tm-evt down" title="RSI ${Math.round(t.rsi14)} - 너무 많이 오른 상태. 단기 조정 가능성 있어 차익실현 고려">🔴 매도 <span class="tm-why">RSI ${Math.round(t.rsi14)} 과열</span></span>`);
        }
    }
    // 골든크로스 = 매수, 데드크로스 = 매도
    if (t.goldenCross) {
        parts.push(`<span class="tm-evt up" title="단기 평균선이 중기 평균선을 위로 뚫음. 추세가 상승으로 바뀌는 강한 매수 신호">🟢 매수 <span class="tm-why">평균선 위로 뚫음(골든)</span></span>`);
    }
    if (t.deadCross) {
        parts.push(`<span class="tm-evt down" title="단기 평균선이 중기 평균선을 아래로 뚫음. 추세가 하락으로 바뀌는 강한 매도 신호">🔴 매도 <span class="tm-why">평균선 아래로(데드)</span></span>`);
    }
    // 저점 반등 = 매수
    if (t.lowBounce) {
        parts.push(`<span class="tm-evt up" title="5일 동안 -7% 이상 떨어진 후 어제 +2% 이상 반등. 바닥에서 올라오기 시작하는 저점 매수 후보">🟢 매수 <span class="tm-why">바닥 반등</span></span>`);
    }
    // 이격도
    if (t.divergence20 !== null) {
        if (t.divergence20 <= -10) {
            parts.push(`<span class="tm-evt up" title="20일 평균보다 ${Math.abs(t.divergence20)}% 낮음. 평균으로 돌아갈 가능성(저점 매수)">🟢 매수 <span class="tm-why">평균보다 ${Math.abs(t.divergence20).toFixed(0)}% 낮음</span></span>`);
        } else if (t.divergence20 >= 15) {
            parts.push(`<span class="tm-evt down" title="20일 평균보다 ${t.divergence20}% 높음. 단기 과열 → 차익실현 고려">🔴 매도 <span class="tm-why">평균보다 +${t.divergence20.toFixed(0)}% 높음</span></span>`);
        }
    }
    if (parts.length === 0) return "";
    return `<span class="tech-mini">${parts.join("")}</span>`;
}

/** 60일 시세 기반 1주·2주 통계 신뢰구간을 작게 표시. 시세 부족 시 빈 문자열. */
function forecastMiniHTML(code, opts = {}) {
    const prices = _getPrices60dForCode(code, opts.prices60d);
    if (!prices || prices.length < 20) return "";
    const currentPrice = prices[0] && prices[0].close;
    if (!currentPrice) return "";
    const f = calcForecast(prices, currentPrice, opts);
    if (!f) return "";
    function line(label, r) {
        const expCls = r.ret_pct >= 0 ? "up" : "down";
        const expSign = r.ret_pct >= 0 ? "+" : "";
        const lowSign = r.lower_pct >= 0 ? "+" : "";
        return `<div class="fc-mini-line" title="${label} 95% 신뢰구간 · 일일 σ ±${f.dailySdPct}% / μ ${f.dailyMeanPct >= 0 ? '+' : ''}${f.dailyMeanPct}%"><span class="fc-mini-label">${label}</span><span class="fc-mini-exp ${expCls}">${expSign}${r.ret_pct}%</span><span class="fc-mini-range">${lowSign}${r.lower_pct}% ~ +${r.upper_pct}%</span></div>`;
    }
    const gradeMap = {
        stable: { label: "안정", cls: "fc-grade-stable" },
        caution: { label: "주의", cls: "fc-grade-caution" },
        limited: { label: "표본부족", cls: "fc-grade-limited" },
        uncertain: { label: "불확실", cls: "fc-grade-uncertain" },
    };
    const g = gradeMap[f.grade] || gradeMap.stable;
    const tooltip = [...(f.warnings || []), ...(f.reasons || [])].join("\n");
    const badge = `<span class="fc-grade ${g.cls}" title="${escapeHtml(tooltip || '안정')}">${g.label}</span>`;
    return `<div class="fc-mini">${badge}${line("1주", f.oneWeek)}${line("2주", f.twoWeek)}</div>`;
}

/** 5일 수급 데이터를 캐시에서 가져와 시그널 뱃지 HTML 반환.
 * 캐시에 없으면 빈 자리(나중에 lazy-load는 호출자가 알아서). */
function signalBadgeHTML(code, opts = {}) {
    const cached = state.data && state.data.flow && state.data.flow.by_code && state.data.flow.by_code[code];
    if (!cached || !cached.days || cached.days.length === 0) {
        return `<span class="signal-mini signal-na">매매 신호 —</span>`;
    }
    const sent = getSentimentForCode(code);
    const sig = calcSignal(cached.days, sent, cached.prices_60d);
    const compact = opts.compact ? "compact" : "";
    return `<span class="signal-mini ${sig.cls} ${compact}" title="${escapeHtml(sig.reasons.join(' · '))}">${sig.label}</span>`;
}

// ============ 라우팅 ============
function parseHash() {
    const hash = window.location.hash.replace(/^#/, "");
    const [view, query] = hash.split("?");
    const params = new URLSearchParams(query || "");
    return { view: view || "top30", params };
}

function setHash(view, params) {
    const qs = params ? new URLSearchParams(params).toString() : "";
    const newHash = qs ? `#${view}?${qs}` : `#${view}`;
    if (window.location.hash !== newHash) {
        window.location.hash = newHash;
    } else {
        render();
    }
}

function render() {
    const { view, params } = parseHash();
    state.currentView = view;
    // 사이드바 active
    document.querySelectorAll(".sidebar-menu li").forEach(li => {
        const matchView = li.dataset.view === view;
        const matchDate = !li.dataset.date || li.dataset.date === params.get("date");
        li.classList.toggle("active", matchView && matchDate);
    });
    // 매수 추천 하위 메뉴는 history 뷰일 때 자동 펼침
    if (view === "recommend-history") {
        const sub = document.getElementById("recommend-history-list");
        const btn = document.querySelector(".has-sub .menu-toggle");
        if (sub) sub.hidden = false;
        if (btn) { btn.setAttribute("aria-expanded", "true"); btn.textContent = "▴"; }
    }
    const main = document.getElementById("view");
    if (view === "top30") renderTop30(main);
    else if (view === "news") {
        if (params.get("kw")) renderKeywordDetail(main, params.get("kw"));
        else renderNewsKeywords(main);
    }
    else if (view === "recommend") renderRecommendBuy(main);
    else if (view === "recommend-history") renderRecommendHistory(main, params.get("date"));
    else if (view === "flow") renderFlow(main, params.get("kind") || "foreign_top");
    else if (view === "sbsbiz") renderSbsBiz(main);
    else if (view === "backtest") renderBacktest(main);
    else if (view === "favorites") renderFavorites(main);
    else if (view === "search") renderSearchResult(main, params.get("code"));
    else renderTop30(main);
}

// ============ 뷰: TOP 50 ============
function renderTop30(main) {
    const data = state.data;
    if (!data) { main.innerHTML = `<div class="placeholder">로딩 중...</div>`; return; }
    const top = data.top_stocks || [];
    const asOf = (top[0] && top[0].as_of) || data.generated_date || "";
    const html = `
        <h2>📊 오늘의 한국 주식 TOP 50</h2>
        <div class="subtitle">
            1~30위: 인기 검색(1등=30점, 30등=1점) + 뉴스 노출(건당 +15점) 합산 ·
            31~50위: 당일 거래량 상위에서 보충 ·
            <strong>기준일 ${escapeHtml(asOf)} 종가 기준</strong>
            ${data.generated_at ? ` · 수집 ${escapeHtml(data.generated_at)}` : ""}
        </div>
        <div class="card top30-card">
            <table class="top30-table">
                <thead>
                    <tr>
                        <th class="rk">#</th>
                        <th>종목</th>
                        <th>시장 분위기</th>
                        <th>기술적 지표</th>
                        <th>1·2주 통계 전망</th>
                        <th class="num">현재가</th>
                        <th class="num">전일 대비</th>
                        <th class="num">외국인</th>
                        <th class="num">기관</th>
                        <th class="num">개인</th>
                        <th>★</th>
                    </tr>
                </thead>
                <tbody>
                    ${top.map((s, i) => {
                        const ch = formatChangeFromBackend(s);
                        const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
                        const flow = state.data && state.data.flow && state.data.flow.by_code && state.data.flow.by_code[s.code];
                        const today = flow && flow.days && flow.days[0];
                        return `
                            <tr>
                                <td class="rk ${rankCls}">${i + 1}</td>
                                <td>
                                    <div class="name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)} ${industryBadgeHTML(s.code)}</div>
                                    <div class="meta"><span class="code">${s.code}</span> · 뉴스 ${s.news_count || 0}건 · 점수 ${s.total_score || 0}</div>
                                </td>
                                <td>${signalBadgeHTML(s.code, {compact: true})}</td>
                                <td>${techBadgeHTML(s.code, {compact: true})}${techMiniHTML(s.code) ? '<div class="cell-tech">' + techMiniHTML(s.code) + '</div>' : ''}</td>
                                <td>${forecastMiniHTML(s.code) || '<span class="signal-mini signal-na compact">—</span>'}</td>
                                <td class="num"><strong>${formatPrice(s.price)}</strong>원</td>
                                <td class="num ${ch.cls}">${ch.text}</td>
                                <td class="num ${today ? netCls(today.foreign_net) : 'muted'}">${today ? formatSignedQty(today.foreign_net) : '—'}</td>
                                <td class="num ${today ? netCls(today.organ_net) : 'muted'}">${today ? formatSignedQty(today.organ_net) : '—'}</td>
                                <td class="num ${today ? netCls(today.individual_net) : 'muted'}">${today ? formatSignedQty(today.individual_net) : '—'}</td>
                                <td class="fav-col">${favIconHTML(s.code)}</td>
                            </tr>
                        `;
                    }).join("")}
                </tbody>
            </table>
            <div class="flow-note">외국인 / 기관 / 개인 단위: 주식 수 (+ 순매수 / − 순매도)</div>
        </div>
    `;
    main.innerHTML = html;
}

// ============ 뷰: 뉴스 이슈별 ============
// ============ 뷰: 매수 추천 (시장 분위기 + 기술적 지표 둘 다 매수) ============
function renderRecommendBuy(main) {
    const data = state.data;
    const byCode = data && data.flow && data.flow.by_code;
    if (!data) {
        main.innerHTML = `<h2>🎯 매수 추천</h2><div class="placeholder">데이터 로딩 실패</div>`;
        return;
    }
    if (!byCode || Object.keys(byCode).length === 0) {
        main.innerHTML = `<h2>🎯 매수 추천</h2><div class="placeholder">기술 지표 계산용 시세 데이터를 받는 중입니다... <br><small>(잠시 후 자동 표시)</small></div>`;
        return;
    }

    // 시장 분위기 매수 클래스
    const buyMarket = new Set(["signal-strong-buy", "signal-buy", "signal-weak-buy"]);
    // 기술 지표 매수 클래스
    const buyTech = new Set(["signal-strong-buy", "signal-buy"]);
    // 시장 분위기 강도 순서 (정렬용)
    const marketRank = { "signal-strong-buy": 3, "signal-buy": 2, "signal-weak-buy": 1 };
    const techRank = { "signal-strong-buy": 2, "signal-buy": 1 };

    const candidates = [];
    for (const code in byCode) {
        const info = byCode[code];
        if (!info.days || info.days.length === 0) continue;
        const sig = calcSignal(info.days, getSentimentForCode(code));
        if (!buyMarket.has(sig.cls)) continue;
        const tech = info.prices_60d && info.prices_60d.length >= 5 ? calcTechnicals(info.prices_60d) : null;
        const techSum = summarizeTechnicals(tech);
        if (!techSum || !buyTech.has(techSum.cls)) continue;
        const today = info.days[0];
        const prev = (today.close || 0) - (today.change || 0);
        const ch_pct = prev > 0 ? (today.change / prev * 100) : 0;
        candidates.push({
            code,
            name: info.name || code,
            close: today.close,
            change: today.change,
            change_pct: ch_pct,
            foreign_net: today.foreign_net,
            organ_net: today.organ_net,
            individual_net: today.individual_net,
            sig,
            techSum,
            tech,
            rankScore: (marketRank[sig.cls] || 0) * 3 + (techRank[techSum.cls] || 0),
            days: info.days,
        });
    }
    candidates.sort((a, b) => b.rankScore - a.rankScore);

    main.innerHTML = `
        <h2>🎯 매수 추천 (둘 다 매수 신호)</h2>
        <div class="subtitle">
            <strong>시장 분위기 = 매수 우위</strong> 그리고 <strong>기술 지표 = 매수 신호</strong>인 종목만.
            추적 풀 ${Object.keys(byCode).length}개 중 ${candidates.length}개 매칭 · 강한 신호 순 정렬 ·
            <span class="disclaimer">* 단순 휴리스틱 참고용, 투자 권유 아님</span>
        </div>
        ${candidates.length === 0 ? `
            <div class="placeholder" style="padding:60px;text-align:center">
                현재 두 신호 모두 매수인 종목이 없습니다.<br>
                다음 데이터 갱신 시 다시 확인해보세요.
            </div>
        ` : `
            <div class="rec-grid">
                ${candidates.map((c, i) => {
                    const ch = formatChange(c.change, c.change_pct);
                    return `
                        <article class="card rec-card" onclick="goSearch('${c.code}')">
                            <header class="rec-head">
                                <span class="rec-rank">${i + 1}</span>
                                <div class="rec-name-block">
                                    <span class="rec-name">${escapeHtml(c.name)}</span>
                                    <span class="rec-code">${c.code}</span>
                                    ${industryBadgeHTML(c.code)}
                                </div>
                                ${favIconHTML(c.code)}
                            </header>
                            <div class="rec-price-row">
                                <div class="rec-now">${formatPrice(c.close)}원</div>
                                <div class="rec-change ${ch.cls}">${ch.text}</div>
                            </div>
                            <div class="rec-chart">${chartHTML(c.days, {width: 260, height: 70})}</div>
                            <div class="rec-signals">
                                <div class="rec-sig-line">
                                    <span class="rec-sig-label">📈 시장</span>
                                    <span class="signal-mini ${c.sig.cls} compact">${c.sig.label}</span>
                                </div>
                                <ul class="rec-sig-reasons">
                                    ${(c.sig.reasons || []).slice(0, 4).map(r => `<li>${escapeHtml(r)}</li>`).join("")}
                                </ul>
                                <div class="rec-sig-line">
                                    <span class="rec-sig-label">📐 기술</span>
                                    <span class="signal-mini ${c.techSum.cls} compact">${c.techSum.label}</span>
                                </div>
                                <ul class="rec-sig-reasons">
                                    ${(c.techSum.signals || []).map(r => `<li>${escapeHtml(r)}</li>`).join("")}
                                    ${(c.techSum.signals || []).length === 0 ? `<li class="muted">특별한 시그널 없음</li>` : ""}
                                </ul>
                                ${forecastMiniHTML(c.code) ? `<div class="rec-forecast">${forecastMiniHTML(c.code)}</div>` : ''}
                            </div>
                            <div class="rec-flow">
                                <span class="rec-flow-cell"><span class="rfl">외</span><span class="${netCls(c.foreign_net)}">${formatSignedQty(c.foreign_net)}</span></span>
                                <span class="rec-flow-cell"><span class="rfl">기</span><span class="${netCls(c.organ_net)}">${formatSignedQty(c.organ_net)}</span></span>
                                <span class="rec-flow-cell"><span class="rfl">개</span><span class="${netCls(c.individual_net)}">${formatSignedQty(c.individual_net)}</span></span>
                            </div>
                        </article>
                    `;
                }).join("")}
            </div>
        `}
    `;
}

// ============ 매수 추천 일별 추적 ============
function populateRecommendHistoryMenu() {
    const ul = document.getElementById("recommend-history-list");
    if (!ul) return;
    const bh = state.buyHistory;
    const dates = bh && bh.by_date ? Object.keys(bh.by_date).sort().reverse() : [];
    if (dates.length === 0) {
        ul.innerHTML = `<li class="submenu-empty">스냅샷 없음 (다음 갱신 후 생성)</li>`;
        return;
    }
    ul.innerHTML = dates.map(d => {
        const cnt = (bh.by_date[d].stocks || []).length;
        return `<li data-view="recommend-history" data-date="${d}"><span class="sub-date">${d}</span><span class="sub-count">${cnt}개</span></li>`;
    }).join("");
}

function toggleRecommendHistory(btn) {
    const sub = document.getElementById("recommend-history-list");
    if (!sub) return;
    const open = sub.hidden;
    sub.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "▴" : "▾";
}
window.toggleRecommendHistory = toggleRecommendHistory;

/** 추천 시점부터 현재까지 실제 종가선 + 추천 시점의 forecast 곡선(상한/기대/하한) 비교 차트 */
function trendChartHTML(prices60d, snapshotDate, snapshotPrice, forecast, opts = {}) {
    const w = opts.width || 560;
    const h = opts.height || 200;
    const padL = 44, padR = 14, padT = 14, padB = 30;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // 추천일 이후 종가 추출 (prices_60d는 최신→과거)
    const ordered = [...(prices60d || [])].reverse();  // 과거→최신
    const after = ordered.filter(d => d.date && d.date >= snapshotDate);
    if (after.length < 1 || !snapshotPrice) {
        return `<div class="trend-chart-empty">추천일 이후 시세 데이터 없음</div>`;
    }
    // 추천일이 데이터에 정확히 없으면 가장 가까운 첫 날을 day0로
    const day0Date = after[0].date;

    // forecast 곡선 생성: t일 후 가격 = snapshotPrice × exp(mu·t ± 1.96·sigma·√t)
    // t는 영업일 기준. 차트의 X축은 인덱스(0=추천일, 1=다음 거래일, ...). 표시 범위: 추천일 ~ max(현재, 추천일+10)
    const mu = forecast && typeof forecast.mu_daily === "number" ? forecast.mu_daily
        : (forecast && forecast.dailyMeanPct ? forecast.dailyMeanPct / 100 : 0);
    const sigma = forecast && typeof forecast.sigma_daily === "number" ? forecast.sigma_daily
        : (forecast && forecast.dailySdPct ? forecast.dailySdPct / 100 : 0);

    const maxT = Math.max(after.length - 1, 10);  // 적어도 2주(10거래일)까지는 forecast 보여줌
    const xCount = maxT + 1;

    function fcAt(t) {
        if (sigma === 0 && mu === 0) return null;
        const expected = snapshotPrice * Math.exp(mu * t);
        const sig = sigma * Math.sqrt(t);
        return {
            expected,
            upper: snapshotPrice * Math.exp(mu * t + 1.96 * sig),
            lower: snapshotPrice * Math.exp(mu * t - 1.96 * sig),
        };
    }

    // Y 범위 계산
    let ymin = Infinity, ymax = -Infinity;
    for (let t = 0; t <= maxT; t++) {
        const f = fcAt(t);
        if (f) {
            ymin = Math.min(ymin, f.lower); ymax = Math.max(ymax, f.upper);
        }
    }
    for (const d of after) {
        ymin = Math.min(ymin, d.close); ymax = Math.max(ymax, d.close);
    }
    ymin = Math.min(ymin, snapshotPrice); ymax = Math.max(ymax, snapshotPrice);
    if (!isFinite(ymin) || !isFinite(ymax)) return `<div class="trend-chart-empty">시세 데이터 부족</div>`;
    const range = (ymax - ymin) || 1;
    const padRatio = 0.05;
    ymin -= range * padRatio; ymax += range * padRatio;

    const stepX = xCount > 1 ? innerW / (xCount - 1) : innerW;
    function xpos(t) { return padL + t * stepX; }
    function ypos(price) { return padT + (1 - (price - ymin) / (ymax - ymin)) * innerH; }

    // forecast 곡선 path
    let pathExp = "", pathUp = "", pathLo = "";
    for (let t = 0; t <= maxT; t++) {
        const f = fcAt(t);
        if (!f) continue;
        const xe = xpos(t), ye = ypos(f.expected), yu = ypos(f.upper), yl = ypos(f.lower);
        pathExp += `${t === 0 ? "M" : "L"}${xe.toFixed(1)},${ye.toFixed(1)} `;
        pathUp += `${t === 0 ? "M" : "L"}${xe.toFixed(1)},${yu.toFixed(1)} `;
        pathLo += `${t === 0 ? "M" : "L"}${xe.toFixed(1)},${yl.toFixed(1)} `;
    }

    // 신뢰구간 영역
    let areaPath = "";
    for (let t = 0; t <= maxT; t++) {
        const f = fcAt(t);
        if (!f) continue;
        areaPath += `${t === 0 ? "M" : "L"}${xpos(t).toFixed(1)},${ypos(f.upper).toFixed(1)} `;
    }
    for (let t = maxT; t >= 0; t--) {
        const f = fcAt(t);
        if (!f) continue;
        areaPath += `L${xpos(t).toFixed(1)},${ypos(f.lower).toFixed(1)} `;
    }
    areaPath += "Z";

    // 실제 종가 선
    let actualPath = "";
    after.forEach((d, i) => {
        const x = xpos(i), y = ypos(d.close);
        actualPath += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
    });

    // 마지막 실제값 위치 (vs 예측)
    const lastIdx = after.length - 1;
    const lastPrice = after[lastIdx].close;
    const fLast = fcAt(lastIdx);
    let verdict = { label: "—", cls: "verdict-neutral" };
    if (fLast) {
        if (lastPrice > fLast.upper) verdict = { label: "🚀 상한 초과", cls: "verdict-up" };
        else if (lastPrice < fLast.lower) verdict = { label: "⚠ 하한 이탈", cls: "verdict-down" };
        else if (lastPrice >= fLast.expected) verdict = { label: "✓ 기대선 위", cls: "verdict-up" };
        else verdict = { label: "✓ 신뢰구간 안", cls: "verdict-neutral" };
    }
    const retPct = snapshotPrice > 0 ? ((lastPrice - snapshotPrice) / snapshotPrice * 100) : 0;
    const retCls = retPct >= 0 ? "up" : "down";
    const retSign = retPct >= 0 ? "+" : "";

    // Y축 눈금 (5단계)
    const yTicks = [];
    for (let i = 0; i <= 4; i++) {
        const v = ymin + (ymax - ymin) * (i / 4);
        yTicks.push({ y: ypos(v), label: Math.round(v).toLocaleString("ko-KR") });
    }
    // X축 눈금: 시작·중간·끝
    const xTicks = [];
    if (after.length >= 1) {
        xTicks.push({ t: 0, label: day0Date.slice(5) });
        if (lastIdx >= 4) xTicks.push({ t: Math.floor(lastIdx / 2), label: after[Math.floor(lastIdx / 2)].date.slice(5) });
        if (lastIdx >= 1) xTicks.push({ t: lastIdx, label: after[lastIdx].date.slice(5) });
    }

    return `
        <div class="trend-verdict">
            <span class="verdict-pill ${verdict.cls}">${verdict.label}</span>
            <span class="trend-ret ${retCls}">${retSign}${retPct.toFixed(2)}%</span>
            <span class="trend-meta">추천가 ${formatPrice(snapshotPrice)} → 현재 ${formatPrice(lastPrice)}</span>
        </div>
        <svg class="trend-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-width:${w}px;height:auto;">
            ${yTicks.map(t => `<line x1="${padL}" x2="${w - padR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="#eef0f4" stroke-width="1"/><text x="${padL - 6}" y="${(t.y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#888">${t.label}</text>`).join("")}
            <path d="${areaPath}" fill="rgba(255, 152, 0, 0.10)" stroke="none"/>
            <path d="${pathUp}" fill="none" stroke="#ff9800" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>
            <path d="${pathLo}" fill="none" stroke="#ff9800" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>
            <path d="${pathExp}" fill="none" stroke="#ff9800" stroke-width="1.5" stroke-dasharray="5,3"/>
            <path d="${actualPath}" fill="none" stroke="#1565c0" stroke-width="2" stroke-linejoin="round"/>
            <circle cx="${xpos(lastIdx).toFixed(1)}" cy="${ypos(lastPrice).toFixed(1)}" r="3.5" fill="#1565c0"/>
            ${xTicks.map(t => `<text x="${xpos(t.t).toFixed(1)}" y="${h - padB + 14}" text-anchor="middle" font-size="9" fill="#888">${t.label}</text>`).join("")}
        </svg>
        <div class="trend-legend">
            <span><span class="lg-line lg-actual"></span> 실제 종가</span>
            <span><span class="lg-line lg-expected"></span> 기대 (μ)</span>
            <span><span class="lg-line lg-band"></span> 95% 신뢰구간</span>
        </div>
    `;
}

async function renderRecommendHistory(main, dateStr) {
    const bh = state.buyHistory;
    if (!bh || !bh.by_date || Object.keys(bh.by_date).length === 0) {
        main.innerHTML = `
            <h2>🎯 매수 추천 — 일별 트렌드</h2>
            <div class="placeholder">
                아직 누적된 스냅샷이 없습니다.<br>
                다음 데이터 갱신부터 매수 추천 종목이 일별로 기록되기 시작합니다.
            </div>`;
        return;
    }
    const dates = Object.keys(bh.by_date).sort().reverse();
    const date = dateStr && bh.by_date[dateStr] ? dateStr : dates[0];
    const snap = bh.by_date[date];
    const byCode = state.data && state.data.flow && state.data.flow.by_code;

    main.innerHTML = `
        <h2>🎯 매수 추천 — ${date} 트렌드 추적</h2>
        <div class="subtitle">
            그날 매수 추천된 ${snap.stocks.length}개 종목의 실제 흐름 ·
            추천 시점 통계 신뢰구간(95%)과 비교 · 스냅샷 시각 ${snap.snapshot_at}
        </div>
        ${(!byCode || Object.keys(byCode).length === 0) ? `
            <div class="placeholder">시세 데이터 로딩 중... (잠시 후 표시)</div>
        ` : (snap.stocks.length === 0 ? `
            <div class="placeholder">이 날짜에는 매수 추천 후보가 없었습니다.</div>
        ` : `
            <div class="trend-list">
                ${snap.stocks.map(s => {
                    const live = byCode[s.code];
                    const prices = live && live.prices_60d;
                    const chart = (prices && prices.length)
                        ? trendChartHTML(prices, date, s.price, s.forecast)
                        : `<div class="trend-chart-empty">시세 데이터 없음</div>`;
                    return `
                        <article class="card trend-card">
                            <header class="trend-head">
                                <div class="trend-name-block">
                                    <span class="trend-name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)}</span>
                                    <span class="trend-code">${s.code}</span>
                                    ${industryBadgeHTML(s.code)}
                                </div>
                                <div class="trend-snapshot">
                                    추천 시그널: <strong>${escapeHtml(s.signal)}</strong> · 기술: <strong>${escapeHtml(s.tech)}</strong>
                                </div>
                                ${favIconHTML(s.code)}
                            </header>
                            <div class="trend-body">${chart}</div>
                        </article>
                    `;
                }).join("")}
            </div>
        `)}
    `;
}

function renderNewsKeywords(main) {
    const data = state.data;
    if (!data) { main.innerHTML = `<div class="placeholder">로딩 중...</div>`; return; }
    const stocks = data.news_by_stock || [];
    if (!stocks.length) {
        main.innerHTML = `<h2>📰 뉴스 이슈별 주식 추천</h2><div class="placeholder">뉴스 매칭 종목이 없습니다.</div>`;
        return;
    }

    main.innerHTML = `
        <h2>📰 뉴스 이슈별 주식 추천</h2>
        <div class="subtitle">뉴스에 가장 많이 언급된 종목 순 · 시세·수급·뉴스를 함께 표시 · 기준일 ${escapeHtml(stocks[0].as_of || data.generated_date || "")}</div>
        <div class="snc-grid">
            ${stocks.map((s, i) => {
                const ch = formatChange(s.change, s.change_pct);
                const hasFlow = s.foreign_net !== 0 || s.organ_net !== 0 || s.individual_net !== 0;
                return `
                    <article class="card snc-card">
                        <header class="snc-head">
                            <div class="snc-rank">${i + 1}</div>
                            <div class="snc-name-block">
                                <div class="snc-name-line">
                                    <span class="snc-name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)}</span>
                                    <span class="snc-code">${s.code}</span>
                                </div>
                                ${industryBadgeHTML(s.code) ? `<div class="snc-industry-line">${industryBadgeHTML(s.code)}</div>` : ""}
                            </div>
                            <div class="snc-badge">📰 ${s.news_count}건</div>
                            ${favIconHTML(s.code)}
                        </header>
                        <div class="snc-signal-row">
                            <div class="snc-sig-block">
                                <span class="snc-sig-label">시장 분위기</span>
                                ${signalBadgeHTML(s.code)}
                            </div>
                            <div class="snc-sig-block">
                                <span class="snc-sig-label">기술적 지표</span>
                                ${techBadgeHTML(s.code)}
                                ${techMiniHTML(s.code) ? `<div class="snc-tech-mini">${techMiniHTML(s.code)}</div>` : ""}
                            </div>
                        </div>
                        ${forecastMiniHTML(s.code) ? `
                        <div class="snc-forecast">
                            <span class="snc-sig-label">📅 1·2주 통계 전망</span>
                            ${forecastMiniHTML(s.code)}
                        </div>` : ""}
                        <div class="snc-price-block">
                            <div class="snc-now">
                                <span class="label">현재가</span>
                                <span class="value">${s.price ? formatPrice(s.price) + "원" : "—"}</span>
                            </div>
                            <div class="snc-prev">
                                <span class="label">전일</span>
                                <span class="value">${s.prev_close ? formatPrice(s.prev_close) + "원" : "—"}</span>
                            </div>
                            <div class="snc-change ${ch.cls}">${ch.text}</div>
                        </div>
                        ${hasFlow ? `
                            <div class="snc-flow">
                                <div class="flow-row">
                                    <span class="flow-label">🌍 외국인</span>
                                    <span class="flow-value ${netCls(s.foreign_net)}">${formatSignedQty(s.foreign_net)}</span>
                                </div>
                                <div class="flow-row">
                                    <span class="flow-label">🏦 기관</span>
                                    <span class="flow-value ${netCls(s.organ_net)}">${formatSignedQty(s.organ_net)}</span>
                                </div>
                                <div class="flow-row">
                                    <span class="flow-label">👤 개인</span>
                                    <span class="flow-value ${netCls(s.individual_net)}">${formatSignedQty(s.individual_net)}</span>
                                </div>
                            </div>
                        ` : `<div class="snc-flow snc-flow-empty">수급 데이터 없음</div>`}
                        <div class="snc-news">
                            <div class="snc-news-title">
                                📄 관련 뉴스 ${s.news.length}건
                                ${s.sentiment_pos > 0 ? `<span class="sent-count sent-pos">호재 ${s.sentiment_pos}</span>` : ""}
                                ${s.sentiment_neg > 0 ? `<span class="sent-count sent-neg">악재 ${s.sentiment_neg}</span>` : ""}
                            </div>
                            ${(s.news || []).map(n => `
                                <a class="snc-news-item" href="${escapeHtml(n.link)}" target="_blank" rel="noopener" title="${escapeHtml(n.title)}">
                                    ${sentBadgeHTML(n.sentiment)}
                                    ${n.matched_keyword ? `<span class="kw-tag">${escapeHtml(n.matched_keyword)}</span>` : ""}
                                    <span class="news-title-text">${escapeHtml(n.title)}</span>
                                </a>
                            `).join("")}
                        </div>
                    </article>
                `;
            }).join("")}
        </div>
    `;
}

function renderKeywordDetail(main, keyword) {
    const data = state.data;
    if (!data) { main.innerHTML = `<div class="placeholder">로딩 중...</div>`; return; }
    const g = (data.news_by_keyword || []).find(x => x.keyword === keyword);
    if (!g) {
        main.innerHTML = `<div class="placeholder">키워드를 찾을 수 없습니다.</div>`;
        return;
    }
    const html = `
        <div class="kw-detail">
            <span class="back" onclick="goView('news')">← 뉴스 이슈 목록</span>
            <h2>📰 ${escapeHtml(keyword)}</h2>
            <div class="subtitle">뉴스 ${g.news_count}건 · 관련 종목 ${g.top_stocks.length}개</div>

            <div class="kw-section">
                <h3>🏢 관련 종목 (뉴스 등장 빈도순)</h3>
                <div class="card">
                    ${g.top_stocks.map((s, i) => `
                        <div class="stock-row">
                            <div class="rank">${i + 1}</div>
                            <div>
                                <div class="name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)}</div>
                                <div class="meta"><span class="code">${s.code}</span></div>
                            </div>
                            <div class="price">${s.count}건</div>
                            <div></div>
                        </div>
                    `).join("")}
                </div>
            </div>

            <div class="kw-section">
                <h3>📄 관련 뉴스</h3>
                <div class="card">
                    ${g.news.map(n => `
                        <div class="news-item">
                            <div class="title"><a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a></div>
                            ${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ""}
                            <div class="meta">
                                ${n.pubDate ? `<span>${escapeHtml(n.pubDate)}</span>` : ""}
                                ${(n.matched_stocks || []).map(ms =>
                                    `<span class="stock-link" onclick="goSearch('${ms.code}')">${escapeHtml(ms.name)}</span>`
                                ).join("")}
                            </div>
                        </div>
                    `).join("")}
                </div>
            </div>
        </div>
    `;
    main.innerHTML = html;
}

// ============ 수급(외국인/기관/개인) ============
function formatSignedQty(n) {
    n = Number(n) || 0;
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : "-";
    return sign + Math.abs(n).toLocaleString("ko-KR");
}
function netCls(n) {
    n = Number(n) || 0;
    if (n > 0) return "up";
    if (n < 0) return "down";
    return "flat";
}

function renderFlowTableForStock(flow) {
    const days = (flow && flow.days) || [];
    if (days.length === 0) {
        return `<div class="card placeholder" style="padding:24px">수급 데이터를 가져오지 못했습니다.</div>`;
    }
    return `
        <div class="card">
            <table class="flow-table">
                <thead>
                    <tr>
                        <th>날짜</th>
                        <th class="num">종가</th>
                        <th class="num">전일비</th>
                        <th class="num">외국인</th>
                        <th class="num">기관</th>
                        <th class="num">개인</th>
                        <th class="num">외인보유율</th>
                    </tr>
                </thead>
                <tbody>
                    ${days.map(d => {
                        const chCls = d.change > 0 ? "up" : d.change < 0 ? "down" : "flat";
                        const chTxt = d.change > 0 ? `+${formatPrice(d.change)}` : (d.change < 0 ? formatPrice(d.change) : "0");
                        return `
                            <tr>
                                <td>${escapeHtml(d.date)}</td>
                                <td class="num">${formatPrice(d.close)}</td>
                                <td class="num ${chCls}">${chTxt}</td>
                                <td class="num ${netCls(d.foreign_net)}">${formatSignedQty(d.foreign_net)}</td>
                                <td class="num ${netCls(d.organ_net)}">${formatSignedQty(d.organ_net)}</td>
                                <td class="num ${netCls(d.individual_net)}">${formatSignedQty(d.individual_net)}</td>
                                <td class="num muted">${escapeHtml(d.foreign_hold_ratio || "—")}</td>
                            </tr>
                        `;
                    }).join("")}
                </tbody>
            </table>
            <div class="flow-note">단위: 주식 수 (+ 순매수 / − 순매도)</div>
        </div>
    `;
}

// ============ 뷰: 수급 상위 ============
const FLOW_TABS = [
    { kind: "foreign_top", label: "외국인 순매수", color: "up", icon: "🌍" },
    { kind: "organ_top", label: "기관 순매수", color: "up", icon: "🏦" },
    { kind: "individual_top", label: "개인 순매수", color: "up", icon: "👤" },
    { kind: "both_top", label: "외인+기관 동반", color: "up", icon: "💎" },
    { kind: "foreign_sell", label: "외국인 순매도", color: "down", icon: "🌍" },
    { kind: "organ_sell", label: "기관 순매도", color: "down", icon: "🏦" },
    { kind: "individual_sell", label: "개인 순매도", color: "down", icon: "👤" },
];

/**
 * 일자별/항목별 수급 총량 막대 차트 (외인/기관/개인).
 * data.flow.by_code 전체를 일자별로 합산해 5일 그룹화 막대.
 */
function flowSummaryChartHTML(byCode) {
    if (!byCode || Object.keys(byCode).length === 0) return "";
    // {date -> {f, o, i}} 집계
    const byDate = {};
    for (const code in byCode) {
        const days = byCode[code].days || [];
        for (const d of days) {
            if (!d.date) continue;
            if (!byDate[d.date]) byDate[d.date] = { f: 0, o: 0, i: 0 };
            byDate[d.date].f += d.foreign_net || 0;
            byDate[d.date].o += d.organ_net || 0;
            byDate[d.date].i += d.individual_net || 0;
        }
    }
    const dates = Object.keys(byDate).sort();  // 과거 → 최신
    if (dates.length === 0) return "";

    const w = 720, h = 280;
    const padT = 30, padB = 40, padL = 70, padR = 20;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // 모든 값에서 최대 절댓값 산출 (Y축 스케일)
    let maxAbs = 0;
    dates.forEach(d => {
        ["f", "o", "i"].forEach(k => {
            const v = Math.abs(byDate[d][k]);
            if (v > maxAbs) maxAbs = v;
        });
    });
    if (maxAbs === 0) maxAbs = 1;
    const yMid = padT + innerH / 2;
    const yScale = (innerH / 2) / maxAbs;

    const groupW = innerW / dates.length;
    const barW = Math.min(20, groupW / 4);
    const gap = (groupW - barW * 3) / 2;

    const colors = { f: "#1565c0", o: "#2e7d32", i: "#ef6c00" };
    const labels = { f: "외국인", o: "기관", i: "개인" };

    // Y축 라벨 (단위: 만주 또는 백만주)
    const fmtY = (val) => {
        const a = Math.abs(val);
        if (a >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
        if (a >= 1_000) return (val / 1_000).toFixed(0) + "K";
        return val.toString();
    };

    let bars = "";
    let xLabels = "";
    let tooltips = "";
    dates.forEach((date, di) => {
        const gx = padL + groupW * di + gap;
        ["f", "o", "i"].forEach((k, ki) => {
            const v = byDate[date][k];
            const barH = Math.abs(v) * yScale;
            const x = gx + ki * barW;
            const y = v >= 0 ? yMid - barH : yMid;
            const title = `${date}\n${labels[k]}: ${v >= 0 ? "+" : ""}${v.toLocaleString("ko-KR")}`;
            bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${colors[k]}" opacity="0.85"><title>${escapeHtml(title)}</title></rect>`;
        });
        const md = date.length >= 10 ? date.slice(5).replace("-", "/") : date;
        xLabels += `<text x="${(padL + groupW * di + groupW / 2).toFixed(1)}" y="${h - 18}" text-anchor="middle" class="fsc-x-label">${md}</text>`;
    });

    // Y축 라벨
    const yLabels = [
        { val: maxAbs, y: padT + 4 },
        { val: maxAbs / 2, y: padT + innerH / 4 + 4 },
        { val: 0, y: yMid + 4 },
        { val: -maxAbs / 2, y: padT + (innerH * 3) / 4 + 4 },
        { val: -maxAbs, y: padT + innerH + 4 },
    ].map(l => `<text x="${padL - 8}" y="${l.y}" text-anchor="end" class="fsc-y-label">${fmtY(l.val)}</text>`).join("");

    // 가로 격자선
    const grid = [padT, padT + innerH / 4, yMid, padT + (innerH * 3) / 4, padT + innerH]
        .map(y => `<line x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" stroke="#e3e7f0" stroke-width="${y === yMid ? 1.5 : 1}" stroke-dasharray="${y === yMid ? '' : '2,2'}"/>`).join("");

    // 범례
    const legend = `
        <g transform="translate(${padL}, 6)">
            <rect x="0" y="0" width="14" height="10" fill="${colors.f}"/><text x="20" y="9" class="fsc-legend">외국인</text>
            <rect x="80" y="0" width="14" height="10" fill="${colors.o}"/><text x="100" y="9" class="fsc-legend">기관</text>
            <rect x="160" y="0" width="14" height="10" fill="${colors.i}"/><text x="180" y="9" class="fsc-legend">개인</text>
        </g>
    `;

    return `
        <div class="card flow-summary-card">
            <div class="fsc-title">📊 일자별 수급 총량 (추적 종목 풀 합산)</div>
            <svg class="flow-summary-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;">
                ${grid}
                ${legend}
                ${yLabels}
                ${bars}
                ${xLabels}
            </svg>
            <div class="fsc-note">단위: 주식 수. 양수 = 순매수, 음수 = 순매도. 막대 위 마우스 오버 시 정확한 값.</div>
        </div>
    `;
}

function renderFlow(main, kind) {
    const flow = state.data && state.data.flow;
    if (!flow) {
        main.innerHTML = `<h2>💰 수급 상위</h2><div class="placeholder">수급 데이터가 아직 없습니다. <code>run.bat</code> 실행 후 새로고침해주세요.</div>`;
        return;
    }
    const list = flow[kind] || [];
    const tab = FLOW_TABS.find(t => t.kind === kind) || FLOW_TABS[0];
    main.innerHTML = `
        <h2>💰 수급 상위</h2>
        <div class="subtitle">추적 종목 풀(인기 검색 + 카테고리 고정) ${flow.pool_size}개 기준 · 기준일 ${escapeHtml(flow.as_of || "—")}</div>
        ${flowSummaryChartHTML(flow.by_code)}
        <div class="flow-tabs">
            ${FLOW_TABS.map(t => `
                <button class="flow-tab ${t.kind === kind ? "active" : ""}" onclick="goFlow('${t.kind}')">
                    ${t.icon} ${t.label}
                </button>
            `).join("")}
        </div>
        ${list.length === 0
            ? `<div class="card placeholder" style="padding:30px">해당 항목 데이터가 없습니다.</div>`
            : `<div class="card">
                <table class="flow-rank-table">
                    <thead>
                        <tr>
                            <th class="rk">#</th>
                            <th>종목</th>
                            <th>시장 분위기</th>
                            <th>기술적 지표</th>
                            <th>1·2주 통계 전망</th>
                            <th class="num">현재가</th>
                            <th class="num">전일비</th>
                            <th class="num">외국인</th>
                            <th class="num">기관</th>
                            <th class="num">개인</th>
                            <th>★</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map((r, i) => {
                            const chCls = r.change > 0 ? "up" : r.change < 0 ? "down" : "flat";
                            const chTxt = r.change > 0 ? `+${formatPrice(r.change)}` : (r.change < 0 ? formatPrice(r.change) : "0");
                            return `
                                <tr>
                                    <td class="rk">${i + 1}</td>
                                    <td>
                                        <span class="stock-name" onclick="goSearch('${r.code}')">${escapeHtml(r.name)}</span>
                                        <span class="stock-code">${r.code}</span>
                                        ${industryBadgeHTML(r.code)}
                                    </td>
                                    <td>${signalBadgeHTML(r.code, {compact: true})}</td>
                                    <td>${techBadgeHTML(r.code, {compact: true})}${techMiniHTML(r.code) ? '<div class="cell-tech">' + techMiniHTML(r.code) + '</div>' : ''}</td>
                                    <td>${forecastMiniHTML(r.code) || '<span class="signal-mini signal-na compact">—</span>'}</td>
                                    <td class="num">${formatPrice(r.close)}</td>
                                    <td class="num ${chCls}">${chTxt}</td>
                                    <td class="num ${netCls(r.foreign_net)}">${formatSignedQty(r.foreign_net)}</td>
                                    <td class="num ${netCls(r.organ_net)}">${formatSignedQty(r.organ_net)}</td>
                                    <td class="num ${netCls(r.individual_net)}">${formatSignedQty(r.individual_net)}</td>
                                    <td>${favIconHTML(r.code)}</td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
                <div class="flow-note">단위: 주식 수 (+ 순매수 / − 순매도)</div>
            </div>`
        }
    `;
}

function goFlow(kind) { setHash("flow", { kind }); }
window.goFlow = goFlow;

// ============ 뷰: SBS Biz 추천 ============
function formatPublished(iso) {
    if (!iso) return "";
    try {
        const d = new Date(iso);
        if (isNaN(d)) return iso.slice(0, 10);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch (e) { return iso; }
}

// 시세 조회 캐시 (같은 코드를 여러 카드에서 쓰면 한 번만 호출)
const _priceCache = new Map();
function fetchStockCached(code) {
    if (_priceCache.has(code)) return _priceCache.get(code);
    const p = fetchJsonUtf8(`/api/stock?code=${code}`, { code, error: true });
    _priceCache.set(code, p);
    return p;
}

const _flowCache = new Map();
function fetchFlowCached(code) {
    if (_flowCache.has(code)) return _flowCache.get(code);
    const p = fetchJsonUtf8(`/api/flow?code=${code}`, { code, days: [] });
    _flowCache.set(code, p);
    return p;
}

/**
 * 1-2주 전망 — 일일 수익률 통계 기반 95% 신뢰구간.
 * @param {Array} prices60d - 최신 → 과거 순
 * @param {number} currentPrice - 현재가
 * @returns {Object|null} { oneWeek: {expected, lower, upper, ret_pct}, twoWeek: {...}, dailySdPct }
 */
/**
 * 1-2주 통계 신뢰구간. 다섯 가지 보정 포함:
 *  1) Historical VaR(정규성 가정 완화: 실제 분포의 2.5%/97.5% 분위수 50% 가중)
 *  2) 모멘텀 보정(최근 5일 수익률을 μ에 가중)
 *  3) RSI mean reversion(과열/과매도 시 μ 회귀 압력)
 *  4) 이벤트 리스크(실적 발표 D-7 이내면 σ × 1.5)
 *  5) 신뢰도 등급(stable/caution/limited/uncertain)
 * opts: { tech?, earningsDaysAway? }
 */
function calcForecast(prices60d, currentPrice, opts = {}) {
    if (!prices60d || prices60d.length < 20 || !currentPrice) return null;
    const ordered = [...prices60d].reverse();
    const returns = [];
    for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1].close;
        if (prev > 0) {
            returns.push(Math.log(ordered[i].close / prev));
        }
    }
    if (returns.length < 10) return null;

    const baseMean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const baseSd = Math.sqrt(returns.reduce((a, b) => a + (b - baseMean) ** 2, 0) / returns.length);

    // === 1. 모멘텀 보정: 60일 평균 0.6 + 최근 5일 평균 0.4 ===
    let muAdj = baseMean;
    if (returns.length >= 5) {
        const recent5 = returns.slice(-5);
        const recentMean = recent5.reduce((a, b) => a + b, 0) / recent5.length;
        muAdj = baseMean * 0.6 + recentMean * 0.4;
    }

    // === 2. RSI mean reversion ===
    const tech = opts.tech || calcTechnicals(prices60d);
    const rsi = tech ? tech.rsi14 : null;
    if (rsi !== null && rsi !== undefined) {
        if (rsi >= 70) {
            // 과열 → 회귀 압력. RSI 100이면 일일 -0.1%
            muAdj -= 0.001 * (rsi - 70) / 30;
        } else if (rsi <= 30) {
            // 과매도 → 반등 압력
            muAdj += 0.001 * (30 - rsi) / 30;
        }
    }

    // === 3. 이벤트 리스크: 실적 발표 D-7 이내면 σ × 1.5 ===
    let sdAdj = baseSd;
    const dE = opts.earningsDaysAway;
    if (dE !== undefined && dE !== null && dE >= 0 && dE <= 7) {
        sdAdj = baseSd * 1.5;
    }

    // === 4. Historical VaR: 1일 분포의 분위수 추출 (정규성 가정 완화) ===
    const sortedR = [...returns].sort((a, b) => a - b);
    function quantile(q) {
        const idx = q * (sortedR.length - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        if (lo === hi) return sortedR[lo];
        return sortedR[lo] + (sortedR[hi] - sortedR[lo]) * (idx - lo);
    }
    const r025 = quantile(0.025);
    const r975 = quantile(0.975);

    function rangeAt(days) {
        const muT = muAdj * days;
        const sigmaT = sdAdj * Math.sqrt(days);
        // 정규 모델 기반
        const lowNorm = muT - 1.96 * sigmaT;
        const upNorm = muT + 1.96 * sigmaT;
        // Historical VaR — √t 스케일링 (조잡하지만 보수적인 추정)
        const lowHist = (r025 - baseMean) * Math.sqrt(days) + muT;
        const upHist = (r975 - baseMean) * Math.sqrt(days) + muT;
        // 50:50 가중 평균
        const lower = (lowNorm + lowHist) / 2;
        const upper = (upNorm + upHist) / 2;
        const expected = Math.round(currentPrice * Math.exp(muT));
        return {
            expected,
            lower: Math.round(currentPrice * Math.exp(lower)),
            upper: Math.round(currentPrice * Math.exp(upper)),
            ret_pct: Math.round((expected / currentPrice - 1) * 1000) / 10,
            upper_pct: Math.round((Math.exp(upper) - 1) * 1000) / 10,
            lower_pct: Math.round((Math.exp(lower) - 1) * 1000) / 10,
        };
    }

    // === 5. 신뢰도 등급 ===
    let grade = "stable";
    const warnings = [];
    const reasons = [];
    if (returns.length < 30) {
        grade = "limited";
        warnings.push(`표본 ${returns.length}개 (충분치 않음)`);
    }
    // 변동성 안정성: 표본을 둘로 나눠 σ 비교
    const half = Math.floor(returns.length / 2);
    if (half >= 10) {
        const r1 = returns.slice(0, half);
        const r2 = returns.slice(half);
        const m1 = r1.reduce((a, b) => a + b, 0) / r1.length;
        const m2 = r2.reduce((a, b) => a + b, 0) / r2.length;
        const s1 = Math.sqrt(r1.reduce((a, b) => a + (b - m1) ** 2, 0) / r1.length);
        const s2 = Math.sqrt(r2.reduce((a, b) => a + (b - m2) ** 2, 0) / r2.length);
        if (s1 > 0) {
            const ratio = s2 / s1;
            if (ratio > 1.5 || ratio < 0.67) {
                if (grade === "stable") grade = "caution";
                warnings.push(`변동성 변화 ${(ratio).toFixed(2)}× (전반기 → 후반기)`);
            }
        }
    }
    if (dE !== undefined && dE !== null && dE >= 0 && dE <= 7) {
        grade = "uncertain";
        warnings.push(`실적 발표 D-${dE} (σ 1.5배 확장)`);
    }
    if (rsi !== null && rsi !== undefined) {
        if (rsi >= 75) reasons.push(`RSI ${rsi.toFixed(0)} 과열 → 회귀 압력 반영`);
        else if (rsi <= 25) reasons.push(`RSI ${rsi.toFixed(0)} 과매도 → 반등 압력 반영`);
    }
    if (Math.abs(muAdj - baseMean) > Math.abs(baseMean) * 0.5 + 0.0005) {
        reasons.push(`최근 5일 추세를 μ에 반영 (기본 ${(baseMean*100).toFixed(2)}% → 보정 ${(muAdj*100).toFixed(2)}%)`);
    }

    return {
        oneWeek: rangeAt(5),
        twoWeek: rangeAt(10),
        dailyMeanPct: Math.round(muAdj * 1000) / 10,
        dailySdPct: Math.round(sdAdj * 1000) / 10,
        sampleSize: returns.length,
        baseMeanPct: Math.round(baseMean * 1000) / 10,
        baseSdPct: Math.round(baseSd * 1000) / 10,
        grade,
        warnings,
        reasons,
        mu_daily: muAdj,
        sigma_daily: sdAdj,
    };
}

/**
 * 60일 종가 → 기술적 지표 산출.
 * @param {Array} prices60d - [{date, close, high, low, volume}, ...] 최신 → 과거 순
 * @returns {Object} - { rsi14, ma5, ma20, ma60, bbUpper, bbLower, divergence20, goldenCross, deadCross,
 *                       volSurge, lowBounce, summary: { label, score, reasons } }
 */
function calcTechnicals(prices60d) {
    if (!prices60d || prices60d.length < 5) return null;
    // closes: 과거 → 최신 순으로 뒤집기 (계산 편의)
    const ordered = [...prices60d].reverse();
    const closes = ordered.map(d => d.close);
    const volumes = ordered.map(d => d.volume);
    const n = closes.length;

    // 단순 이동평균
    function sma(arr, period, endIdx) {
        if (endIdx + 1 < period) return null;
        let sum = 0;
        for (let i = endIdx - period + 1; i <= endIdx; i++) sum += arr[i];
        return sum / period;
    }
    function sd(arr, period, endIdx, mean) {
        if (endIdx + 1 < period) return null;
        let s = 0;
        for (let i = endIdx - period + 1; i <= endIdx; i++) s += (arr[i] - mean) ** 2;
        return Math.sqrt(s / period);
    }

    const last = n - 1;
    const ma5 = sma(closes, 5, last);
    const ma20 = sma(closes, 20, last);
    const ma60 = n >= 60 ? sma(closes, 60, last) : null;
    const ma5_prev = sma(closes, 5, last - 1);
    const ma20_prev = sma(closes, 20, last - 1);

    // 볼린저밴드 (20일, 2 표준편차)
    let bbUpper = null, bbLower = null;
    if (ma20 !== null) {
        const sigma = sd(closes, 20, last, ma20);
        bbUpper = ma20 + 2 * sigma;
        bbLower = ma20 - 2 * sigma;
    }

    // 이격도 (현재가 vs 20일 평균)
    const divergence20 = ma20 ? ((closes[last] - ma20) / ma20 * 100) : null;

    // RSI 14일 (Wilder's smoothing)
    let rsi14 = null;
    if (n >= 15) {
        let gainSum = 0, lossSum = 0;
        for (let i = 1; i <= 14; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gainSum += diff;
            else lossSum += -diff;
        }
        let avgGain = gainSum / 14;
        let avgLoss = lossSum / 14;
        for (let i = 15; i < n; i++) {
            const diff = closes[i] - closes[i - 1];
            const g = diff > 0 ? diff : 0;
            const l = diff < 0 ? -diff : 0;
            avgGain = (avgGain * 13 + g) / 14;
            avgLoss = (avgLoss * 13 + l) / 14;
        }
        if (avgLoss === 0) rsi14 = 100;
        else {
            const rs = avgGain / avgLoss;
            rsi14 = 100 - 100 / (1 + rs);
        }
    }

    // 골든/데드 크로스 (5일선이 20일선 돌파)
    let goldenCross = false, deadCross = false;
    if (ma5 !== null && ma20 !== null && ma5_prev !== null && ma20_prev !== null) {
        goldenCross = ma5_prev <= ma20_prev && ma5 > ma20;
        deadCross = ma5_prev >= ma20_prev && ma5 < ma20;
    }

    // 거래량 급증 (오늘 거래량 > 20일 평균 거래량 × 2)
    let volSurge = false;
    const volMa20 = sma(volumes, 20, last);
    if (volMa20 && volumes[last] > volMa20 * 2) volSurge = true;

    // 저점 반등 시그널 (최근 5일 중 -7% 이상 하락 후 어제 ≥+2% 반등)
    let lowBounce = false;
    if (n >= 6) {
        const ret5 = (closes[last - 1] - closes[Math.max(0, last - 5)]) / closes[Math.max(0, last - 5)] * 100;
        const ret1 = (closes[last] - closes[last - 1]) / closes[last - 1] * 100;
        if (ret5 <= -7 && ret1 >= 2) lowBounce = true;
    }

    // 저항선/지지선 — 20일/60일 high/low
    const highs = ordered.map(d => d.high || d.close);
    const lows = ordered.map(d => d.low || d.close);
    function nMax(arr, period) {
        const k = Math.min(period, arr.length);
        return Math.max(...arr.slice(-k));
    }
    function nMin(arr, period) {
        const k = Math.min(period, arr.length);
        return Math.min(...arr.slice(-k));
    }
    const resist20 = nMax(highs, 20);
    const support20 = nMin(lows, 20);
    const resist60 = nMax(highs, 60);
    const support60 = nMin(lows, 60);

    // 현재가가 저항·지지선에 얼마나 가까운지 (퍼센트)
    const curr = closes[last];
    const distToResist20 = ((resist20 - curr) / curr * 100);
    const distToSupport20 = ((curr - support20) / curr * 100);

    return {
        rsi14: rsi14 !== null ? Math.round(rsi14 * 10) / 10 : null,
        ma5, ma20, ma60, bbUpper, bbLower,
        divergence20: divergence20 !== null ? Math.round(divergence20 * 10) / 10 : null,
        goldenCross, deadCross, volSurge, lowBounce,
        resist20, support20, resist60, support60,
        distToResist20: Math.round(distToResist20 * 10) / 10,
        distToSupport20: Math.round(distToSupport20 * 10) / 10,
        dataLength: n,
    };
}

/**
 * 시장 분위기 (단기 시장 동향) — 수급 + 뉴스 + 가격 모멘텀 기반.
 * 기술적 지표(RSI, 골든/데드 등)는 별도 calcTechnicals로 분리됨.
 *
 * @param {Array} flowDays - 5일 수급 데이터
 * @param {Object} [sentiment] - 옵션. { pos, neg, neu } 종목 관련 뉴스 호재/악재
 */
function calcSignal(flowDays, sentiment) {
    if (!flowDays || flowDays.length === 0) {
        return { label: "데이터 없음", cls: "signal-na", score: 0, reasons: [] };
    }
    let score = 0;
    const reasons = [];

    const fBuy = flowDays.filter(d => d.foreign_net > 0).length;
    const oBuy = flowDays.filter(d => d.organ_net > 0).length;
    const bothBuy = flowDays.filter(d => d.foreign_net > 0 && d.organ_net > 0).length;
    const bothSell = flowDays.filter(d => d.foreign_net < 0 && d.organ_net < 0).length;
    const fSell = flowDays.filter(d => d.foreign_net < 0).length;

    score += bothBuy * 3;
    score += fBuy * 2;
    score += oBuy * 1.5;
    score -= bothSell * 3;
    score -= fSell * 1;  // 외국인 매도 페널티

    // 오늘 모멘텀
    const today = flowDays[0];
    const prev = today.close - today.change;
    const todayPct = prev > 0 ? (today.change / prev * 100) : 0;
    let overheatPenalty = false;
    let dropPenalty = false;
    if (todayPct >= 7) { score -= 2; overheatPenalty = true; reasons.push(`당일 +${todayPct.toFixed(1)}% 급등 (차익실현 압력)`); }
    else if (todayPct <= -7) { score -= 1; dropPenalty = true; reasons.push(`당일 ${todayPct.toFixed(1)}% 급락 (추세 약화)`); }

    // 5일 가격 추세 (모멘텀) — 수급과 별개로 가격 흐름 반영
    const oldestClose = flowDays[flowDays.length - 1].close;
    const latestClose = today.close;
    if (oldestClose > 0 && latestClose > 0) {
        const ret5 = (latestClose - oldestClose) / oldestClose * 100;
        if (ret5 >= 10) { score += 3; reasons.push(`5일 +${ret5.toFixed(1)}% 강한 상승`); }
        else if (ret5 >= 5) { score += 2; reasons.push(`5일 +${ret5.toFixed(1)}% 상승`); }
        else if (ret5 <= -10) { score -= 3; reasons.push(`5일 ${ret5.toFixed(1)}% 강한 하락`); }
        else if (ret5 <= -5) { score -= 2; reasons.push(`5일 ${ret5.toFixed(1)}% 하락`); }
    }

    // ※ 기술적 지표(RSI, 골든/데드크로스 등)는 별도 calcTechnicals로 분리되어 UI에 별도 영역으로 표시.

    // 뉴스 호재/악재 영향도 — 압도적 호재는 큰 가중치 (수급 약세도 뒤집을 수 있게)
    if (sentiment && (sentiment.pos > 0 || sentiment.neg > 0)) {
        const net = (sentiment.pos || 0) - (sentiment.neg || 0);
        let newsAdj = 0;
        if (net >= 10) newsAdj = 10;          // 압도적 호재
        else if (net >= 5) newsAdj = 6;       // 호재 우세
        else if (net >= 3) newsAdj = 3;
        else if (net >= 1) newsAdj = 1;
        else if (net <= -10) newsAdj = -10;   // 압도적 악재
        else if (net <= -5) newsAdj = -6;
        else if (net <= -3) newsAdj = -3;
        else if (net <= -1) newsAdj = -1;
        score += newsAdj;
        if (newsAdj > 0) reasons.push(`뉴스 호재 ${sentiment.pos}건·악재 ${sentiment.neg}건 (+${newsAdj})`);
        else if (newsAdj < 0) reasons.push(`뉴스 악재 ${sentiment.neg}건·호재 ${sentiment.pos}건 (${newsAdj})`);
    }

    // 주요 근거
    if (bothBuy >= 3) reasons.unshift(`최근 5일 중 ${bothBuy}일 외인·기관 동반 매수`);
    else if (fBuy >= 4) reasons.unshift(`외국인 5일 중 ${fBuy}일 매수`);
    else if (bothSell >= 3) reasons.unshift(`최근 5일 중 ${bothSell}일 외인·기관 동반 매도`);
    else if (fSell >= 4) reasons.unshift(`외국인 5일 중 ${fSell}일 매도`);
    else if (fBuy >= 3) reasons.unshift(`외국인 ${fBuy}일 매수 / 기관 ${oBuy}일 매수`);
    else reasons.unshift(`외국인 ${fBuy}일 매수 / 기관 ${oBuy}일 매수`);

    let label, cls;
    if (score >= 18) { label = "강한 매수 우위"; cls = "signal-strong-buy"; }
    else if (score >= 10) { label = "매수 우위"; cls = "signal-buy"; }
    else if (score >= 3) {
        if (overheatPenalty) { label = "관망"; cls = "signal-caution"; }
        else { label = "약한 매수세"; cls = "signal-weak-buy"; }
    }
    else if (score >= -3) { label = "중립"; cls = "signal-neutral"; }
    else if (score >= -10) { label = "매도 우위"; cls = "signal-sell"; }
    else { label = "강한 매도 우위"; cls = "signal-strong-sell"; }

    return { label, cls, score, reasons };
}

function renderSbsBiz(main) {
    const s = state.sbsbiz;
    // 종목이 1개 이상 매칭된 영상만
    const videos = ((s && s.videos) || []).filter(v => v.stocks && v.stocks.length > 0);

    if (!s || !s.videos || s.videos.length === 0) {
        main.innerHTML = `
            <h2>📺 SBS Biz 추천 항목</h2>
            <div class="placeholder">
                아직 수집된 영상이 없습니다.<br>
                <code>run.bat</code>을 실행하면 SBS Biz YouTube 채널 최신 영상에서 추천 종목이 추출됩니다.
            </div>
        `;
        return;
    }
    if (videos.length === 0) {
        main.innerHTML = `
            <h2>📺 SBS Biz 추천 항목</h2>
            <div class="placeholder">
                최근 영상에서 매칭된 종목이 없습니다.<br>
                다음 갱신 시 자막이 정상 수집되면 표시됩니다.
            </div>
        `;
        return;
    }

    main.innerHTML = `
        <h2>📺 SBS Biz 추천 항목</h2>
        <div class="subtitle">SBS Biz YouTube 채널 영상에서 언급된 종목 · 표시 영상 ${videos.length}개 / 전체 ${s.videos.length}개${s.updated_at ? " · 업데이트 " + s.updated_at : ""}</div>
        <div class="sbs-list">
            ${videos.map((v, vi) => {
                const stocks = v.stocks.slice(0, 10); // 영상당 상위 10개
                const srcLabel = v.source === "transcript" ? "자막 분석" : "제목·설명";
                const srcCls = v.source === "transcript" ? "src-transcript" : "src-title";
                return `
                    <article class="card sbs-card">
                        <header class="sbs-card-head">
                            <div class="sbs-head-meta">
                                <span class="sbs-date">${escapeHtml(formatPublished(v.published))}</span>
                                <span class="src-badge ${srcCls}">${srcLabel}</span>
                                ${v.is_short ? `<span class="shorts-badge">📱 쇼츠</span>` : ""}
                                <span class="sbs-count">종목 ${v.stocks.length}개</span>
                            </div>
                        </header>
                        <table class="sbs-stock-table">
                            <thead>
                                <tr>
                                    <th class="col-name">종목</th>
                                    <th>시장 분위기</th>
                                    <th>기술적 지표</th>
                                    <th>1·2주 통계 전망</th>
                                    <th class="col-price">현재가</th>
                                    <th class="col-prev">전일</th>
                                    <th class="col-change">등락</th>
                                    <th class="col-snippet">영상 속 한 줄</th>
                                    <th>★</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${stocks.map((st, si) => `
                                    <tr class="sbs-stock-row" data-v="${vi}" data-s="${si}" data-code="${st.code}">
                                        <td class="col-name">
                                            <span class="stock-name" onclick="goSearch('${st.code}')">${escapeHtml(st.name)}</span>
                                            <span class="stock-code">${st.code}</span>
                                            ${industryBadgeHTML(st.code)}
                                            <span class="mentions" title="자막/텍스트 언급 횟수">×${st.mentions}</span>
                                        </td>
                                        <td>${signalBadgeHTML(st.code, {compact: true})}</td>
                                        <td>${techBadgeHTML(st.code, {compact: true})}${techMiniHTML(st.code) ? '<div class="cell-tech">' + techMiniHTML(st.code) + '</div>' : ''}</td>
                                        <td>${forecastMiniHTML(st.code) || '<span class="signal-mini signal-na compact">—</span>'}</td>
                                        <td class="col-price" data-field="price">…</td>
                                        <td class="col-prev" data-field="prev">…</td>
                                        <td class="col-change" data-field="change">…</td>
                                        <td class="col-snippet">${(v.source === "transcript" && st.snippet) ? escapeHtml(st.snippet) : '<span class="muted">—</span>'}</td>
                                        <td>${favIconHTML(st.code)}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                        <footer class="sbs-card-foot">
                            <a class="sbs-video-link" href="${escapeHtml(v.url)}" target="_blank" rel="noopener">
                                ${v.is_short ? "📱" : "▶"} <span class="vlabel">${v.is_short ? "쇼츠 보기" : "영상 보기"}</span>
                                <span class="vtitle">${escapeHtml(v.title)}</span>
                            </a>
                        </footer>
                    </article>
                `;
            }).join("")}
        </div>
    `;

    // 시세 비동기 채우기
    document.querySelectorAll(".sbs-stock-row").forEach(row => {
        const code = row.dataset.code;
        fetchStockCached(code).then(stock => {
            const priceCell = row.querySelector('[data-field="price"]');
            const prevCell = row.querySelector('[data-field="prev"]');
            const changeCell = row.querySelector('[data-field="change"]');
            if (stock.error || !stock.price) {
                priceCell.textContent = "—";
                prevCell.textContent = "—";
                changeCell.textContent = "—";
                changeCell.className = "col-change muted";
                return;
            }
            const ch = formatChange(stock.change, stock.change_pct);
            priceCell.textContent = formatPrice(stock.price) + "원";
            prevCell.textContent = formatPrice(stock.prev_close) + "원";
            changeCell.textContent = ch.text;
            changeCell.className = `col-change ${ch.cls}`;
        });
    });
}

// ============ 뷰: 백테스트 (사후 성과 검증) ============
function renderBacktest(main) {
    const bt = state.backtest;
    if (!bt || !bt.summary) {
        main.innerHTML = `
            <h2>📈 백테스트 — 매수 추천 신호의 사후 성과</h2>
            <div class="placeholder">
                아직 누적된 데이터가 없습니다. 다음 cron부터 매수 추천 스냅샷이 쌓이기 시작하고,
                추천일 이후 시세가 흐르면서 점차 측정값이 채워집니다.
            </div>`;
        return;
    }
    const s = bt.summary;
    const method = s.method || {};
    const range = s.history_range || {};
    // unique 기준을 메인 (정직한 평가), 전체 기준을 참고
    const cumU = (s.unique_signals && s.unique_signals.cumulative) || {};
    const cumA = (s.all_signals && s.all_signals.cumulative) || {};
    const hU = (s.unique_signals && s.unique_signals.by_horizon) || {};
    const hA = (s.all_signals && s.all_signals.by_horizon) || {};
    const detail = (bt.detail || []).slice(0, 60);

    function cell(val, suffix = "%", cls = "") {
        if (val === null || val === undefined) return `<span class="muted">—</span>`;
        const c = cls || (val > 0 ? "up" : val < 0 ? "down" : "flat");
        const sign = val > 0 ? "+" : "";
        return `<span class="${c}">${sign}${val}${suffix}</span>`;
    }

    function horizonRow(label, h) {
        if (!h || h.count === 0 || h.count === undefined) {
            return `<tr><td><strong>${label}</strong></td><td class="num">0</td><td colspan="6" class="muted">측정 불가 (데이터 부족)</td></tr>`;
        }
        return `
            <tr>
                <td><strong>${label}</strong></td>
                <td class="num">${h.count}</td>
                <td class="num">${cell(h.avg_ret)}</td>
                <td class="num">${cell(h.avg_alpha)}</td>
                <td class="num">${cell(h.avg_alpha_after_cost)}</td>
                <td class="num">${h.win_rate !== null && h.win_rate !== undefined ? h.win_rate + "%" : "<span class='muted'>—</span>"}</td>
                <td class="num up">${cell(h.best)}</td>
                <td class="num down">${cell(h.worst)}</td>
            </tr>`;
    }

    // 평가는 unique + 비용 차감 후 알파 기준 (가장 정직)
    let verdict = { label: "데이터 부족", cls: "verdict-neutral",
        note: "측정 가능한 신호가 아직 부족합니다 (의미 있는 평가에 표본 20건 이상, 보통 2~3주 누적 필요)." };
    const evalAlpha = cumU.avg_alpha_after_cost;
    const evalWin = cumU.win_rate;
    if (cumU.count >= 20 && evalAlpha !== null && evalAlpha !== undefined) {
        if (evalAlpha > 1.0 && (evalWin || 0) > 55) {
            verdict = { label: "🟢 의미 있는 알파", cls: "verdict-up",
                note: `비용 차감 후 평균 ${evalAlpha}% 알파 + 승률 ${evalWin}%. 통계적으로 시장 초과 성과 관측. 단, 표본 ${cumU.count}건이라 확정 단정은 어려움.` };
        } else if (evalAlpha < -1.0 || (evalWin || 0) < 45) {
            verdict = { label: "🔴 시장 미달", cls: "verdict-down",
                note: `비용 차감 후 평균 ${evalAlpha}% 알파, 승률 ${evalWin}%. 신호 추종이 KOSPI보다 못함 — 로직 재검토 필요.` };
        } else {
            verdict = { label: "⚪ 시장 수준", cls: "verdict-neutral",
                note: `비용 차감 후 평균 ${evalAlpha}% 알파, 승률 ${evalWin}%. KOSPI와 큰 차이 없음 — 신호의 부가가치가 거래비용 정도에 묻힘.` };
        }
    }

    main.innerHTML = `
        <h2>📈 백테스트 — 매수 추천 신호의 사후 성과</h2>
        <div class="subtitle">
            누적 ${s.days_with_data || 0}일 · 원시 신호 ${s.total_raw_signals || 0}개 (unique ${s.unique_signals_count || 0}, 중복 ${s.duplicate_signals || 0}) ·
            기간 ${escapeHtml(range.from || "—")} ~ ${escapeHtml(range.to || "—")}
        </div>

        <div class="card bt-method-card">
            <h3 class="bt-section">🧪 측정 방법론 (정직성 보강)</h3>
            <ul class="bt-method">
                <li>📍 <strong>진입가</strong>: ${escapeHtml(method.entry || "—")}</li>
                <li>📍 <strong>측정가</strong>: ${escapeHtml(method.measure || "—")}</li>
                <li>📍 <strong>거래비용</strong>: 왕복 ${method.cost_pct_roundtrip || 0.3}% 차감 시나리오 별도 표시</li>
                <li>📍 <strong>중복 신호</strong>: 같은 종목 ${method.cooldown_days || 5}거래일 내 재추천은 duplicate로 분류 (unique 기준 별도 집계)</li>
                <li>📍 <strong>비정상 격리</strong>: 일일 변동 ±${method.abnormal_daily_threshold_pct || 25}% 이상은 거래정지·액면분할·상폐 의심 → 측정 제외 (${s.abnormal_excluded || 0}건)</li>
                <li>📍 <strong>측정 불가</strong>: 추천 후 시세 데이터 부족 종목 ${s.skipped_unmeasurable || 0}건 제외</li>
            </ul>
        </div>

        <div class="card bt-verdict-card">
            <span class="verdict-pill ${verdict.cls}" style="font-size:14px;padding:6px 14px">${verdict.label}</span>
            <div class="bt-verdict-note">${escapeHtml(verdict.note)}</div>
        </div>

        <div class="card">
            <h3 class="bt-section">📊 unique 신호 기준 (중복 제거, 정직한 평가) — 메인</h3>
            <table class="bt-table">
                <thead>
                    <tr>
                        <th>구간</th>
                        <th class="num">건수</th>
                        <th class="num">평균 수익률</th>
                        <th class="num">평균 알파</th>
                        <th class="num">비용차감 후 알파</th>
                        <th class="num">승률</th>
                        <th class="num">최고</th>
                        <th class="num">최악</th>
                    </tr>
                </thead>
                <tbody>
                    ${horizonRow("+1거래일", hU["1"])}
                    ${horizonRow("+5거래일 (1주)", hU["5"])}
                    ${horizonRow("+10거래일 (2주)", hU["10"])}
                    ${horizonRow("현재까지 누적", cumU)}
                </tbody>
            </table>
        </div>

        <div class="card">
            <h3 class="bt-section">📊 전체 신호 기준 (중복 포함, 참고용)</h3>
            <table class="bt-table">
                <thead>
                    <tr>
                        <th>구간</th>
                        <th class="num">건수</th>
                        <th class="num">평균 수익률</th>
                        <th class="num">평균 알파</th>
                        <th class="num">비용차감 후 알파</th>
                        <th class="num">승률</th>
                        <th class="num">최고</th>
                        <th class="num">최악</th>
                    </tr>
                </thead>
                <tbody>
                    ${horizonRow("+1거래일", hA["1"])}
                    ${horizonRow("+5거래일 (1주)", hA["5"])}
                    ${horizonRow("+10거래일 (2주)", hA["10"])}
                    ${horizonRow("현재까지 누적", cumA)}
                </tbody>
            </table>
            <div class="bt-note">
                💡 unique 기준이 더 정직합니다 (같은 거래를 여러 번 카운팅하는 효과 제거).
                전체 기준은 "체감 빈도"를 보는 참고용.
            </div>
        </div>

        ${detail.length > 0 ? `
        <div class="card">
            <h3 class="bt-section">📋 종목별 상세 (최근 ${detail.length}건)</h3>
            <table class="bt-table bt-detail">
                <thead>
                    <tr>
                        <th>추천일</th>
                        <th>종목</th>
                        <th class="num">진입가<br>(다음일 시가)</th>
                        <th class="num">+1일</th>
                        <th class="num">+5일</th>
                        <th class="num">+10일</th>
                        <th class="num">누적</th>
                        <th class="num">알파</th>
                        <th>플래그</th>
                    </tr>
                </thead>
                <tbody>
                    ${detail.map(d => {
                        const h1 = d.horizons && d.horizons["1"];
                        const h5 = d.horizons && d.horizons["5"];
                        const h10 = d.horizons && d.horizons["10"];
                        const cu = d.cumulative;
                        const flags = [];
                        if (d.duplicate) flags.push(`<span class="bt-flag-dup">중복</span>`);
                        if (d.abnormal_in_window) flags.push(`<span class="bt-flag-abnormal">비정상변동</span>`);
                        function horizonCell(hh) {
                            if (!hh) return '<span class="muted">—</span>';
                            if (hh.abnormal) return '<span class="muted" title="비정상 변동으로 측정 제외">제외</span>';
                            return cell(hh.ret);
                        }
                        return `
                        <tr class="${d.duplicate ? 'bt-row-dup' : ''}">
                            <td class="bt-date">${escapeHtml(d.date)}</td>
                            <td><span class="bt-name" onclick="goSearch('${d.code}')">${escapeHtml(d.name)}</span><br><span class="bt-code">${d.code}</span></td>
                            <td class="num">${formatPrice(d.entry_price)}원</td>
                            <td class="num">${horizonCell(h1)}</td>
                            <td class="num">${horizonCell(h5)}</td>
                            <td class="num">${horizonCell(h10)}</td>
                            <td class="num">${horizonCell(cu)}</td>
                            <td class="num">${cu && cu.alpha !== undefined ? cell(cu.alpha) : '<span class="muted">—</span>'}</td>
                            <td>${flags.join(" ")}</td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
        </div>` : ""}
    `;
}

// ============ 뷰: 즐겨찾기 ============
async function renderFavorites(main) {
    if (state.favorites.length === 0) {
        main.innerHTML = `
            <h2>⭐ 즐겨찾기</h2>
            <div class="fav-empty">
                <p>아직 즐겨찾기에 추가한 종목이 없습니다.</p>
                <p>상단 검색창에서 종목을 검색한 뒤 ★ 버튼을 눌러보세요.</p>
            </div>
        `;
        return;
    }
    main.innerHTML = `
        <h2>⭐ 즐겨찾기 (${state.favorites.length})</h2>
        <div class="subtitle">최신 시세·수급·뉴스를 불러오는 중...</div>
        <div id="fav-grid" class="fav-grid"></div>
    `;
    const grid = document.getElementById("fav-grid");
    const codes = [...state.favorites];
    const masterByCode = Object.fromEntries((state.stocks || []).map(s => [s.code, s]));

    const results = await Promise.all(codes.map(async (c) => {
        const stockMaster = masterByCode[c];
        const nameForNews = stockMaster ? stockMaster.name : c;
        const [stock, flow, news] = await Promise.all([
            fetchStockCached(c),
            fetchFlowCached(c),
            fetchJsonUtf8(`/api/news?q=${encodeURIComponent(nameForNews)}&display=2`, []),
        ]);
        return { stock, flow, news: Array.isArray(news) ? news : [] };
    }));

    grid.innerHTML = results.map(({ stock: s, flow, news }) => {
        if (s.error || !s.name) {
            return `
                <div class="card fav-card" onclick="goSearch('${s.code}')">
                    <button class="remove" onclick="removeFav(event, '${s.code}')">✕</button>
                    <div class="name">조회 실패</div>
                    <div class="code">${s.code}</div>
                </div>
            `;
        }
        const ch = formatChange(s.change, s.change_pct);
        const days = (flow && flow.days) || [];
        const today = days[0] || {};
        const sig = calcSignal(days, getSentimentForCode(s.code), flow && flow.prices_60d);

        const newsHtml = news.filter(n => n && n.title && !n.error).slice(0, 2).map(n => `
            <a class="fav-news-item" href="${escapeHtml(n.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
                ${escapeHtml(n.title)}
            </a>
        `).join("");

        return `
            <div class="card fav-card" onclick="goSearch('${s.code}')">
                <button class="remove" onclick="removeFav(event, '${s.code}')">✕</button>
                <div class="name">${escapeHtml(s.name)} ${industryBadgeHTML(s.code)}</div>
                <div class="code">${s.code}</div>
                <div class="fav-price-block">
                    <div class="price">${formatPrice(s.price)}원</div>
                    <div class="change ${ch.cls}">${ch.text}</div>
                </div>
                ${days.length >= 2 ? `
                    <div class="fav-chart">
                        ${chartHTML(days, {width: 260, height: 110})}
                    </div>
                ` : ""}
                ${days.length ? `
                    <div class="fav-sig-section">
                        <div class="fav-sig-title">📈 시장 분위기</div>
                        <div class="fav-signal ${sig.cls}" title="${escapeHtml(sig.reasons.join(' · '))}">
                            <span class="sig-arrow">${sig.cls.includes('buy') ? '▲' : sig.cls.includes('sell') ? '▼' : '•'}</span>
                            <span class="sig-label">${sig.label}</span>
                        </div>
                    </div>
                    <div class="fav-sig-section">
                        <div class="fav-sig-title">📐 기술적 지표</div>
                        ${techBadgeHTML(s.code, { prices60d: flow && flow.prices_60d })}
                        ${techMiniHTML(s.code, { prices60d: flow && flow.prices_60d }) ? `<div class="fav-tech-mini">${techMiniHTML(s.code, { prices60d: flow && flow.prices_60d })}</div>` : ""}
                    </div>
                    ${forecastMiniHTML(s.code, { prices60d: flow && flow.prices_60d }) ? `
                    <div class="fav-sig-section">
                        <div class="fav-sig-title">📅 1·2주 통계 전망</div>
                        ${forecastMiniHTML(s.code, { prices60d: flow && flow.prices_60d })}
                    </div>` : ""}
                    <div class="fav-flow">
                        <div class="ff-row">
                            <span class="ff-label">외인</span>
                            <span class="ff-value ${netCls(today.foreign_net || 0)}">${formatSignedQty(today.foreign_net || 0)}</span>
                        </div>
                        <div class="ff-row">
                            <span class="ff-label">기관</span>
                            <span class="ff-value ${netCls(today.organ_net || 0)}">${formatSignedQty(today.organ_net || 0)}</span>
                        </div>
                        <div class="ff-row">
                            <span class="ff-label">개인</span>
                            <span class="ff-value ${netCls(today.individual_net || 0)}">${formatSignedQty(today.individual_net || 0)}</span>
                        </div>
                    </div>
                    <div class="fav-signal-reason">${escapeHtml(sig.reasons[0] || "")}</div>
                ` : ""}
                ${newsHtml ? `<div class="fav-news">${newsHtml}</div>` : ""}
            </div>
        `;
    }).join("");

    // 상단 부제 갱신
    const sub = main.querySelector(".subtitle");
    if (sub) {
        sub.innerHTML = `최근 5일 수급 기반 매매 신호 포함 · <span class="disclaimer">* 단순 휴리스틱 참고용, 투자 권유 아님</span>`;
    }
}

function removeFav(event, code) {
    event.stopPropagation();
    toggleFavorite(code);
    render();
}

// ============ 뷰: 검색 결과 ============
async function renderSearchResult(main, code) {
    if (!code) {
        main.innerHTML = `<div class="placeholder">검색어를 입력해주세요.</div>`;
        return;
    }
    main.innerHTML = `<div class="placeholder">조회 중...</div>`;

    let stockMaster = (state.stocks || []).find(s => s.code === code);
    const stockName = stockMaster ? stockMaster.name : "";
    const newsQuery = stockName || code;

    const [stock, news, flow, intraday] = await Promise.all([
        fetchJsonUtf8(`/api/stock?code=${code}`, { error: "조회 실패" }),
        fetchJsonUtf8(`/api/news?q=${encodeURIComponent(newsQuery)}&display=20`, []),
        fetchFlowCached(code),
        fetchJsonUtf8(`/api/intraday?code=${code}`, { data: [] }),
    ]);

    if (stock.error) {
        main.innerHTML = `<div class="placeholder">시세 조회 실패: ${escapeHtml(stock.error)}</div>`;
        return;
    }
    const ch = formatChange(stock.change, stock.change_pct);
    // 시간외 단일가가 정규장 종가와 다르면 우선 표시
    const hasAfter = stock.after_price && stock.after_price !== stock.price;
    const mainPrice = hasAfter ? stock.after_price : stock.price;
    const mainCh = hasAfter ? formatChange(stock.after_change, stock.after_change_pct) : ch;
    const fav = isFavorite(code);
    const newsArr = Array.isArray(news) ? news : [];
    const sig = calcSignal((flow && flow.days) || [], getSentimentForCode(code));
    const tech = (flow && flow.prices_60d && flow.prices_60d.length >= 5) ? calcTechnicals(flow.prices_60d) : null;
    const forecast = (flow && flow.prices_60d && stock.price) ? calcForecast(flow.prices_60d, stock.price) : null;

    main.innerHTML = `
        <div class="search-result">
            <div>
                <div class="stock-detail">
                    <div class="name-block">
                        <h2>${escapeHtml(stock.name || stockName || "(이름 없음)")}</h2>
                        <span class="stock-code">${stock.code}${stockMaster ? ` · ${stockMaster.market}` : ""}</span>
                        ${industryBadgeHTML(stock.code)}
                    </div>
                    <div class="price-block">
                        <div class="price-now">${formatPrice(mainPrice)}원${hasAfter ? '<span class="after-tag">시간외</span>' : ''}</div>
                        <div class="change-info ${mainCh.cls}">${mainCh.text}</div>
                        <div class="prev-close">전일 ${formatPrice(stock.prev_close)}원</div>
                    </div>
                    ${hasAfter ? `
                        <div class="regular-price-row">
                            <span class="rp-label">정규장 종가</span>
                            <span class="rp-value">${formatPrice(stock.price)}원</span>
                            <span class="rp-change ${ch.cls}">${ch.text}</span>
                        </div>
                    ` : ""}
                    ${(flow && flow.days && flow.days.length >= 2) || (intraday && intraday.data && intraday.data.length >= 2) ? `
                        <div class="charts-row">
                            ${flow && flow.days && flow.days.length >= 2 ? `
                                <div class="search-chart-block">
                                    <div class="search-chart-label">최근 ${flow.days.length}일 종가 추이${tech ? ` · <span class="down">저항 ${formatPrice(Math.round(tech.resist20))}</span> / <span class="up">지지 ${formatPrice(Math.round(tech.support20))}</span>` : ""}</div>
                                    ${chartHTML(flow.days, {width: 420, height: 180})}
                                </div>
                            ` : ""}
                            ${intraday && intraday.data && intraday.data.length >= 2 ? `
                                <div class="search-chart-block">
                                    <div class="search-chart-label">당일 분봉 (${escapeHtml(intraday.date || "")})</div>
                                    ${intradayChartHTML(intraday, {width: 420, height: 180})}
                                </div>
                            ` : ""}
                        </div>
                    ` : ""}
                    ${flow && flow.days && flow.days.length ? `
                        <div class="search-signal-block">
                            <div class="signal-line">
                                <span class="signal-line-label">📈 시장 분위기</span>
                                <span class="signal-mini ${sig.cls}">${sig.label}</span>
                            </div>
                            <div class="signal-reason">${escapeHtml(sig.reasons.join(' · '))}</div>
                        </div>
                        ${tech ? `
                            <div class="search-tech-block">
                                <div class="signal-line">
                                    <span class="signal-line-label">📐 기술적 지표</span>
                                    ${techBadgeHTML(code, { prices60d: flow.prices_60d })}
                                </div>
                                ${techMiniHTML(code, { prices60d: flow.prices_60d }) ? `<div class="search-tech-mini">${techMiniHTML(code, { prices60d: flow.prices_60d })}</div>` : ""}
                            </div>
                        ` : ""}
                    ` : ""}
                </div>
                ${tech ? `
                    <div class="card tech-card">
                        <h3 class="tech-card-title">📐 기술적 지표 <span class="tech-card-sub">최근 ${tech.dataLength}일 데이터 기반</span></h3>
                        <div class="tech-grid">
                            ${tech.rsi14 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">RSI (14일)</span>
                                    <span class="tech-value ${tech.rsi14 <= 30 ? 'up' : tech.rsi14 >= 70 ? 'down' : ''}">${tech.rsi14.toFixed(1)}</span>
                                    <span class="tech-note">${tech.rsi14 <= 30 ? '🟢 과매도 (저점 매수 기회)' : tech.rsi14 >= 70 ? '🔴 과매수 (조정 가능성)' : '⚪ 중립 구간'}</span>
                                </div>
                            ` : ""}
                            ${tech.divergence20 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">20일 이격도</span>
                                    <span class="tech-value ${tech.divergence20 <= -10 ? 'up' : tech.divergence20 >= 15 ? 'down' : ''}">${tech.divergence20 > 0 ? '+' : ''}${tech.divergence20}%</span>
                                    <span class="tech-note">${tech.divergence20 <= -10 ? '🟢 단기 과매도' : tech.divergence20 >= 15 ? '🔴 단기 과열' : '⚪ 정상 범위'}</span>
                                </div>
                            ` : ""}
                            ${tech.ma5 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">5일 이동평균</span>
                                    <span class="tech-value">${formatPrice(Math.round(tech.ma5))}원</span>
                                </div>
                            ` : ""}
                            ${tech.ma20 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">20일 이동평균</span>
                                    <span class="tech-value">${formatPrice(Math.round(tech.ma20))}원</span>
                                </div>
                            ` : ""}
                            ${tech.ma60 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">60일 이동평균</span>
                                    <span class="tech-value">${formatPrice(Math.round(tech.ma60))}원</span>
                                </div>
                            ` : ""}
                            ${tech.bbUpper !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">볼린저 상단</span>
                                    <span class="tech-value">${formatPrice(Math.round(tech.bbUpper))}원</span>
                                </div>
                                <div class="tech-cell">
                                    <span class="tech-label">볼린저 하단</span>
                                    <span class="tech-value">${formatPrice(Math.round(tech.bbLower))}원</span>
                                </div>
                            ` : ""}
                            ${tech.resist20 !== null ? `
                                <div class="tech-cell">
                                    <span class="tech-label">🔴 단기 저항선 (20일)</span>
                                    <span class="tech-value down">${formatPrice(Math.round(tech.resist20))}원</span>
                                    <span class="tech-note">현재가에서 +${tech.distToResist20}%</span>
                                </div>
                                <div class="tech-cell">
                                    <span class="tech-label">🟢 단기 지지선 (20일)</span>
                                    <span class="tech-value up">${formatPrice(Math.round(tech.support20))}원</span>
                                    <span class="tech-note">현재가에서 -${tech.distToSupport20}%</span>
                                </div>
                                <div class="tech-cell">
                                    <span class="tech-label">🔴 중기 저항선 (60일)</span>
                                    <span class="tech-value down">${formatPrice(Math.round(tech.resist60))}원</span>
                                </div>
                                <div class="tech-cell">
                                    <span class="tech-label">🟢 중기 지지선 (60일)</span>
                                    <span class="tech-value up">${formatPrice(Math.round(tech.support60))}원</span>
                                </div>
                            ` : ""}
                        </div>
                        ${(tech.goldenCross || tech.deadCross || tech.lowBounce || tech.volSurge) ? `
                            <div class="tech-events">
                                <div class="tech-events-title">⚡ 발생 이벤트</div>
                                <div class="tech-events-list">
                                    ${tech.goldenCross ? `<span class="tech-event up">⭐ 골든크로스 (강한 매수 시그널)</span>` : ""}
                                    ${tech.deadCross ? `<span class="tech-event down">⚠ 데드크로스 (강한 매도 시그널)</span>` : ""}
                                    ${tech.lowBounce ? `<span class="tech-event up">📈 저점 반등 시도</span>` : ""}
                                    ${tech.volSurge ? `<span class="tech-event">📊 거래량 급증 (평소 2배↑)</span>` : ""}
                                </div>
                            </div>
                        ` : ""}
                        <div class="tech-note-small">
                            💡 <strong>이게 뭐죠?</strong><br>
                            <strong>RSI</strong>: 0~100 사이 점수. <span class="up">30 이하 = 많이 떨어진 상태(저가에 사기 좋음)</span>, <span class="down">70 이상 = 많이 오른 상태(차익실현 고려)</span><br>
                            <strong>골든크로스</strong>: 단기(5일) 평균선이 중기(20일) 평균선을 위로 뚫음 → <span class="up">강한 매수 신호</span><br>
                            <strong>데드크로스</strong>: 반대 (5일선이 20일선 아래로) → <span class="down">강한 매도 신호</span><br>
                            <strong>저점 반등</strong>: 며칠 떨어진 뒤 다시 오르기 시작 → <span class="up">저점 매수 후보</span><br>
                            <strong>이격도</strong>: 현재가가 20일 평균보다 얼마나 떨어져 있는지. <span class="up">-10% 이상 차이 = 저가권(저점 매수)</span>, <span class="down">+15% 이상 = 과열(주의)</span><br>
                            <strong>저항선</strong>: 최근 N일 중 가장 높은 가격. <span class="down">이 가격대 근처에서 매도세가 자주 나옴</span> (돌파하면 추가 상승 가능)<br>
                            <strong>지지선</strong>: 최근 N일 중 가장 낮은 가격. <span class="up">이 가격대 근처에서 매수세가 자주 들어옴</span> (이탈하면 추가 하락 가능)
                        </div>
                    </div>
                ` : ""}
                ${forecast ? (() => {
                    const gradeMap = {
                        stable: { label: "안정 ✓", cls: "fc-grade-stable", note: "변동성·표본 모두 양호" },
                        caution: { label: "주의 ⚠", cls: "fc-grade-caution", note: "변동성이 최근 변했음 — 보정값 신뢰도 ↓" },
                        limited: { label: "표본 부족", cls: "fc-grade-limited", note: "30일 미만 표본 — 보수적으로 해석" },
                        uncertain: { label: "불확실 ⚠⚠", cls: "fc-grade-uncertain", note: "이벤트 임박 — 신뢰구간 크게 벗어날 위험" },
                    };
                    const g = gradeMap[forecast.grade] || gradeMap.stable;
                    return `
                    <div class="card forecast-card">
                        <h3 class="forecast-title">📅 1-2주 전망 (통계 추정) <span class="forecast-sub">표본 ${forecast.sampleSize}일 · μ ${forecast.dailyMeanPct >= 0 ? '+' : ''}${forecast.dailyMeanPct}% · σ ±${forecast.dailySdPct}% · <span class="fc-grade ${g.cls}" title="${escapeHtml(g.note)}">${g.label}</span></span></h3>
                        <div class="forecast-grid">
                            <div class="forecast-cell">
                                <div class="fc-period">📆 1주 후 (5영업일)</div>
                                <div class="fc-expected">기준 ${formatPrice(forecast.oneWeek.expected)}원 <span class="fc-pct ${forecast.oneWeek.ret_pct >= 0 ? 'up' : 'down'}">${forecast.oneWeek.ret_pct >= 0 ? '+' : ''}${forecast.oneWeek.ret_pct}%</span></div>
                                <div class="fc-range">
                                    <span class="fc-low">최저 ${formatPrice(forecast.oneWeek.lower)} (${forecast.oneWeek.lower_pct}%)</span>
                                    <span class="fc-bar"></span>
                                    <span class="fc-high">최고 ${formatPrice(forecast.oneWeek.upper)} (+${forecast.oneWeek.upper_pct}%)</span>
                                </div>
                            </div>
                            <div class="forecast-cell">
                                <div class="fc-period">📆 2주 후 (10영업일)</div>
                                <div class="fc-expected">기준 ${formatPrice(forecast.twoWeek.expected)}원 <span class="fc-pct ${forecast.twoWeek.ret_pct >= 0 ? 'up' : 'down'}">${forecast.twoWeek.ret_pct >= 0 ? '+' : ''}${forecast.twoWeek.ret_pct}%</span></div>
                                <div class="fc-range">
                                    <span class="fc-low">최저 ${formatPrice(forecast.twoWeek.lower)} (${forecast.twoWeek.lower_pct}%)</span>
                                    <span class="fc-bar"></span>
                                    <span class="fc-high">최고 ${formatPrice(forecast.twoWeek.upper)} (+${forecast.twoWeek.upper_pct}%)</span>
                                </div>
                            </div>
                        </div>
                        ${(forecast.warnings && forecast.warnings.length) || (forecast.reasons && forecast.reasons.length) ? `
                            <ul class="forecast-meta">
                                ${(forecast.warnings || []).map(w => `<li class="fc-warn">⚠ ${escapeHtml(w)}</li>`).join("")}
                                ${(forecast.reasons || []).map(r => `<li class="fc-reason">• ${escapeHtml(r)}</li>`).join("")}
                            </ul>` : ""}
                        <div class="forecast-note">
                            💡 <strong>이건 예측이 아닌 통계 범위입니다</strong>. 모델: Historical VaR + GBM 정규모델 50:50 가중, 5일 모멘텀 보정, RSI mean reversion, 실적 임박 σ 확장. 실적·정책·해외증시 큰 이벤트가 발생하면 모델 무력화 가능.
                        </div>
                    </div>
                    `;
                })() : ""}
                <div class="card ai-card">
                    <h3 class="ai-card-title">🤖 Claude AI 분석 <span class="ai-card-sub">시세·수급·뉴스·기술지표 종합 판단</span></h3>
                    <div class="ai-body" id="ai-analysis-body">
                        <button class="ai-btn" id="ai-analyze-btn" onclick="requestAiAnalysis('${code}')">🤖 AI 분석 받기</button>
                        <div class="ai-note">버튼을 누르면 Claude(Anthropic)에 종목 종합 정보를 보내 매수/매도/관망 판단과 한 문단 설명을 받습니다. 응답 1~5초 소요.</div>
                    </div>
                </div>
                <div class="flow-section">
                    <h3>💰 외국인·기관·개인 일별 수급 (최근 ${(flow.days || []).length}일)</h3>
                    ${renderFlowTableForStock(flow)}
                </div>
                <div class="news-section">
                    <h3>📄 관련 뉴스</h3>
                    <div class="card">
                        ${newsArr.length === 0 ? `<div class="placeholder" style="padding:24px">관련 뉴스가 없습니다.</div>` :
                            newsArr.map(n => {
                                // 검색 결과 뉴스에도 sentiment 분류 (휴리스틱)
                                const t = (n.title || "") + " " + (n.summary || "");
                                const sent = classifySentimentJS(t);
                                return `
                                <div class="news-item">
                                    <div class="title">
                                        ${sentBadgeHTML(sent)}
                                        <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
                                    </div>
                                    ${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ""}
                                    <div class="meta">${n.pubDate ? `<span>${escapeHtml(n.pubDate)}</span>` : ""}</div>
                                </div>
                            `;}).join("")
                        }
                    </div>
                </div>
            </div>
            <div>
                <button class="fav-btn ${fav ? "active" : ""}" id="fav-btn" title="${fav ? "즐겨찾기에서 제거" : "즐겨찾기에 추가"}">★</button>
            </div>
        </div>
    `;
    document.getElementById("fav-btn").addEventListener("click", () => {
        toggleFavorite(code);
        const btn = document.getElementById("fav-btn");
        btn.classList.toggle("active");
        btn.title = isFavorite(code) ? "즐겨찾기에서 제거" : "즐겨찾기에 추가";
    });
}

// ============ 네비게이션 헬퍼 ============
async function requestAiAnalysis(code) {
    const body = document.getElementById("ai-analysis-body");
    if (!body) return;
    body.innerHTML = `<div class="ai-loading">🤖 Claude가 분석 중... (3~8초 소요)</div>`;
    try {
        const r = await fetchJsonUtf8(`/api/ai_analyze?code=${code}`, { error: "응답 없음" });
        if (r.error) {
            body.innerHTML = `<div class="ai-error">❌ ${escapeHtml(r.error)}${r.detail ? `<br><small>${escapeHtml(r.detail)}</small>` : ''}</div>`;
            return;
        }
        const cls = r.action === "buy" ? "signal-buy" : r.action === "sell" ? "signal-sell" : "signal-neutral";
        const label = r.action === "buy" ? "🟢 매수" : r.action === "sell" ? "🔴 매도" : "⚪ 관망";
        const usage = r.usage || {};
        const tokenInfo = (usage.input_tokens || usage.output_tokens)
            ? ` · 토큰 in ${usage.input_tokens || "?"} / out ${usage.output_tokens || "?"}`
            : "";
        body.innerHTML = `
            <div class="ai-result">
                <div class="ai-verdict ${cls}">${label} · 확신도 ${r.confidence || "—"}/10</div>
                <div class="ai-analysis">${escapeHtml(r.analysis || "").replace(/\n/g, "<br>")}</div>
                <div class="ai-meta">📌 ${escapeHtml(r.model || "")}${tokenInfo} · ${escapeHtml(r.fetched_at || "")}</div>
            </div>
        `;
    } catch (e) {
        body.innerHTML = `<div class="ai-error">❌ 오류: ${escapeHtml(String(e))}</div>`;
    }
}
window.requestAiAnalysis = requestAiAnalysis;

function goView(view) { setHash(view); }
function goSearch(code) { setHash("search", { code }); }
function goKeyword(kw) { setHash("news", { kw }); }
window.goView = goView;
window.goSearch = goSearch;
window.goKeyword = goKeyword;
window.removeFav = removeFav;

// ============ 검색 자동완성 ============
function initSearch() {
    const input = document.getElementById("search-input");
    const list = document.getElementById("search-suggestions");
    let activeIdx = -1;
    let items = [];

    function hideSuggestions() {
        list.hidden = true;
        list.innerHTML = "";
        activeIdx = -1;
    }

    function showSuggestions(q) {
        const stocks = state.stocks || [];
        if (!q || q.length < 1 || stocks.length === 0) {
            hideSuggestions();
            return;
        }
        const lower = q.toLowerCase();
        const codeMatch = /^\d+$/.test(q);
        const filtered = [];
        for (const s of stocks) {
            if (codeMatch && s.code.startsWith(q)) filtered.push(s);
            else if (!codeMatch && s.name.toLowerCase().includes(lower)) filtered.push(s);
            if (filtered.length >= 10) break;
        }
        items = filtered;
        if (items.length === 0) { hideSuggestions(); return; }
        list.innerHTML = items.map((s, i) => `
            <li data-idx="${i}" data-code="${s.code}">
                <span><strong>${escapeHtml(s.name)}</strong> <span class="code">${s.code}</span></span>
                <span class="market">${escapeHtml(s.market)}</span>
            </li>
        `).join("");
        list.hidden = false;
        activeIdx = -1;

        list.querySelectorAll("li").forEach(li => {
            li.addEventListener("mousedown", (e) => {
                e.preventDefault();
                const code = li.dataset.code;
                input.value = "";
                hideSuggestions();
                goSearch(code);
            });
        });
    }

    input.addEventListener("input", (e) => showSuggestions(e.target.value.trim()));
    input.addEventListener("focus", (e) => { if (e.target.value.trim()) showSuggestions(e.target.value.trim()); });
    input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

    input.addEventListener("keydown", (e) => {
        if (list.hidden) {
            if (e.key === "Enter" && /^\d{6}$/.test(input.value.trim())) {
                const code = input.value.trim();
                input.value = "";
                goSearch(code);
            }
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
            updateActive();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, -1);
            updateActive();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const target = activeIdx >= 0 ? items[activeIdx] : items[0];
            if (target) {
                input.value = "";
                hideSuggestions();
                goSearch(target.code);
            }
        } else if (e.key === "Escape") {
            hideSuggestions();
        }
    });

    function updateActive() {
        list.querySelectorAll("li").forEach((li, i) => {
            li.classList.toggle("active", i === activeIdx);
        });
    }
}

// ============ 초기화 ============
async function main() {
    document.querySelector(".sidebar-menu").addEventListener("click", (e) => {
        const li = e.target.closest("li[data-view]");
        if (!li || e.target.closest(".menu-toggle")) return;
        const params = {};
        if (li.dataset.date) params.date = li.dataset.date;
        setHash(li.dataset.view, Object.keys(params).length ? params : undefined);
    });
    window.addEventListener("hashchange", render);
    document.getElementById("fav-count").textContent = state.favorites.length;

    await loadData();
    initSearch();
    render();
    // 백그라운드: 60일 시세/수급 상세 로드 → 완료 시 재렌더
    loadFlowByCode();
}

main();
