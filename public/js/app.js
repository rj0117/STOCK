/**
 * 한국 주식 대시보드 - 프론트엔드 라우터
 * 뷰: top30 / news / favorites / search
 */

const FAV_KEY = "stock-favorites";
const state = {
    data: null,           // data.json
    stocks: null,         // stocks.json - 종목 마스터
    sbsbiz: null,         // sbsbiz.json - SBS Biz YouTube 추천
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
        const [data, stocks, sbsbiz] = await Promise.all([
            fetchJsonUtf8("data.json", null),
            fetchJsonUtf8("stocks.json", []),
            fetchJsonUtf8("sbsbiz.json", null),
        ]);
        if (!data) throw new Error("data.json 로드 실패");
        state.data = data;
        state.stocks = Array.isArray(stocks) ? stocks : [];
        state.sbsbiz = sbsbiz;
        if (data.flow && !data.flow.by_code) data.flow.by_code = {};
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
        li.classList.toggle("active", li.dataset.view === view);
    });
    const main = document.getElementById("view");
    if (view === "top30") renderTop30(main);
    else if (view === "news") {
        if (params.get("kw")) renderKeywordDetail(main, params.get("kw"));
        else renderNewsKeywords(main);
    }
    else if (view === "recommend") renderRecommendBuy(main);
    else if (view === "flow") renderFlow(main, params.get("kind") || "foreign_top");
    else if (view === "sbsbiz") renderSbsBiz(main);
    else if (view === "favorites") renderFavorites(main);
    else if (view === "search") renderSearchResult(main, params.get("code"));
    else renderTop30(main);
}

// ============ 뷰: TOP 30 ============
function renderTop30(main) {
    const data = state.data;
    if (!data) { main.innerHTML = `<div class="placeholder">로딩 중...</div>`; return; }
    const top = data.top_stocks || [];
    const asOf = (top[0] && top[0].as_of) || data.generated_date || "";
    const html = `
        <h2>📊 오늘의 한국 주식 TOP 30</h2>
        <div class="subtitle">
            인기 검색 순위(1등=30점, 30등=1점) + 뉴스 노출(건당 +15점) 합산 ·
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
                                <div class="rec-sig-reason">${escapeHtml((c.sig.reasons || [])[0] || "")}</div>
                                <div class="rec-sig-line">
                                    <span class="rec-sig-label">📐 기술</span>
                                    <span class="signal-mini ${c.techSum.cls} compact">${c.techSum.label}</span>
                                </div>
                                <div class="rec-sig-reason">${escapeHtml(c.techSum.signals.join(' · '))}</div>
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
function calcForecast(prices60d, currentPrice) {
    if (!prices60d || prices60d.length < 20 || !currentPrice) return null;
    const ordered = [...prices60d].reverse();  // 과거 → 최신
    const returns = [];
    for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1].close;
        if (prev > 0) {
            returns.push(Math.log(ordered[i].close / prev));  // 로그 수익률
        }
    }
    if (returns.length < 10) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const sd = Math.sqrt(variance);

    function rangeAt(days) {
        const mu = mean * days;
        const sigma = sd * Math.sqrt(days);
        const expected = Math.round(currentPrice * Math.exp(mu));
        const lower = Math.round(currentPrice * Math.exp(mu - 1.96 * sigma));
        const upper = Math.round(currentPrice * Math.exp(mu + 1.96 * sigma));
        return {
            expected,
            lower,
            upper,
            ret_pct: Math.round((expected / currentPrice - 1) * 1000) / 10,
            upper_pct: Math.round((upper / currentPrice - 1) * 1000) / 10,
            lower_pct: Math.round((lower / currentPrice - 1) * 1000) / 10,
        };
    }
    return {
        oneWeek: rangeAt(5),
        twoWeek: rangeAt(10),
        dailyMeanPct: Math.round(mean * 1000) / 10,
        dailySdPct: Math.round(sd * 1000) / 10,
        sampleSize: returns.length,
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
                ${forecast ? `
                    <div class="card forecast-card">
                        <h3 class="forecast-title">📅 1-2주 전망 (통계 추정) <span class="forecast-sub">최근 ${forecast.sampleSize}일 변동성 기반 95% 신뢰구간</span></h3>
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
                        <div class="forecast-note">
                            💡 <strong>이건 예측이 아닌 통계 범위입니다</strong>. 최근 ${forecast.sampleSize}일의 일일 변동성(±${forecast.dailySdPct}%/일)이 유지된다고 가정한 95% 신뢰구간 — 시장 큰 이벤트(실적·정책·해외증시 등) 발생 시 무력해집니다. 평균 기대치 = 최근 추세 연장(일일 ${forecast.dailyMeanPct >= 0 ? '+' : ''}${forecast.dailyMeanPct}%).
                        </div>
                    </div>
                ` : ""}
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
    body.innerHTML = `<div class="ai-loading">🤖 Claude가 분석 중... (1~5초)</div>`;
    try {
        const r = await fetchJsonUtf8(`/api/ai_analyze?code=${code}`, { error: "응답 없음" });
        if (r.error) {
            body.innerHTML = `<div class="ai-error">❌ ${escapeHtml(r.error)}${r.detail ? `<br><small>${escapeHtml(r.detail)}</small>` : ''}</div>`;
            return;
        }
        const cls = r.action === "buy" ? "signal-buy" : r.action === "sell" ? "signal-sell" : "signal-neutral";
        const label = r.action === "buy" ? "🟢 매수" : r.action === "sell" ? "🔴 매도" : "⚪ 관망";
        body.innerHTML = `
            <div class="ai-result">
                <div class="ai-verdict ${cls}">${label} · 확신도 ${r.confidence || "—"}/10</div>
                <div class="ai-analysis">${escapeHtml(r.analysis || "").replace(/\n/g, "<br>")}</div>
                <div class="ai-meta">📌 ${escapeHtml(r.model || "")} · ${escapeHtml(r.fetched_at || "")}</div>
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
    document.querySelectorAll(".sidebar-menu li").forEach(li => {
        li.addEventListener("click", () => setHash(li.dataset.view));
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
