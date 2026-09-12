/**
 * us-market.js — 미국장 데이터 수집.
 *
 * 한국장과 갈라놓은 이유:
 *  - 출처가 완전히 다르다(나스닥 스크리너 + 야후 차트).
 *  - 야후는 공식 API가 아니라 사이트가 쓰는 경로를 그대로 부르는 것이라
 *    한도가 빡빡하다(체감 초당 2건, 시간당 2천건). 네이버처럼 6개씩 몰아치면 429가 뜬다.
 *  - 미국은 기관·외국인 일별 순매수 공개 데이터가 없다. 수급 축은 애초에 만들 수 없다.
 *
 * 지표 계산과 조건 판정은 momentum-core.js를 그대로 쓴다 — 시장을 가리지 않는다.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** "$123.45" / "1,234,567" / "" → 숫자 또는 null */
function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,%\s,]/g, '').replace(/,/g, '');
  if (!s || s === '--' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── 유니버스 ───────────────────────── */

/**
 * 워런트·유닛·우선주처럼 스크리너 결과에 섞여 들어오는 비주식 종목을 걸러낸다.
 * 이런 것들은 거래가 얇고 지표가 무의미한데 이름만 보면 멀쩡해 보인다.
 */
function isOrdinaryShare(row) {
  const sym = String(row.symbol || '');
  const name = String(row.name || '');
  if (/[\^/]/.test(sym)) return false;                 // BRK/B 류는 따로 정규화, 그 외 기호는 제외
  if (/\.(W|U|R|P)$/i.test(sym)) return false;         // 워런트·유닛·권리·우선주
  if (/\b(Warrant|Unit|Right|Depositary|Preferred|Notes?|Debenture)\b/i.test(name)) return false;
  return true;
}

/** 나스닥 표기를 야후 표기로. BRK/B → BRK-B */
function toYahooSymbol(sym) {
  return String(sym).trim().replace(/\//g, '-');
}

/**
 * 나스닥 스크리너에서 미국 상장 전 종목을 받는다(약 7천 건, 요청 1회).
 * 기본 User-Agent로는 막히므로 브라우저 헤더를 붙인다.
 */
async function fetchUsScreenerRows() {
  const url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true';
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.nasdaq.com/market-activity/stocks/screener',
    },
  });
  if (!res.ok) throw new Error(`나스닥 스크리너 HTTP ${res.status}`);
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error('나스닥 스크리너 응답이 JSON이 아닙니다: ' + text.slice(0, 120)); }

  const rows = j?.data?.rows || j?.data?.table?.rows || [];
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('나스닥 스크리너에서 종목을 읽지 못했습니다 (응답 구조 변경 가능성)');
  }
  return rows;
}

/**
 * 필터를 건 뒤 정렬해서 후보군을 만든다.
 *
 * mode:
 *   marketCap — 시가총액 상위. 안정적이지만 움직이는 중소형주를 놓친다.
 *   turnover  — 거래대금 상위. 단 여기서 쓰는 거래량은 "당일" 값이라 하루짜리
 *               급등주가 섞인다. 그래서 후보군만 넓게 잡고, 진짜 20일 평균
 *               거래대금은 일봉을 받아서 계산한 뒤 거른다(runUsMomentum 참고).
 */
function buildUsUniverse(rows, opt) {
  const minPrice = opt.minPrice ?? 5;
  const minCapUsd = (opt.minMarketCapM ?? 500) * 1e6;

  const cleaned = [];
  const rejected = { nonOrdinary: 0, price: 0, marketCap: 0, noData: 0 };

  for (const r of rows) {
    if (!isOrdinaryShare(r)) { rejected.nonOrdinary++; continue; }
    const price = toNum(r.lastsale);
    const cap = toNum(r.marketCap);
    const vol = toNum(r.volume);
    if (price == null || cap == null) { rejected.noData++; continue; }
    if (price < minPrice) { rejected.price++; continue; }
    if (cap < minCapUsd) { rejected.marketCap++; continue; }
    cleaned.push({
      code: toYahooSymbol(r.symbol),
      nasdaqSymbol: String(r.symbol).trim(),
      name: String(r.name || '').trim(),
      market: 'US',
      price, marketCapUsd: cap,
      dayTurnoverUsd: (vol != null) ? price * vol : 0,
      sector: (r.sector && r.sector !== 'N/A') ? String(r.sector) : null,
      industry: (r.industry && r.industry !== 'N/A') ? String(r.industry) : null,
      ipoYear: toNum(r.ipoyear),
    });
  }

  const key = opt.mode === 'turnover' ? 'dayTurnoverUsd' : 'marketCapUsd';
  cleaned.sort((a, b) => b[key] - a[key]);
  return { list: cleaned, rejected, sortedBy: key };
}

/* ───────────────────────── 일봉 ───────────────────────── */

/**
 * 야후 차트 엔드포인트. 사이트가 직접 쓰는 경로라 키가 필요 없지만
 * 공식 API가 아니어서 예고 없이 바뀔 수 있고, 한도를 넘기면 429가 온다.
 */
async function fetchYahooBars(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range || '1y'}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 429) throw new Error('429 한도 초과');
  if (!res.ok) throw new Error(`야후 HTTP ${res.status}`);
  const j = JSON.parse(await res.text());

  const r = j?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) {
    const msg = j?.chart?.error?.description || '일봉 없음';
    throw new Error('야후 응답에서 일봉을 찾지 못했습니다: ' + msg);
  }
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (c == null || h == null || l == null) continue;   // 거래정지일은 null로 온다
    out.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: o ?? c, high: h, low: l, close: c, volume: v ?? 0,
    });
  }
  if (out.length < 60) throw new Error('일봉이 ' + out.length + '개뿐입니다');
  return out;
}

/**
 * 예비 경로. 야후가 막히면 Stooq CSV로 받는다.
 * 컬럼: Date,Open,High,Low,Close,Volume
 */
async function fetchStooqBars(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 60) throw new Error('Stooq 응답이 비었습니다');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, o, h, l, c, v] = lines[i].split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const close = Number(c);
    if (!Number.isFinite(close)) continue;
    out.push({ date: d, open: Number(o) || close, high: Number(h), low: Number(l), close, volume: Number(v) || 0 });
  }
  if (out.length < 60) throw new Error('Stooq 일봉이 ' + out.length + '개뿐입니다');
  return out;
}

/**
 * 네이버 해외주식 일봉.
 *
 * 야후·Stooq가 Render 서버 IP를 막아버려서 미국장이 통째로 멈췄다(2026-09).
 * 네이버는 국내 스크리너에서 이미 잘 응답하고 있으므로, 같은 경로로 해외 종목도
 * 받아본다. 네이버는 로이터 방식 심볼(AAPL.O 같은 거래소 접미사)을 쓰는데
 * 접미사가 종목마다 달라서, 후보를 순서대로 시도한다.
 */
async function fetchNaverForeignBars(symbol, suffixes, days) {
  const cands = suffixes || ['.O', '.N', '.A', ''];
  const back = days || 400;
  const errors = [];
  for (const suf of cands) {
    const sym = symbol + suf;
    const url = `https://api.stock.naver.com/chart/foreign/item/${encodeURIComponent(sym)}/day`
      + `?startDateTime=${ymdhm(-back)}&endDateTime=${ymdhm(0)}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://m.stock.naver.com/' },
      });
      if (!res.ok) { errors.push(`${sym}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { errors.push(`${sym}: JSON 아님`); continue; }

      const rows = Array.isArray(j) ? j : (j.priceInfos || j.result || j.data || []);
      const out = [];
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const d = String(r.localDate || r.dt || r.date || '');
        const m = d.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
        const close = toNum(r.closePrice ?? r.close ?? r.clos);
        const high = toNum(r.highPrice ?? r.high);
        const low = toNum(r.lowPrice ?? r.low);
        if (!m || close == null || high == null || low == null) continue;
        out.push({
          date: `${m[1]}-${m[2]}-${m[3]}`,
          open: toNum(r.openPrice ?? r.open) ?? close,
          high, low, close,
          volume: toNum(r.accumulatedTradingVolume ?? r.volume) ?? 0,
        });
      }
      if (out.length >= 60) {
        out.sort((a, b) => a.date.localeCompare(b.date));
        return { bars: out, naverSymbol: sym };
      }
      errors.push(`${sym}: ${out.length}봉`);
    } catch (e) {
      errors.push(`${sym}: ${e.message}`);
    }
  }
  throw new Error('네이버 해외 일봉 실패 — ' + errors.join(' | '));
}

/** 'YYYYMMDDHHmm' (offsetDays만큼 과거) */
function ymdhm(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}0000`;
}

/**
 * 일봉 수집. 경로가 막히는 일이 잦아 셋을 순서대로 시도하고,
 * 전부 실패하면 각 경로의 실패 사유를 모두 담아 던진다.
 * (예전에는 마지막 경로의 오류만 보여줘서 진짜 원인을 알 수 없었다.)
 */
async function fetchUsBars(symbol, range) {
  const errors = [];
  const days = ({ '1y': 400, '2y': 760, '5y': 1850, '10y': 3700 })[range] || 400;
  try {
    return { bars: await fetchYahooBars(symbol, range || '1y'), source: 'yahoo' };
  } catch (e) { errors.push('yahoo: ' + e.message); }

  try {
    const r = await fetchNaverForeignBars(symbol, null, days);
    return { bars: r.bars, source: 'naver-foreign', naverSymbol: r.naverSymbol, note: errors.join(' | ') };
  } catch (e) { errors.push('naver: ' + e.message); }

  try {
    return { bars: await fetchStooqBars(symbol), source: 'stooq', note: errors.join(' | ') };
  } catch (e) { errors.push('stooq: ' + e.message); }

  throw new Error(errors.join(' | '));
}


/* ───────────────────────── 재무 ───────────────────────── */

/** 야후 응답은 { raw, fmt, longFmt } 로 감싸 오기도 하고 맨 숫자로 오기도 한다. */
function rawNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v.raw != null) return Number.isFinite(v.raw) ? v.raw : null;
  return toNum(v);
}

/**
 * 야후 quoteSummary에서 BPS·ROE·발행주식수를 읽는다.
 *
 * 주의: 이 경로는 2026년 들어 쿠키/크럼을 요구하며 401을 내는 일이 잦다.
 * 실패해도 스캔은 계속되고 화면에는 "재무 없음"으로 표시된다.
 *
 * 한계 하나 더: 여기서 얻는 ROE는 최근 12개월(trailing) 한 개뿐이다.
 * S-RIM은 3년 가중평균을 쓰는데 3년치가 없으므로 같은 값을 세 번 넣는다.
 * 결과적으로 "최근 ROE가 그대로 유지된다"는 가정이 되므로, 실적 변동이 큰
 * 기업에서는 한국장 탭보다 신뢰도가 떨어진다.
 */
/**
 * 네이버 해외종목 기본정보에서 BPS·ROE·주식수를 찾는다.
 *
 * 야후 quoteSummary가 401/429로 막혀 적정주가가 전부 "재무 조회 실패"로 나왔다.
 * 네이버 쪽은 응답하고 있으므로 같은 값을 여기서 찾아본다.
 * 응답 구조를 특정하지 않고 키 이름·라벨 패턴으로 훑는다 — 판이 바뀌어도 버티게.
 */
function findNumberDeep(node, keyRe, depth) {
  if (node == null || (depth || 0) > 7) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findNumberDeep(v, keyRe, (depth || 0) + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const n = toNum(v);
      if (n != null) return n;
    }
  }
  // { key: "BPS", value: "4.32" } 같은 목록형
  const label = [node.code, node.key, node.title, node.name].find(v => typeof v === 'string');
  if (label && keyRe.test(label)) {
    const n = toNum(node.value ?? node.currentValue);
    if (n != null) return n;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = findNumberDeep(v, keyRe, (depth || 0) + 1);
      if (r != null) return r;
    }
  }
  return null;
}

async function fetchNaverUsFundamentals(symbol) {
  const errors = [];
  for (const suf of ['.O', '.N', '.A']) {
    const url = `https://api.stock.naver.com/stock/${symbol}${suf}/basic`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://m.stock.naver.com/' },
      });
      if (!res.ok) { errors.push(`${suf}: HTTP ${res.status}`); continue; }
      const j = JSON.parse(await res.text());
      const bps = findNumberDeep(j, /^bps$|주당순자산/i, 0);
      const roePct = findNumberDeep(j, /^roe$/i, 0);
      const shares = findNumberDeep(j, /listed.*(share|stock).*(count|cnt)|상장주식수|sharesOutstanding/i, 0);
      if (bps == null && roePct == null) { errors.push(`${suf}: BPS·ROE 없음`); continue; }
      return {
        sourceUrl: url, bps, shares, roePct,
        equityUsd: (bps != null && shares != null) ? bps * shares : null,
        roeIsTrailingOnly: true,
      };
    } catch (e) {
      errors.push(`${suf}: ${e.message}`);
    }
  }
  throw new Error('네이버 해외 재무 실패 — ' + errors.join(' | '));
}

async function fetchUsFundamentals(symbol) {
  const modules = 'defaultKeyStatistics,financialData,price';
  const hosts = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
  let lastErr = null;

  for (const host of hosts) {
    const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!res.ok) { lastErr = new Error(`quoteSummary HTTP ${res.status}`); continue; }
      const j = JSON.parse(await res.text());
      const r = j?.quoteSummary?.result?.[0];
      if (!r) { lastErr = new Error('quoteSummary 결과 없음'); continue; }

      const ks = r.defaultKeyStatistics || {};
      const fd = r.financialData || {};
      const bps = rawNum(ks.bookValue);
      const shares = rawNum(ks.sharesOutstanding);
      const roeFrac = rawNum(fd.returnOnEquity);      // 비율(0.15 = 15%)
      const roePct = roeFrac == null ? null : roeFrac * 100;

      if (bps == null && roePct == null) { lastErr = new Error('BPS·ROE 둘 다 없음'); continue; }
      return {
        sourceUrl: url, bps, shares, roePct,
        equityUsd: (bps != null && shares != null) ? bps * shares : null,
        roeIsTrailingOnly: true,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  // 야후가 전부 막혔으면 네이버로 넘어간다.
  try {
    return await fetchNaverUsFundamentals(symbol);
  } catch (e) {
    throw new Error('yahoo: ' + (lastErr ? lastErr.message : '실패') + ' | ' + e.message);
  }
}

module.exports = {
  toNum, isOrdinaryShare, toYahooSymbol, sleep,
  fetchUsScreenerRows, buildUsUniverse,
  fetchYahooBars, fetchStooqBars, fetchNaverForeignBars, fetchUsBars, ymdhm,
  fetchUsFundamentals, fetchNaverUsFundamentals, findNumberDeep, rawNum,
};
