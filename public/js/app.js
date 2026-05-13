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
        const [data, stocks, sbsbiz] = await Promise.all([
            fetchJsonUtf8("data.json", null),
            fetchJsonUtf8("stocks.json", []),
            fetchJsonUtf8("sbsbiz.json", null),
        ]);
        if (!data) throw new Error("data.json 로드 실패");
        state.data = data;
        state.stocks = Array.isArray(stocks) ? stocks : [];
        state.sbsbiz = sbsbiz;
        // flow.by_code를 _flowCache에 미리 채워 모든 뷰에서 즉시 시그널 계산 가능
        const byCode = data && data.flow && data.flow.by_code;
        if (byCode) {
            for (const code in byCode) {
                _flowCache.set(code, Promise.resolve({ code, name: byCode[code].name, days: byCode[code].days }));
            }
        }
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

/** 5일 수급 데이터를 캐시에서 가져와 시그널 뱃지 HTML 반환.
 * 캐시에 없으면 빈 자리(나중에 lazy-load는 호출자가 알아서). */
function signalBadgeHTML(code, opts = {}) {
    const cached = state.data && state.data.flow && state.data.flow.by_code && state.data.flow.by_code[code];
    if (!cached || !cached.days || cached.days.length === 0) {
        return `<span class="signal-mini signal-na">매매 신호 —</span>`;
    }
    const sent = getSentimentForCode(code);
    const sig = calcSignal(cached.days, sent);
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
                        <th>매매 신호</th>
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
                                    <div class="name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)}</div>
                                    <div class="meta"><span class="code">${s.code}</span> · 뉴스 ${s.news_count || 0}건 · 점수 ${s.total_score || 0}</div>
                                </td>
                                <td>${signalBadgeHTML(s.code, {compact: true})}</td>
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
                                <span class="snc-name" onclick="goSearch('${s.code}')">${escapeHtml(s.name)}</span>
                                <span class="snc-code">${s.code}</span>
                            </div>
                            <div class="snc-badge">📰 ${s.news_count}건</div>
                            ${favIconHTML(s.code)}
                        </header>
                        <div class="snc-signal-row">${signalBadgeHTML(s.code)}</div>
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
                            <th>매매 신호</th>
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
                                    </td>
                                    <td>${signalBadgeHTML(r.code, {compact: true})}</td>
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
 * 단순 휴리스틱 — 향후 1-2일 매수/매도 우위 시그널.
 * 근거: 최근 5일 외인·기관 수급 패턴 + 당일 등락 + (선택) 뉴스 호재/악재
 * ⚠ 투자 권유 아님, 참고용 데이터.
 *
 * @param {Array} flowDays - 5일 수급 데이터
 * @param {Object} [sentiment] - 옵션. { pos, neg, neu } 종목 관련 뉴스 호재/악재 카운트
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

    // 뉴스 호재/악재 영향도 (있을 때만)
    if (sentiment && (sentiment.pos > 0 || sentiment.neg > 0)) {
        const net = (sentiment.pos || 0) - (sentiment.neg || 0);
        // ±5점 한도 — 수급보다 영향 작게
        let newsAdj = 0;
        if (net >= 5) newsAdj = 5;
        else if (net >= 3) newsAdj = 3;
        else if (net >= 1) newsAdj = 1;
        else if (net <= -5) newsAdj = -5;
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
                                    <th>매매 신호</th>
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
                                            <span class="mentions" title="자막/텍스트 언급 횟수">×${st.mentions}</span>
                                        </td>
                                        <td>${signalBadgeHTML(st.code, {compact: true})}</td>
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
        const sig = calcSignal(days, getSentimentForCode(s.code));

        const newsHtml = news.filter(n => n && n.title && !n.error).slice(0, 2).map(n => `
            <a class="fav-news-item" href="${escapeHtml(n.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
                ${escapeHtml(n.title)}
            </a>
        `).join("");

        return `
            <div class="card fav-card" onclick="goSearch('${s.code}')">
                <button class="remove" onclick="removeFav(event, '${s.code}')">✕</button>
                <div class="name">${escapeHtml(s.name)}</div>
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
                    <div class="fav-signal ${sig.cls}" title="${escapeHtml(sig.reasons.join(' · '))}">
                        <span class="sig-arrow">${sig.cls.includes('buy') ? '▲' : sig.cls.includes('sell') ? '▼' : '•'}</span>
                        <span class="sig-label">${sig.label}</span>
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

    const [stock, news, flow] = await Promise.all([
        fetchJsonUtf8(`/api/stock?code=${code}`, { error: "조회 실패" }),
        fetchJsonUtf8(`/api/news?q=${encodeURIComponent(newsQuery)}&display=20`, []),
        fetchFlowCached(code),
    ]);

    if (stock.error) {
        main.innerHTML = `<div class="placeholder">시세 조회 실패: ${escapeHtml(stock.error)}</div>`;
        return;
    }
    const ch = formatChange(stock.change, stock.change_pct);
    const fav = isFavorite(code);
    const newsArr = Array.isArray(news) ? news : [];
    const sig = calcSignal((flow && flow.days) || [], getSentimentForCode(code));

    main.innerHTML = `
        <div class="search-result">
            <div>
                <div class="stock-detail">
                    <div class="name-block">
                        <h2>${escapeHtml(stock.name || stockName || "(이름 없음)")}</h2>
                        <span class="stock-code">${stock.code}${stockMaster ? ` · ${stockMaster.market}` : ""}</span>
                    </div>
                    <div class="price-block">
                        <div class="price-now">${formatPrice(stock.price)}원</div>
                        <div class="change-info ${ch.cls}">${ch.text}</div>
                        <div class="prev-close">전일 ${formatPrice(stock.prev_close)}원</div>
                    </div>
                    ${flow && flow.days && flow.days.length >= 2 ? `
                        <div class="search-chart-block">
                            <div class="search-chart-label">최근 ${flow.days.length}일 종가 추이</div>
                            ${chartHTML(flow.days, {width: 420, height: 180})}
                        </div>
                    ` : ""}
                    ${flow && flow.days && flow.days.length ? `
                        <div class="search-signal-block">
                            <div class="signal-line">
                                <span class="signal-line-label">매매 신호</span>
                                <span class="signal-mini ${sig.cls}">${sig.label}</span>
                            </div>
                            <div class="signal-reason">${escapeHtml(sig.reasons.join(' · '))}</div>
                        </div>
                    ` : ""}
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
}

main();
