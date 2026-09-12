/**
 * fairprice-proxy — 상황별 적정주가 계산기용 데이터 프록시
 *
 * 브라우저는 네이버 금융·FnGuide를 직접 호출할 수 없습니다(CORS).
 * 이 서버가 대신 페이지를 받아 파싱한 뒤 JSON으로 넘겨줍니다.
 *
 * 엔드포인트
 *   GET /api/health
 *   GET /api/search?q=삼성전자        종목명 → 종목코드
 *   GET /api/stock/005930             계산기에 필요한 값 일괄 수집
 *   GET /api/raw/005930?src=fnguide   원본 HTML (파싱이 깨졌을 때 확인용)
 *   GET /stats                        방문자 통계 (Basic Auth, 소유자 전용)
 *   GET /screener.html, /api/screen   저평가·수급 스크리너 (Basic Auth, 소유자 전용)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { fairValue, gapPct } = require('./public/fairvalue-core.js');
const MC = require('./public/momentum-core.js');
const US = require('./us-market.js');
const BT = require('./backtest.js');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

app.set('trust proxy', true);   // Render는 프록시 뒤에 있어, 이게 있어야 req.ip가 실제 접속자 IP를 가리킴

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    recordVisit(req).catch(() => {});
  }
  next();
});

// screener.html은 스크래핑 요청량이 훨씬 커서(수백 건) /stats와 같은 계정으로 막아둔다.
// express.static보다 먼저 등록해야 이 라우트가 우선한다.
app.get('/screener.html', checkStatsAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'screener.html'));
});

// 모멘텀 스크리너는 종목당 일봉 120일치를 받아오므로 요청량이 더 크다 — 같은 계정으로 막는다.
app.get('/momentum.html', checkStatsAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'momentum.html'));
});

app.get('/backtest.html', checkStatsAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'backtest.html'));
});

app.get('/us-momentum.html', checkStatsAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'us-momentum.html'));
});

// HTML은 캐시하지 않는다.
// 고친 화면을 올렸는데 브라우저가 예전 파일을 계속 보여줘서 "왜 안 바뀌냐"로
// 시간을 버린 적이 있다. js/css는 정상 캐시하되 html만 매번 새로 받게 한다.
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store, must-revalidate');
  },
}));

/* ───────────────────────── 캐시 ───────────────────────── */
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  cache.delete(key);
  return null;
}
function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

// 과거 시세는 지나간 날짜 값이 안 바뀌므로 훨씬 길게 캐시한다 (오늘 하루치만 갱신 대상).
const HIST_CACHE_MS = 12 * 60 * 60 * 1000;
const histCache = new Map();
function histCacheGet(key) {
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.t < HIST_CACHE_MS) return hit.v;
  histCache.delete(key);
  return null;
}
function histCacheSet(key, v) {
  histCache.set(key, { t: Date.now(), v });
  if (histCache.size > 200) histCache.delete(histCache.keys().next().value);
}

/* ───────────────────────── 공통 유틸 ───────────────────────── */

// 한국 금융 사이트는 EUC-KR이 섞여 있어 메타 태그를 보고 디코딩한다.
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
  const euc = /charset\s*=\s*["']?\s*(euc-kr|ks_c_5601)/.test(head);
  return euc ? iconv.decode(buf, 'euc-kr') : buf.toString('utf8');
}

// "1,234", "-5.6", "12.3%", "(1,234)" → 숫자. 값이 없으면 null.
function toNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/\s|,|%|원|주|배/g, '').trim();
  if (!t || t === '-' || t === 'N/A') return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

/**
 * 라벨 텍스트로 표의 행을 찾는다.
 * ID나 클래스 대신 "지배주주지분" 같은 항목명으로 찾기 때문에
 * 사이트가 마크업을 바꿔도 잘 버틴다.
 */
function rowByLabel($, patterns) {
  let found = null;
  $('tr').each((_, tr) => {
    if (found) return;
    const cells = $(tr).children('th,td');
    if (cells.length < 2) return;
    const label = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    if (!label) return;
    const hit = patterns.some(p => (p instanceof RegExp ? p.test(label) : label.includes(p)));
    if (!hit) return;
    const values = [];
    cells.slice(1).each((_, td) => values.push($(td).text().replace(/\s+/g, ' ').trim()));
    found = { label, values, nums: values.map(toNum) };
  });
  return found;
}

/* ───────────────────────── 네이버 금융 ───────────────────────── */

/* ───────────── 종목 기본정보: API 우선, HTML은 예비 ─────────────
 *
 * 2026-09, 네이버가 종목 페이지(item/main.naver)도 Next.js로 재구축하면서
 * #_nowVal, p.no_today 같은 현재가 요소가 HTML에서 사라졌다. 현재가를 못 읽으니
 * 저평가 스크리너가 전 종목을 "데이터 부족"으로 탈락시켰고 계산기도 멈췄다.
 *
 * 그래서 JSON API를 먼저 쓴다. 마크업과 달리 API 응답은 화면 개편에 잘 흔들리지 않고,
 * 키 이름만 보고 찾으므로 감싸는 구조가 바뀌어도 버틴다.
 */

/**
 * "1,605조 5,679억원" 같은 한국식 금액 표기를 원 단위 숫자로 바꾼다.
 * 네이버 종목 API의 totalInfos는 화면에 그대로 쓰는 표시용 문자열이라
 * 조·억·만 단위가 섞여 있어서, 쉼표만 떼서는 숫자가 되지 않는다.
 */
function parseKoreanAmount(str) {
  if (str == null) return null;
  let rest = String(str).replace(/[\s,]/g, '');
  if (!rest) return null;
  let total = 0, matched = false;
  for (const [unit, mul] of [['조', 1e12], ['억', 1e8], ['만', 1e4]]) {
    const m = rest.match(new RegExp('(-?[\\d.]+)' + unit));
    if (!m) continue;
    total += parseFloat(m[1]) * mul;
    matched = true;
    rest = rest.slice(rest.indexOf(unit) + 1);
  }
  if (!matched) return toNum(rest);
  const tail = rest.match(/^(-?[\d.]+)/);   // 단위 뒤에 남은 원 단위 숫자
  if (tail) total += parseFloat(tail[1]);
  return total;
}

/**
 * { code, key, value } 목록(totalInfos)에서 라벨로 값을 찾는다.
 * value가 "86,052원", "1,605조 5,679억원"처럼 표시용 문자열이라 단위 해석이 필요하다.
 */
function pickTotalInfo(node, keyRe, out, depth) {
  out = out || { value: null };
  if (out.value != null || node == null || (depth || 0) > 7) return out;
  if (Array.isArray(node)) {
    node.forEach(v => pickTotalInfo(v, keyRe, out, (depth || 0) + 1));
    return out;
  }
  if (typeof node !== 'object') return out;
  // 같은 항목이 code('marketValue')와 key('시가총액')로 이름이 다르게 붙어 있다.
  // 하나만 보고 판단하면 놓치므로 후보를 전부 대조한다.
  const labels = [node.code, node.key, node.title, node.name].filter(v => typeof v === 'string' && v.trim());
  const hit = labels.find(v => keyRe.test(v));
  if (hit && (typeof node.value === 'string' || typeof node.value === 'number')) {
    out.value = parseKoreanAmount(node.value);
    out.label = hit;
    out.desc = node.valueDesc || null;
    return out;
  }
  Object.values(node).forEach(v => {
    if (v && typeof v === 'object') pickTotalInfo(v, keyRe, out, (depth || 0) + 1);
  });
  return out;
}

/** JSON 어디에 묻혀 있든 키 이름 패턴으로 값을 찾아낸다. */
function findValueByKey(node, keyRe, depth) {
  if (node == null || (depth || 0) > 8) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findValueByKey(v, keyRe, (depth || 0) + 1);
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
  // 네이버 API는 { key: "상장주식수", value: "5,969,782,550" } 형태의 목록도 쓴다.
  const label = node.key ?? node.title ?? node.name;
  const value = node.value ?? node.currentValue;
  if (typeof label === 'string' && keyRe.test(label) && value != null) {
    const n = toNum(value);
    if (n != null) return n;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = findValueByKey(v, keyRe, (depth || 0) + 1);
      if (r != null) return r;
    }
  }
  return null;
}

function findStringByKey(node, keyRe, depth) {
  if (node == null || (depth || 0) > 8) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findStringByKey(v, keyRe, (depth || 0) + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k) && typeof v === 'string' && v.trim() && !/^[\d,.\-]+$/.test(v)) return v.trim();
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = findStringByKey(v, keyRe, (depth || 0) + 1);
      if (r) return r;
    }
  }
  return null;
}

async function fetchJson(url, referer) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: referer || 'https://m.stock.naver.com/' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error('JSON 아님: ' + text.slice(0, 120)); }
}

const PRICE_KEY = /^(close|now|current|trade|last)?price$|^nowVal$|^closePrice$/i;
const STOCK_NAME_KEY = /^(stock|item)?name$/i;
const SHARES_KEY = /listed.*(stock|share).*(count|cnt)|stockTotCnt|shareTotCnt|상장주식수/i;
const BPS_KEY = /^bps$/i;

/**
 * 종목 기본정보를 JSON API에서 가져온다.
 * 세 경로를 모두 시도하고 얻은 값을 합친다 — 한 경로가 죽어도 나머지로 메운다.
 * 특히 마지막 trend API는 수급 스크리너가 이미 쓰고 있어 동작이 검증된 경로라,
 * 현재가만큼은 여기서라도 확보된다.
 */
async function fromNaverApi(code) {
  const attempts = [
    { name: 'basic', url: `https://m.stock.naver.com/api/stock/${code}/basic` },
    { name: 'integration', url: `https://m.stock.naver.com/api/stock/${code}/integration` },
    { name: 'trend', url: `https://stock.naver.com/api/domestic/detail/${code}/trend?tradeType=KRX&startIdx=0&pageSize=1` },
  ];
  const out = {
    sourceUrl: attempts[0].url, apiSources: [],
    price: null, name: null, shares: null, bps: null, marketCapWon: null, sharesNote: null,
  };
  const errors = [];

  for (const a of attempts) {
    let j;
    try { j = await fetchJson(a.url, a.name === 'trend' ? 'https://stock.naver.com/' : undefined); }
    catch (e) { errors.push(`${a.name}: ${e.message}`); continue; }
    out.apiSources.push(a.name);
    if (out.price == null) out.price = findValueByKey(j, PRICE_KEY, 0);
    if (out.name == null) out.name = findStringByKey(j, STOCK_NAME_KEY, 0);
    if (out.shares == null) out.shares = findValueByKey(j, SHARES_KEY, 0);
    // BPS·시가총액은 표시용 문자열("86,052원", "1,605조 5,679억원")이라 단위 해석이 필요하다.
    if (out.bps == null) out.bps = pickTotalInfo(j, /^bps$|^BPS$/, null, 0).value ?? findValueByKey(j, BPS_KEY, 0);
    if (out.marketCapWon == null) out.marketCapWon = pickTotalInfo(j, /^marketValue$|시가총액/, null, 0).value;
  }

  // 네이버 API에는 상장주식수 항목이 없다. 시가총액 ÷ 현재가로 역산한다.
  // 우선주는 시가총액에 안 들어가므로 보통주 기준으로 맞는 값이 나온다.
  if (out.shares == null && out.marketCapWon > 0 && out.price > 0) {
    out.shares = Math.round(out.marketCapWon / out.price);
    out.sharesNote = '시가총액 ÷ 현재가로 역산';
  }

  if (out.price == null) {
    const e = new Error('현재가를 어떤 API에서도 읽지 못했습니다 — ' + (errors.join(' | ') || '값 없음'));
    e.apiErrors = errors;
    throw e;
  }
  out.errors = errors;
  return out;
}

/**
 * 라벨이 붙은 시계열 행을 JSON에서 찾아낸다.
 *
 * 네이버 재무 API는 대략 { rowList: [{ title:"ROE", columns:{ "202312":{value:"9.1"}, ... } }] }
 * 꼴인데, 감싸는 이름이나 값 자리(value/val/amount)가 판마다 다르다.
 * 그래서 "문자열 라벨 + 기간별 숫자 묶음"이라는 모양만 보고 뽑는다.
 */
function extractLabeledSeries(node, out, depth) {
  out = out || [];
  if (node == null || (depth || 0) > 7) return out;
  if (Array.isArray(node)) {
    node.forEach(v => extractLabeledSeries(v, out, (depth || 0) + 1));
    return out;
  }
  if (typeof node !== 'object') return out;

  const label = [node.title, node.key, node.name, node.itemName, node.accountName]
    .find(v => typeof v === 'string' && v.trim());
  if (label) {
    // 기간별 값이 담긴 자리를 찾는다. 객체({기간:{value}})든 배열이든 받는다.
    for (const [k, v] of Object.entries(node)) {
      if (!v || typeof v !== 'object') continue;
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      if (entries.length < 2 || entries.length > 24) continue;
      const values = entries.map(([, cell]) => {
        if (cell == null) return null;
        if (typeof cell === 'string' || typeof cell === 'number') return toNum(cell);
        if (typeof cell === 'object') {
          const inner = [cell.value, cell.val, cell.amount, cell.num].find(x => x != null);
          return inner == null ? null : toNum(inner);
        }
        return null;
      });
      if (values.filter(x => x != null).length >= 2) {
        out.push({ label: label.trim(), field: k, periods: entries.map(([p]) => p), values });
        break;
      }
    }
  }
  Object.values(node).forEach(v => {
    if (v && typeof v === 'object') extractLabeledSeries(v, out, (depth || 0) + 1);
  });
  return out;
}

/**
 * 네이버 재무 API에서 ROE·지배주주지분을 읽는다.
 * FnGuide 파싱이 값을 못 낼 때를 대비한 두 번째 출처.
 */
/**
 * 추정치(컨센서스) 기간을 골라낸다.
 *
 * 네이버 연간 재무에는 마지막에 (E)가 붙은 추정 컬럼이 섞여 들어온다.
 * 실제로 삼성전자 ROE가 [4.15, 9.03, 10.85, 56.4]로 나왔는데 마지막 값은
 * 실적이 아니다. 컬럼 제목 목록에서 (E)가 붙은 기간 키를 추려 걸러낸다.
 */
function collectEstimatePeriods(node, set, depth) {
  set = set || new Set();
  if (node == null || (depth || 0) > 7) return set;
  if (Array.isArray(node)) {
    node.forEach(v => collectEstimatePeriods(v, set, (depth || 0) + 1));
    return set;
  }
  if (typeof node !== 'object') return set;

  const key = node.key ?? node.period ?? node.columnKey;
  const title = node.title ?? node.name ?? node.label;
  const isEstimate = node.isEstimate === true || node.estimate === true
    || (typeof title === 'string' && /\(\s*E\s*\)/i.test(title));
  if (isEstimate && key != null) set.add(String(key));

  Object.values(node).forEach(v => {
    if (v && typeof v === 'object') collectEstimatePeriods(v, set, (depth || 0) + 1);
  });
  return set;
}

async function fromNaverFinance(code) {
  const urls = [
    `https://m.stock.naver.com/api/stock/${code}/finance/annual`,
    `https://api.stock.naver.com/stock/${code}/finance/annual`,
  ];
  const out = { sourceUrl: urls[0], roeSeries: null, bps: null, equityEok: null };
  let rows = null, estimates = new Set(), lastErr = null;
  for (const u of urls) {
    try {
      const j = await fetchJson(u);
      rows = extractLabeledSeries(j, [], 0);
      if (rows.length) { estimates = collectEstimatePeriods(j, null, 0); out.sourceUrl = u; break; }
    } catch (e) { lastErr = e.message; }
  }
  if (!rows || !rows.length) throw new Error('재무 API에서 항목을 읽지 못했습니다' + (lastErr ? ' — ' + lastErr : ''));

  const find = (re) => rows.find(r => re.test(r.label));
  /** 기간·값 쌍으로 돌려주되 추정치 컬럼은 뺀다. */
  const seriesOf = (re) => {
    const r = find(re);
    if (!r) return null;
    const pairs = r.periods.map((p, i) => ({ period: p, value: r.values[i] }))
      .filter(x => x.value != null && !estimates.has(String(x.period)));
    return pairs.length ? pairs : null;
  };

  const roe = seriesOf(/^ROE/i);
  if (roe) {
    out.roeSeries = roe.map(x => x.value);
    out.roeColumns = roe;         // 어느 기간 값을 썼는지 확인용
  }
  out.estimatePeriods = [...estimates];

  const bps = seriesOf(/^BPS/i);
  if (bps) out.bps = bps[bps.length - 1].value;

  // 이 API에는 자본총계·지배주주지분 항목이 없다(2026-09 확인).
  // 그래도 판이 바뀌어 생기면 바로 쓰도록 찾아는 둔다.
  const eq = seriesOf(/지배주주지분|지배기업.*소유주|지배기업주주지분/) || seriesOf(/^자본총계/);
  if (eq) {
    out.equityEok = eq[eq.length - 1].value;   // 억원 단위
    out.equityIsConsolidatedTotal = !find(/지배주주지분|지배기업/);
  }
  out.labelsSeen = rows.map(r => r.label).slice(0, 40);
  return out;
}

async function fromNaver(code) {
  const url = `https://finance.naver.com/item/main.naver?code=${code}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const out = { sourceUrl: url };

  out.name = $('.wrap_company h2 a').first().text().trim()
          || $('.wrap_company h2').first().text().trim()
          || null;

  // 현재가: 여러 위치 중 먼저 잡히는 값
  out.price = toNum($('#_nowVal').first().text())
           ?? toNum($('.no_today .blind').first().text())
           ?? toNum($('p.no_today').first().text());

  const listed = rowByLabel($, ['상장주식수']);
  out.shares = listed ? listed.nums.find(n => n != null) ?? null : null;

  // 기업실적분석 표의 ROE(지배주주). 컬럼 순서 = 과거 → 최근 → 전망(E)
  const roeRow = rowByLabel($, [/^ROE/]);
  if (roeRow) {
    out.roeSeries = roeRow.nums;
    out.roeLabels = $('.tb_type1_ifrs thead tr').last().children('th')
      .map((_, th) => $(th).text().replace(/\s+/g, ' ').trim()).get();
  }

  const bps = rowByLabel($, ['BPS']);
  out.bps = bps ? bps.nums.find(n => n != null) ?? null : null;

  return out;
}

/* ───────────────────────── FnGuide ───────────────────────── */

async function fromFnGuide(code) {
  const url = `https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp`
            + `?pGB=1&gicode=A${code}&cID=&MenuYn=Y&ReportGB=&NewMenuID=101&stkGb=701`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const out = { sourceUrl: url };

  // 연간 재무 하이라이트의 기간 라벨. "(E)"가 붙은 컬럼은 추정치라 제외한다.
  // 첫 칸은 항목명 헤더이므로 빼고 세야 값 컬럼과 자리가 맞는다.
  const periods = [];
  $('#highlight_D_A thead tr').last().children('th').slice(1).each((_, th) => {
    periods.push($(th).text().replace(/\s+/g, ' ').trim());
  });
  out.periods = periods;
  const actualIdx = periods.map((p, i) => ({ p, i })).filter(x => x.p && !/\(E\)/i.test(x.p)).map(x => x.i);

  // 표만 떼어내 다시 파싱한다. innerHTML만 넘기면 thead/tbody가 버려지므로 outerHTML을 쓴다.
  const $hl = cheerio.load($.html($('#highlight_D_A')) || '<table></table>');
  const pick = (pats) => {
    const r = rowByLabel($hl, pats);
    if (!r) return null;
    return { nums: r.nums, label: r.label };
  };

  const equity = pick(['지배주주지분', '지배기업주주지분']);
  const roe = pick([/^ROE/]);
  const capital = pick(['자본총계']);

  const takeActual = (row) => {
    if (!row) return null;
    if (!actualIdx.length) return row.nums.filter(n => n != null);
    return actualIdx.map(i => row.nums[i]).filter(n => n != null);
  };

  const eqSeries = takeActual(equity) || takeActual(capital);
  out.equityEok = eqSeries && eqSeries.length ? eqSeries[eqSeries.length - 1] : null;  // 억원
  out.equityIsConsolidatedTotal = !equity && !!capital;

  const roeSeries = takeActual(roe);
  out.roeSeries = roeSeries || null;

  // 발행주식수 / 자기주식: 표 밖 텍스트에 있는 경우가 많아 본문 전체에서 찾는다.
  const text = $.root().text().replace(/\s+/g, ' ');
  const mShares = text.match(/발행주식수[^0-9]{0,20}([\d,]{4,})/);
  if (mShares) out.shares = toNum(mShares[1]);
  const mTre = text.match(/(?:자기주식|자사주)[^0-9-]{0,20}([\d,]{3,})/);
  if (mTre) out.treasury = toNum(mTre[1]);

  const share = rowByLabel($, [/발행주식수/]);
  if (!out.shares && share) out.shares = share.nums.find(n => n != null) ?? null;

  const tre = rowByLabel($, ['자사주', '자기주식']);
  if (!out.treasury && tre) out.treasury = tre.nums.find(n => n != null) ?? null;

  out.name = $('#giName').first().text().trim() || null;

  return out;
}

/* ───────────────────────── 종목 검색 (이름 → 코드) ─────────────────────────
 *
 * 네이버 모바일 증권의 자동완성 API를 쓴다 (m.stock.naver.com/front-api/search/autoComplete).
 * 예전에 쓰던 finance.naver.com의 검색결과 페이지·자동완성 API는 둘 다 주소가
 * 없어졌거나(404) 막혀서, 실제로 응답이 오는 이 엔드포인트로 교체했다.
 */
async function searchByNaverPage(q) {
  const url = 'https://m.stock.naver.com/front-api/search/autoComplete?query='
            + encodeURIComponent(q) + '&target=stock';
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error('JSON 파싱 실패: ' + text.slice(0, 120)); }

  const items = (j.result && j.result.items) || [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const code = it && it.code;
    const name = it && it.name;
    if (!code || !name || !/^\d{6}$/.test(code) || seen.has(code)) continue;
    if (it.isEtf === true) continue; // 종목코드가 6자리 숫자인 ETF(레버리지·채권혼합 등)는 제외
    seen.add(code);
    out.push({ code, name });
  }
  return out.slice(0, 10);
}

/* ───────────────────────── 과거 시세 (일별 종가) ─────────────────────────
 *
 * 네이버 금융의 "일별 시세" 페이지를 페이지 단위(10행씩)로 긁는다.
 * id/class 대신 "YYYY.MM.DD" 모양의 셀을 찾아 그 행을 날짜 행으로 인식하고,
 * 바로 다음 칸을 종가로 읽는다 — 표 컬럼 순서(날짜, 종가, 전일비, 시가, 고가, 저가, 거래량)가
 * 바뀌지 않는 한 마크업이 조금 바뀌어도 버틴다.
 */

async function fetchNaverHistoryPage(code, page) {
  const url = `https://finance.naver.com/item/sise_day.naver?code=${code}&page=${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rows = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 2) return;
    const m = $(tds[0]).text().trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    if (!m) return;
    const close = toNum($(tds[1]).text());
    if (close == null) return;
    rows.push({ date: `${m[1]}-${m[2]}-${m[3]}`, close });
  });
  return rows;
}

/**
 * sinceDate('YYYY-MM-DD')까지 거슬러 올라가며 페이지를 긁는다.
 * 한 페이지에 며칠치가 실리는지 미리 알 수 없어서, 배치로 병렬 요청하고
 * 매 배치 뒤 "가장 이른 날짜가 sinceDate에 닿았는지"를 확인해 계속할지 정한다.
 */
async function fetchNaverHistory(code, sinceDate) {
  const cacheKey = 'hist:' + code + ':' + sinceDate;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  const BATCH = 6;
  const MAX_PAGES = 140; // 대략 2.5년치 안전판
  const all = new Map();
  let earliest = '9999-99-99';
  let page = 1;

  while (page <= MAX_PAGES && earliest > sinceDate) {
    const pages = [];
    for (let i = 0; i < BATCH && page <= MAX_PAGES; i++, page++) pages.push(page);
    const results = await Promise.all(pages.map(p => fetchNaverHistoryPage(code, p).catch(() => [])));
    let gotAny = false;
    for (const rows of results) {
      if (rows.length) gotAny = true;
      for (const r of rows) {
        all.set(r.date, r.close);
        if (r.date < earliest) earliest = r.date;
      }
    }
    if (!gotAny) break; // 더 이상 과거 데이터가 없음 (상장 초기까지 다다름)
  }

  const out = [...all.entries()]
    .map(([date, close]) => ({ date, close }))
    .filter(r => r.date >= sinceDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  histCacheSet(cacheKey, out);
  return out;
}

/* ───────────────────────── 조합 ───────────────────────── */

async function getFundamentals(code) {
  const cached = cacheGet('s:' + code);
  if (cached) return { ...cached, cached: true };

  const warnings = [];
  // 네이버는 API와 HTML 두 경로를 모두 시도한다. 2026-09 개편으로 HTML에서
  // 현재가가 사라졌기 때문에, 현재가는 사실상 API 쪽이 담당한다.
  const [a, fin, n, f] = await Promise.allSettled([
    fromNaverApi(code), fromNaverFinance(code), fromNaver(code), fromFnGuide(code),
  ]);
  const api = a.status === 'fulfilled' ? a.value : null;
  const nfin = fin.status === 'fulfilled' ? fin.value : null;
  const naver = n.status === 'fulfilled' ? n.value : null;
  const fn = f.status === 'fulfilled' ? f.value : null;
  if (!api) warnings.push('네이버 API를 읽지 못했습니다: ' + (a.reason?.message || '알 수 없음'));
  if (!nfin) warnings.push('네이버 재무 API를 읽지 못했습니다: ' + (fin.reason?.message || '알 수 없음'));
  if (!naver) warnings.push('네이버 종목페이지를 읽지 못했습니다: ' + (n.reason?.message || '알 수 없음'));
  if (!fn) warnings.push('FnGuide를 읽지 못했습니다: ' + (f.reason?.message || '알 수 없음'));
  if (!api && !nfin && !naver && !fn) {
    const e = new Error('모든 경로를 읽지 못했습니다.');
    e.warnings = warnings;
    throw e;
  }

  // ROE 최근 3개 (과거 → 최근 순)
  let roe = (fn && fn.roeSeries) || (nfin && nfin.roeSeries) || (naver && naver.roeSeries) || [];
  roe = roe.filter(v => v != null).slice(-3);
  while (roe.length < 3) roe.unshift(null);
  if (roe.some(v => v == null)) warnings.push('최근 3년 ROE를 다 채우지 못했습니다. 빈 칸은 직접 입력하십시오.');

  const bps = (naver && naver.bps) ?? (api && api.bps) ?? (nfin && nfin.bps) ?? null;
  const sharesAny = (naver && naver.shares) ?? (api && api.shares) ?? null;
  let equityEok = (fn && fn.equityEok) ?? (nfin && nfin.equityEok) ?? null;
  let equityNote = (fn && fn.equityEok) ? 'FnGuide 지배주주지분 (최근 연간)'
                 : (nfin && nfin.equityEok) ? '네이버 재무 API (최근 연간)'
                 : 'BPS × 상장주식수로 추정한 값 (확인 필요)';
  if (equityEok == null && bps && sharesAny) {
    equityEok = (bps * sharesAny) / 1e8;   // 원 → 억원
    equityNote = 'BPS × 상장주식수로 추정한 값 (확인 필요)';
    warnings.push('지배주주지분을 직접 읽지 못해 BPS × 상장주식수로 추정했습니다. FnGuide에서 실제 값을 확인하십시오.');
  }
  if ((fn && fn.equityIsConsolidatedTotal) || (!(fn && fn.equityEok) && nfin && nfin.equityIsConsolidatedTotal)) {
    warnings.push('지배주주지분 항목이 없어 자본총계를 사용했습니다. 비지배지분이 크면 값이 달라집니다.');
  }

  const shares = (fn && fn.shares) || (naver && naver.shares) || (api && api.shares) || null;
  const treasury = (fn && fn.treasury != null) ? fn.treasury : null;
  if (treasury == null) warnings.push('자사주 수를 읽지 못했습니다. 0으로 두거나 DART에서 확인해 직접 넣으십시오.');
  if (!shares) warnings.push('발행주식수를 읽지 못했습니다. 직접 입력하십시오.');
  else if (api && api.sharesNote && shares === api.shares) {
    warnings.push('발행주식수는 ' + api.sharesNote + '한 값입니다. 정확한 수치는 DART에서 확인하십시오.');
  }

  const payload = {
    code,
    name: (naver && naver.name) || (api && api.name) || (fn && fn.name) || null,
    // 현재가는 API를 우선한다 — 개편된 HTML에서는 더 이상 읽히지 않는다.
    price: (api && api.price) ?? (naver && naver.price) ?? null,
    equityEok: equityEok != null ? Math.round(equityEok) : null,
    equityNote,
    roe,                       // [3년 전, 2년 전, 전년도] 단위 %
    shares,
    treasury: treasury ?? 0,
    bps: bps ?? null,
    warnings,
    sources: {
      naverApi: api ? api.apiSources.join(',') : null,
      naverFinance: nfin ? nfin.sourceUrl : null,
      naver: naver ? naver.sourceUrl : null,
      fnguide: fn ? fn.sourceUrl : null,
    },
    fetchedAt: new Date().toISOString(),
  };

  cacheSet('s:' + code, payload);
  return payload;
}

app.get('/api/stock/:code', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '').padStart(6, '0');
  if (code.length !== 6) return res.status(400).json({ error: '종목코드는 6자리 숫자입니다.' });
  try {
    res.json(await getFundamentals(code));
  } catch (e) {
    res.status(502).json({ error: e.message, warnings: e.warnings || [] });
  }
});

/* ───────────────────────── 종목 검색 ───────────────────────── */

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);

  if (/^\d{6}$/.test(q)) return res.json([{ code: q, name: q }]);

  const cached = cacheGet('q:' + q);
  if (cached) return res.json(cached);

  const errors = [];

  // 1순위: 네이버 모바일 증권 자동완성 API (m.stock.naver.com). 실제로 응답이 오는 걸 확인함.
  try {
    const out = await searchByNaverPage(q);
    if (out.length) {
      cacheSet('q:' + q, out);
      return res.json(out);
    }
  } catch (e) {
    errors.push('검색 페이지: ' + e.message);
  }

  // 2순위: 같은 자동완성 API의 legacy 도메인. 1순위가 도메인/구조를 바꿨을 때의 보조 수단.
  try {
    const url = 'https://ac.stock.naver.com/ac?q=' + encodeURIComponent(q)
              + '&target=stock,index,marketindicator,coin,ipo&st=111';
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let j;
    try { j = JSON.parse(text); }
    catch { throw new Error('JSON 파싱 실패: ' + text.slice(0, 120)); }
    const items = (j.result && j.result.items) || [];
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const code = it && it.code, name = it && it.name;
      if (!code || !name || !/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({ code, name });
    }
    if (out.length) {
      cacheSet('q:' + q, out.slice(0, 10));
      return res.json(out.slice(0, 10));
    }
    errors.push('자동완성(legacy): 결과 없음');
  } catch (e) {
    errors.push('자동완성(legacy): ' + e.message);
  }

  res.status(502).json({
    error: '종목 검색에 실패했습니다. 6자리 종목코드를 직접 넣으십시오.',
    detail: errors,
  });
});

app.get('/api/search-raw', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const src = req.query.src === 'ac' ? 'ac' : 'page';
  try {
    if (src === 'ac') {
      const url = 'https://ac.stock.naver.com/ac?q=' + encodeURIComponent(q)
                + '&target=stock,index,marketindicator,coin,ipo&st=111';
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' } });
      res.type('text/plain').send(`HTTP ${r.status}\n\n` + await r.text());
    } else {
      const url = 'https://finance.naver.com/search/searchList.naver?query=' + encodeURIComponent(q);
      res.type('text/plain').send(await fetchHtml(url));
    }
  } catch (e) {
    res.status(502).send(e.message);
  }
});

/* ───────────────────────── 과거 시세 API ───────────────────────── */

app.get('/api/history/:code', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '').padStart(6, '0');
  if (code.length !== 6) return res.status(400).json({ error: '종목코드는 6자리 숫자입니다.' });

  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '')
    ? req.query.since
    : kstDate(new Date(Date.now() - 365 * 86400000));

  try {
    const series = await fetchNaverHistory(code, since);
    if (!series.length) {
      return res.status(502).json({ error: '가격 데이터를 가져오지 못했습니다. 종목코드나 기간을 확인하십시오.' });
    }
    res.json({ code, since, count: series.length, series });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ───────────────────────── 스크리너: 시가총액 유니버스 ─────────────────────────
 *
 * "네이버 금융 > 시가총액 순위"(코스피) 페이지를 페이지당 50종목씩 긁는다.
 * 이 페이지는 시가총액 내림차순이 기본 정렬이라, 등장 순서를 그대로 순위로 쓴다.
 * 종목명/코드는 표의 텍스트가 아니라 "/item/main.naver?code=XXXXXX" 링크에서 뽑는다 —
 * 컬럼 구성이 바뀌어도 이 링크 패턴은 잘 안 바뀐다.
 */

/**
 * 네트워크 실패는 대부분 일시적이다(네이버 일시 차단·점검·타임아웃).
 * 한 번 실패했다고 바로 포기하지 말고 점점 간격을 늘려가며 다시 시도한다.
 */
async function withRetry(fn, tries, baseDelayMs) {
  tries = tries || 3;
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, (baseDelayMs || 700) * Math.pow(2, i)));
    }
  }
  throw last;
}

/* ───────────── 시가총액 순위 수집 ─────────────
 *
 * 2026-09, 네이버가 시가총액 페이지를 Next.js로 다시 만들면서 HTML에
 * <a href="/item/main.naver?code=..."> 링크가 사라졌다. 앵커만 보던 파서가
 * 0개를 읽어서 스캔 전체가 죽었다.
 *
 * 같은 일이 또 나도 버티도록, 수집 경로를 셋 두고 되는 것을 쓴다.
 *   1) 모바일 JSON API   — 제일 깔끔. 응답 구조가 바뀌어도 재귀 탐색으로 흡수한다.
 *   2) 페이지 안 내장 JSON — Next.js는 데이터를 HTML 안에 문자열로 실어 보낸다.
 *                            마크업이 아니라 원문 텍스트에서 정규식으로 뽑으므로
 *                            화면 구조가 또 바뀌어도 대체로 살아남는다.
 *   3) 예전 앵커 마크업   — 구버전 페이지가 남아 있을 때를 위한 마지막 수단.
 *
 * 어느 경로가 먹혔는지는 /api/diag에서 확인할 수 있다.
 */

const CODE_KEY = /(^|_)(item)?code$/i;   // itemCode, code, reutersCode 등
const NAME_KEY = /name$/i;               // stockName, itemName, name 등

/**
 * 아무 모양의 JSON에서든 { 6자리 코드, 종목명 } 쌍을 찾아낸다.
 * 응답이 { result: { stocks: [...] } }든 { datas: [...] }든 상관없이 동작하게
 * 키 이름 패턴만 보고 재귀로 훑는다 — 네이버가 감싸는 껍데기를 바꿔도 버티게 하려는 것.
 */
function collectStocksFromJson(node, out, seen, depth) {
  if (node == null || (depth || 0) > 8) return out;
  if (Array.isArray(node)) {
    node.forEach(v => collectStocksFromJson(v, out, seen, (depth || 0) + 1));
    return out;
  }
  if (typeof node !== 'object') return out;

  let code = null, name = null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (!code && CODE_KEY.test(k) && /^\d{6}$/.test(v)) code = v;
      else if (!name && NAME_KEY.test(k) && v.trim() && !/^\d+$/.test(v)) name = v.trim();
    }
  }
  if (code && name && !seen.has(code)) { seen.add(code); out.push({ code, name }); }

  Object.values(node).forEach(v => {
    if (v && typeof v === 'object') collectStocksFromJson(v, out, seen, (depth || 0) + 1);
  });
  return out;
}

/**
 * HTML 원문에서 코드·종목명 쌍을 뽑는다.
 * Next.js가 데이터를 self.__next_f.push([1,"...\"itemCode\":\"005930\"..."]) 형태로
 * 실어 보내기 때문에 따옴표가 이스케이프돼 있다. \\? 를 곳곳에 넣어 두 경우를 다 받는다.
 * 순서는 등장 순서 = 시가총액 순위 순서를 그대로 따른다.
 */
function extractStocksFromText(text) {
  const out = [];
  const seen = new Set();
  const push = (code, name) => {
    if (!/^\d{6}$/.test(code)) return;
    const n = String(name).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
    if (!n || seen.has(code)) return;
    seen.add(code);
    out.push({ code, name: n });
  };

  // 코드가 먼저 나오는 경우
  const re1 = /(?:item)?[Cc]ode\\?"\s*:\s*\\?"(\d{6})\\?"[\s\S]{0,300}?(?:stockName|itemName|name)\\?"\s*:\s*\\?"((?:[^"\\]|\\.){1,40}?)\\?"/g;
  // 이름이 먼저 나오는 경우
  const re2 = /(?:stockName|itemName)\\?"\s*:\s*\\?"((?:[^"\\]|\\.){1,40}?)\\?"[\s\S]{0,300}?(?:item)?[Cc]ode\\?"\s*:\s*\\?"(\d{6})\\?"/g;

  let m;
  while ((m = re1.exec(text)) !== null) push(m[1], m[2]);
  if (!out.length) { while ((m = re2.exec(text)) !== null) push(m[2], m[1]); }
  return out;
}

/** 예전 마크업: /item/main.naver?code=XXXXXX 앵커 */
function extractStocksFromAnchors(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/item/main.naver?code="]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/code=(\d{6})/);
    if (!m) return;
    const code = m[1];
    const name = $(a).text().replace(/\s+/g, ' ').trim();
    if (!name || seen.has(code)) return;
    seen.add(code);
    out.push({ code, name });
  });
  return out;
}

const MARKET_NAME = ['KOSPI', 'KOSDAQ'];

/** 시가총액 순위 페이지/ API 후보 목록. 위에서부터 시도해 처음 성공한 것을 쓴다. */
function marketCapSources(page, sosok, perPage) {
  const mk = MARKET_NAME[sosok];
  return [
    {
      name: 'mobile-api',
      url: `https://m.stock.naver.com/api/stocks/marketValue/${mk}?page=${page}&pageSize=${perPage}`,
      parse: (text) => {
        let j;
        try { j = JSON.parse(text); } catch { return []; }
        return collectStocksFromJson(j, [], new Set(), 0);
      },
    },
    {
      name: 'embedded-json',
      url: `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`,
      parse: (text) => extractStocksFromText(text),
    },
    {
      name: 'legacy-anchors',
      url: `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`,
      parse: (text) => extractStocksFromAnchors(text),
    },
  ];
}

/** 마지막 스캔에서 어느 경로가 먹혔는지 — /api/diag에서 보여준다. */
let LAST_UNIVERSE_SOURCE = null;

async function fetchMarketCapPage(page, sosok, perPage) {
  sosok = sosok === 1 ? 1 : 0; // 0=코스피, 1=코스닥
  const sources = marketCapSources(page, sosok, perPage || 50);
  const tried = [];
  for (const src of sources) {
    try {
      const text = await withRetry(() => fetchHtml(src.url), 2, 600);
      const rows = src.parse(text);
      if (rows.length) {
        LAST_UNIVERSE_SOURCE = src.name;
        return rows;
      }
      tried.push(`${src.name}: 0건`);
    } catch (e) {
      tried.push(`${src.name}: ${e.message}`);
    }
  }
  throw new Error(tried.join(' | '));
}

/**
 * 마지막으로 성공한 시가총액 순위. 12시간 캐시와 달리 만료가 없다.
 *
 * 겪은 문제: 낮에는 잘 되다가 저녁에 "시가총액 순위를 가져오지 못했습니다"로 죽었다.
 * 시가총액 상위 100~150위 구성은 하루 사이에 거의 안 바뀌는데, 네이버가 잠깐
 * 막거나 점검에 들어가면 스캔 전체가 통째로 실패했다. 그럴 바엔 좀 지난 목록으로라도
 * 돌리는 게 낫다 — 대신 응답에 stale 표시를 남겨서 오래된 목록임을 알 수 있게 한다.
 */
const LAST_GOOD_UNIVERSE = new Map(); // key -> { list, at }

// 단일 시장(코스피 또는 코스닥) 안에서 시가총액 상위 n개를 모은다.
async function fetchMarketCapSingle(n, sosok) {
  const marketName = sosok === 1 ? 'kosdaq' : 'kospi';
  const cacheKey = 'universe:' + marketName + ':' + n;
  const cached = histCacheGet(cacheKey); // 하루 단위로 바뀌어도 무방 — 12시간 캐시 재사용
  if (cached) return cached;

  const perPage = 50;
  const pages = Math.ceil(n / perPage);
  // 실패 이유를 삼키지 않는다 — 어디서 왜 막혔는지 알아야 고칠 수 있다.
  const errors = [];
  // 유니버스를 크게 잡으면 페이지가 수십 장이 된다. 한꺼번에 던지면 차단을 부르므로
  // 5장씩 끊어서 받는다.
  const results = [];
  const PAGE_BATCH = 5;
  for (let start = 0; start < pages; start += PAGE_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(pages, start + PAGE_BATCH); i++) {
      batch.push(fetchMarketCapPage(i + 1, sosok, perPage)
        .catch(e => { errors.push(`p${i + 1}: ${e.message}`); return []; }));
    }
    results.push(...await Promise.all(batch));
    // 빈 페이지가 연속으로 나오면 그 시장의 끝에 도달한 것 — 더 받지 않는다.
    if (results.slice(-PAGE_BATCH).every(r => r.length === 0)) break;
  }
  const seen = new Set();
  const merged = [];
  for (const rows of results) {
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      merged.push({ ...r, market: marketName === 'kosdaq' ? 'KOSDAQ' : 'KOSPI' });
    }
  }
  const out = merged.slice(0, n);

  if (out.length) {
    histCacheSet(cacheKey, out);
    LAST_GOOD_UNIVERSE.set(cacheKey, { list: out, at: Date.now() });
    return out;
  }

  // 한 종목도 못 건졌다 → 마지막 성공 목록으로 대체한다.
  const fallback = LAST_GOOD_UNIVERSE.get(cacheKey);
  if (fallback) {
    const ageH = Math.round((Date.now() - fallback.at) / 3600000 * 10) / 10;
    console.error(`시가총액 순위 수집 실패(${marketName}) — ${ageH}시간 전 목록으로 대체. 원인: ${errors.join(' | ') || '알 수 없음'}`);
    const stale = fallback.list.slice();
    stale.staleHours = ageH;
    return stale;
  }
  const e = new Error(`시가총액 순위(${marketName}) 수집 실패 — ${errors.join(' | ') || '페이지는 받았으나 종목 링크를 하나도 찾지 못함(마크업 변경 가능성)'}`);
  e.universeFailure = true;
  throw e;
}

/**
 * market: 'KOSPI'(기본) | 'KOSDAQ' | 'ALL'.
 * 'ALL'은 진짜 통합 시가총액 순위가 아니다 — 코스피·코스닥 각 시장 안에서의
 * 순위를 절반씩 가져와 이어붙인 것이다(코스닥은 1위 기업도 코스피 중위권보다
 * 작은 경우가 많아서, 시가총액 숫자 자체를 비교해 하나로 재정렬하려면 그 값을
 * 따로 파싱해야 하는데 여기서는 하지 않는다). "코스닥도 후보에 들어오게"
 * 하는 목적에는 이 정도로 충분하다.
 */
async function fetchMarketCapUniverse(n, market) {
  market = market === 'KOSDAQ' ? 'KOSDAQ' : market === 'ALL' ? 'ALL' : 'KOSPI';
  if (market === 'ALL') {
    const half = Math.ceil(n / 2);
    // 한쪽 시장이 실패해도 다른 쪽만으로 스캔은 돌린다 — 둘 다 실패할 때만 던진다.
    const [k, d] = await Promise.allSettled([
      fetchMarketCapSingle(half, 0),
      fetchMarketCapSingle(half, 1),
    ]);
    const kospi = k.status === 'fulfilled' ? k.value : [];
    const kosdaq = d.status === 'fulfilled' ? d.value : [];
    if (!kospi.length && !kosdaq.length) {
      throw new Error('시가총액 순위 수집 실패 — 코스피: '
        + (k.reason ? k.reason.message : '빈 결과') + ' / 코스닥: '
        + (d.reason ? d.reason.message : '빈 결과'));
    }
    const out = [...kospi, ...kosdaq].slice(0, n);
    out.staleHours = kospi.staleHours || kosdaq.staleHours || undefined;
    return out;
  }
  return fetchMarketCapSingle(n, market === 'KOSDAQ' ? 1 : 0);
}

/* ───────────────────────── 스크리너: 수급(기관·외국인 순매매) ─────────────────────────
 *
 * "네이버 금융 > 종목 > 외국인·기관 매매동향"(frgn.naver) 페이지 하나에
 * 최근 거래일 20일치 날짜·종가·거래량·기관순매매·외국인순매매가 실려 있다.
 * 헤더 셀 텍스트로 "기관"/"외국인"/"거래량" 열의 위치를 찾아서 읽기 때문에,
 * 열 순서가 바뀌어도 헤더 문구만 같으면 버틴다.
 */

/**
 * 필드명 후보 여러 개 중 실제로 존재하는 키를 찾는다.
 * 실제 응답(2026-09)으로 확인된 필드명은 organPureBuyQuant(기관 순매수),
 * foreignerPureBuyQuant(외국인 순매수), tradeVolume(거래량), bizdate(날짜)다.
 * 정확한 키 대신 "organ+buy가 같이 들어감" 같은 느슨한 매칭을 쓰는 이유는,
 * 네이버가 필드명을 조금 바꿔도(예: Quant → Amt) 계속 버티게 하기 위해서다.
 * 매칭이 안 되면 /api/flow-raw로 실제 응답을 보고 검색 키워드를 조정한다.
 */
function pickField(row, mustIncludeAll) {
  const keys = Object.keys(row || {});
  const key = keys.find(k => {
    const lk = k.toLowerCase();
    return mustIncludeAll.every(s => lk.includes(s.toLowerCase()));
  });
  return key ? row[key] : undefined;
}
function pickDate(row) {
  const keys = Object.keys(row || {});
  const key = keys.find(k => /date/i.test(k));
  return key ? row[key] : undefined;
}

async function fetchInvestorFlow(code, days) {
  const N = days || 5;
  const cacheKey = 'flow:' + code + ':' + N;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://stock.naver.com/api/domestic/detail/${code}/trend?tradeType=KRX&startIdx=0&pageSize=20`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://stock.naver.com/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error('JSON 파싱 실패: ' + text.slice(0, 150)); }

  // 응답이 배열인지, {result:[...]}인지, {result:{rows:[...]}}인지 아직 실제로 못 봤다 — 셋 다 시도.
  const raw = Array.isArray(j) ? j
    : Array.isArray(j.result) ? j.result
    : (j.result && Array.isArray(j.result.rows)) ? j.result.rows
    : (Array.isArray(j.rows)) ? j.rows
    : [];

  const rows = raw.map(row => {
    const rawDate = String(pickDate(row) ?? '');
    const m = rawDate.match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
    const date = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    const volume = toNum(pickField(row, ['volume']));
    const foreignNet = toNum(pickField(row, ['foreign', 'buy']) ?? pickField(row, ['foreign', 'net']));
    const instNet = toNum(pickField(row, ['organ', 'buy']) ?? pickField(row, ['inst', 'net']));
    return { date, volume, instNet, foreignNet };
  }).filter(r => r.date);
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const recentForFlow = rows.slice(-N);
  const recentForVol = rows.slice(-20);
  const flowSum = recentForFlow.reduce((s, r) => s + (r.instNet || 0) + (r.foreignNet || 0), 0);
  const volSumRecent = recentForFlow.reduce((s, r) => s + (r.volume || 0), 0);
  const volAvg20 = recentForVol.length ? recentForVol.reduce((s, r) => s + (r.volume || 0), 0) / recentForVol.length : null;
  const lastVol = rows.length ? rows[rows.length - 1].volume : null;
  const volumeRatio = (volAvg20 && lastVol != null) ? lastVol / volAvg20 : null;
  const flowStrength = volSumRecent > 0 ? flowSum / volSumRecent : null;

  const out = {
    code, url, rows, flowSum, flowStrength, volumeRatio, volAvg20, lastVol,
    hasData: rows.length > 0 && rows.some(r => r.instNet != null || r.foreignNet != null),
  };
  cacheSet(cacheKey, out);
  return out;
}

/* ───────────────────────── 스크리너: 스캔 오케스트레이터 ───────────────────────── */

const SCREEN_BATCH = 8;

/**
 * 값 배열을 각 값의 백분위(0~1)로 바꾼다. 제일 작은 값이 0, 제일 큰 값이 1.
 * 저평가 정도·수급강도·거래량비율처럼 단위가 다른 지표를 하나의 점수로
 * 합치기 전에, 같은 유니버스 안에서의 "상대적 순위"로 맞추는 용도다.
 * 값이 1개 이하면 비교 대상이 없으므로 전부 1로 취급한다.
 */
function percentileRanks(values) {
  const n = values.length;
  if (n <= 1) return values.map(() => 1);
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(n);
  order.forEach((origIdx, sortedPos) => { ranks[origIdx] = sortedPos / (n - 1); });
  return ranks;
}

// ROE가 요구수익률을 이 정도(%p) 이내로만 넘으면 "경계선"으로 본다.
// 상승장(w=1)에서는 이런 종목일수록 요구수익률 가정을 조금만 바꿔도
// 적정주가가 크게 흔들린다 — 실제로 신용등급 기본값을 BBB-에서 AA로
// 바꾸자 결과가 통째로 달라진 종목들이 있어서 넣은 안전장치다.
const THIN_MARGIN_PCT = 3;

async function screenOne(item, opt) {
  try {
    const [fund, flow] = await Promise.all([
      getFundamentals(item.code),
      fetchInvestorFlow(item.code, opt.flowDays),
    ]);
    // "데이터 부족" 한마디로 뭉뚱그리면 무엇이 빠졌는지 알 수 없어 원인 추적이 안 된다.
    // 어느 항목이 비었는지 남겨서 화면에 집계로 보여준다.
    const missing = [];
    if (!fund.price) missing.push('현재가');
    if (!fund.equityEok) missing.push('자기자본');
    if (!fund.shares) missing.push('발행주식수');
    if (fund.roe.some(v => v == null)) missing.push('ROE 3년');
    if (missing.length) {
      return { code: item.code, name: item.name, skipped: '데이터 부족: ' + missing.join('·') };
    }
    const sharesOut = fund.shares - (fund.treasury || 0);
    const fv = fairValue(fund.equityEok, fund.roe[0], fund.roe[1], fund.roe[2], opt.kbasePct, opt.regime, sharesOut);
    if (fv.fairPrice == null || fv.roeW <= fv.k * 100) {
      return { code: item.code, name: item.name, skipped: 'ROE가 요구수익률 이하(초과이익 없음)' };
    }
    const gap = gapPct(fund.price, fv.fairPrice);
    const flowOk = flow.hasData && flow.flowStrength != null && flow.volumeRatio != null;
    const marginPct = Math.round((fv.roeW - fv.k * 100) * 100) / 100;

    return {
      code: item.code,
      name: fund.name || item.name,
      market: item.market || null,
      price: fund.price,
      fairPrice: Math.round(fv.fairPrice),
      gapPct: gap,
      flowStrength: flow.flowStrength,
      volumeRatio: flow.volumeRatio,
      flowSum: flow.flowSum,
      flowDataAvailable: flowOk,
      undervalued: gap != null && gap < 0,
      marginPct,
      thinMargin: marginPct < THIN_MARGIN_PCT,
    };
  } catch (e) {
    return { code: item.code, name: item.name, skipped: e.message };
  }
}

async function runScreen(opt) {
  const today = kstDate();
  const cacheKey = 'screen:' + JSON.stringify(opt) + ':' + today;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  const universe = await fetchMarketCapUniverse(opt.universeN, opt.market);
  if (!universe.length) {
    throw new Error('시가총액 순위를 가져오지 못했습니다. /api/diag로 어느 소스가 막혔는지 확인하십시오.');
  }
  const results = [];
  for (let i = 0; i < universe.length; i += SCREEN_BATCH) {
    const batch = universe.slice(i, i + SCREEN_BATCH);
    const r = await Promise.all(batch.map(item => screenOne(item, opt)));
    results.push(...r);
  }

  const scored = results.filter(r => !r.skipped);
  const skippedCount = results.length - scored.length;

  // 제외 사유를 집계한다. 전부 제외됐을 때 어디가 끊겼는지 바로 보이도록.
  const skipTally = {};
  results.filter(r => r.skipped).forEach(r => {
    const key = String(r.skipped).slice(0, 60);
    skipTally[key] = (skipTally[key] || 0) + 1;
  });
  const skipReasons = Object.entries(skipTally)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([reason, count]) => ({ reason, count }));

  // 어느 조건에서 다 떨어지는지 바로 보이게, 단계별로 몇 개가 남는지 센다.
  const funnel = {
    scored: scored.length,
    undervalued: scored.filter(r => r.undervalued).length,
    passedGap: scored.filter(r => r.undervalued && r.gapPct <= -opt.minGapPct).length,
    flowDataAvailable: scored.filter(r => r.flowDataAvailable).length,
    passedFlow: scored.filter(r => r.flowDataAvailable && r.flowStrength >= opt.minFlowStrength).length,
    passedVolume: scored.filter(r => r.flowDataAvailable && r.volumeRatio >= opt.minVolumeRatio).length,
  };

  // 저평가·수급강도·거래량비율 세 조건을 전부 동시에 넘겨야 하는 방식(AND 게이트)은
  // 각 조건을 통과하는 종목군이 우연히 안 겹치면 0개가 나온다 — 실제로 겪은 문제다.
  // 그래서 절대 기준(최소 저평가폭 등)은 "켜고 싶으면 켜는" 선택적 사전 필터로만 쓰고,
  // 그 필터를 통과한 종목들 안에서는 세 지표를 각각 백분위로 바꿔 가중합한 점수로
  // 순위를 매긴다 — 매일 "그나마 제일 나은 3개"가 나오게 하려는 목적이다.
  //
  // 코스피+코스닥을 한 유니버스로 합쳐서 매기면, 그날그날 우연히 한쪽 시장이
  // TOP3를 싹쓸이할 수 있다(코스닥 종목이 하나도 안 뽑히는 날이 있었다).
  // market이 'ALL'이면 이 함수를 시장별로 따로 호출해서 각자 TOP3를 뽑는다.
  const rankPool = (list) => {
    const filtered = list.filter(r =>
      r.undervalued &&
      r.gapPct <= -opt.minGapPct &&
      r.flowDataAvailable &&
      r.flowStrength >= opt.minFlowStrength &&
      r.volumeRatio >= opt.minVolumeRatio
    );
    const pGap = percentileRanks(filtered.map(r => -r.gapPct));      // 클수록 더 저평가
    const pFlow = percentileRanks(filtered.map(r => r.flowStrength));
    const pVol = percentileRanks(filtered.map(r => r.volumeRatio));
    filtered.forEach((r, i) => {
      r.score = opt.weightGap * pGap[i] + opt.weightFlow * pFlow[i] + opt.weightVolume * pVol[i];
      r.score = Math.round(r.score * 1000) / 1000;
    });
    filtered.sort((a, b) => b.score - a.score); // 점수 높은 순
    return filtered;
  };

  let out;
  if (opt.market === 'ALL') {
    const poolKospi = rankPool(scored.filter(r => r.market === 'KOSPI'));
    const poolKosdaq = rankPool(scored.filter(r => r.market === 'KOSDAQ'));
    const candidatesKospi = poolKospi.slice(0, 3);
    const candidatesKosdaq = poolKosdaq.slice(0, 3);
    out = {
      date: today,
      universeSize: universe.length,
      universeStaleHours: universe.staleHours ?? null,
      consideredCount: scored.length,
      skippedCount,
      skipReasons,
      passedCount: poolKospi.length + poolKosdaq.length,
      funnel,
      candidatesKospi,
      candidatesKosdaq,
      runnerUpsKospi: poolKospi.slice(3, 13),
      runnerUpsKosdaq: poolKosdaq.slice(3, 13),
      // 코스피/코스닥 구분 없이 보고 싶을 때를 위해 합친 것도 같이 준다.
      // 성과검증에 기록되는 것도 이 합쳐진 목록이라, 시장 통합으로 스캔하면
      // 코스피 TOP3 + 코스닥 TOP3가 함께(최대 6종목) 추천 기록에 남는다.
      candidates: [...candidatesKospi, ...candidatesKosdaq],
      runnerUps: [...poolKospi.slice(3, 13), ...poolKosdaq.slice(3, 13)],
      opt,
    };
  } else {
    const pool = rankPool(scored);
    out = {
      date: today,
      universeSize: universe.length,
      universeStaleHours: universe.staleHours ?? null,
      consideredCount: scored.length,
      skippedCount,
      skipReasons,
      passedCount: pool.length,
      funnel,
      candidates: pool.slice(0, 3),
      runnerUps: pool.slice(3, 13), // 참고용으로 좀 더 보여줌
      opt,
    };
  }

  // 성과검증은 부가 기능이다 — 여기서 실패해도(Upstash 설정 오류 등) 스캔 결과 자체는
  // 정상적으로 돌려줘야 한다. 실패는 조용히 넘어가되, 원인 파악용으로 콘솔에는 남긴다.
  try {
    await recordRecommendation(today, opt, out.candidates, 'value');
  } catch (e) {
    console.error('추천 기록 저장 실패(스캔 결과에는 영향 없음):', e.message);
  }
  histCacheSet(cacheKey, out);
  return out;
}

/* ═════════════════════ 모멘텀 스크리너 (사용자 정의 조건식) ═════════════════════
 *
 * 저평가·수급 스크리너는 재무 데이터로 순위를 매기기 때문에, 분기 실적이 바뀌기
 * 전까지는 며칠을 돌려도 거의 같은 종목이 나온다(실제로 이틀 연속 같은 6종목).
 * 이쪽은 일봉 지표의 "그날의 돌파"를 보므로
 * 후보가 매일 바뀐다. 두 탭은 성격이 반대라 같이 쓰는 편이 낫다.
 *
 * 데이터: 종목당 일봉 약 120거래일. 네이버 차트 API(요청 1건)를 먼저 쓰고,
 * 형식이 바뀌어 실패하면 기존 시세 HTML 페이지(요청 여러 건)로 자동 대체한다.
 *
 * 조건식 자체는 이 파일에 없다 — loadMomentumConfig()가 환경변수나 로컬 파일에서 읽어온다.
 */

const OHLCV_BATCH = 6;
const OHLCV_DAYS = 200;      // 달력일 기준 — 지표 워밍업에 필요한 거래일 확보용

/* ───────────── 조건 정의 불러오기 ─────────────
 *
 * 조건식은 이 저장소 안에 두지 않는다. 저장소가 공개되면 조건식도 같이 공개되기 때문이다.
 * 우선순위:
 *   1) 환경변수 MOMENTUM_CONDITIONS  (JSON 문자열) — Render 배포용
 *   2) conditions.local.json          (.gitignore에 등록됨) — 로컬 개발용
 *   3) 없으면 조건 없음 — 스캔은 돌아가지만 조건 판정 없이 섹터·거래량만으로 순위를 매긴다.
 *
 * 코드에는 기본 조건식을 넣지 않는다. 여기에 적어두면 숨기는 의미가 없다.
 */
let MOM_CONFIG_CACHE = null;

function normalizeConditions(raw) {
  if (!raw || !Array.isArray(raw.conditions)) return { label: null, conditions: [], source: raw.source };
  const seen = new Set();
  const conditions = raw.conditions
    .filter(c => c && c.key != null && (c.indicator || (Array.isArray(c.any) && c.any.length)))
    .map((c, idx) => ({
      key: String(c.key || String.fromCharCode(65 + idx)),
      indicator: String(c.indicator),
      params: c.params && typeof c.params === 'object' ? c.params : {},
      type: String(c.type || 'above'),
      level: Number.isFinite(Number(c.level)) ? Number(c.level) : null,  // rising/falling은 level이 없다
      bars: c.bars ? Number(c.bars) : undefined,
      offset: c.offset ? Number(c.offset) : undefined,   // "2봉전" 판정
      tol: c.tol != null ? Number(c.tol) : undefined,    // within 허용폭
      any: Array.isArray(c.any) ? c.any : undefined,     // (A or B or C) 묶음
      desc: c.desc ? String(c.desc) : null,
    }))
    .filter(c => c.indicator || (c.any && c.any.length))
    .filter(c => { if (seen.has(c.key)) return false; seen.add(c.key); return true; })
    .slice(0, 12);
  return { label: raw.label ? String(raw.label) : null, conditions, source: raw.source };
}

function loadMomentumConfig() {
  if (MOM_CONFIG_CACHE) return MOM_CONFIG_CACHE;
  let raw = null;
  const env = (process.env.MOMENTUM_CONDITIONS || '').trim();
  if (env) {
    try { raw = JSON.parse(env); raw.source = 'env'; }
    catch (e) { console.error('MOMENTUM_CONDITIONS 파싱 실패 — JSON 형식을 확인하십시오:', e.message); }
  }
  if (!raw) {
    try {
      const p = path.join(__dirname, 'conditions.local.json');
      if (fs.existsSync(p)) { raw = JSON.parse(fs.readFileSync(p, 'utf8')); raw.source = 'file'; }
    } catch (e) {
      console.error('conditions.local.json 읽기 실패:', e.message);
    }
  }
  MOM_CONFIG_CACHE = normalizeConditions(raw || { source: 'none' });
  return MOM_CONFIG_CACHE;
}

/** 'YYYYMMDD' → 'YYYY-MM-DD' */
function dashDate(s) {
  return String(s).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 네이버 차트 API. 응답이 정식 JSON이 아니라 작은따옴표가 섞인 JS 배열 리터럴이라
 * JSON.parse가 안 된다. 행 패턴을 정규식으로 훑어 뽑는다 — 컬럼이 하나 늘거나
 * 헤더 문구가 바뀌어도 앞의 6개 값(날짜·시가·고가·저가·종가·거래량)만 맞으면 버틴다.
 */
async function fetchOhlcvChartApi(code, days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1`
    + `&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — chart api`);
  const text = await res.text();

  const rows = [];
  const re = /\[\s*["']?(\d{8})["']?\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, d, o, h, l, c, v] = m;
    const bar = {
      date: dashDate(d),
      open: Number(o), high: Number(h), low: Number(l),
      close: Number(c), volume: Number(v),
    };
    if (bar.close > 0 && bar.high > 0 && bar.low > 0) rows.push(bar);
  }
  if (rows.length < 30) throw new Error('차트 API 응답에서 일봉을 충분히 읽지 못함 (' + rows.length + '개)');
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** 대체 경로: 기존 일별시세 HTML 표. 한 페이지에 10거래일이라 페이지를 여러 번 받는다. */
async function fetchOhlcvPageHtml(code, page) {
  const url = `https://finance.naver.com/item/sise_day.naver?code=${code}&page=${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const out = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 7) return;
    const dm = $(tds[0]).text().trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    if (!dm) return;
    // 열 순서: 날짜 | 종가 | 전일비 | 시가 | 고가 | 저가 | 거래량
    const close = toNum($(tds[1]).text());
    const open = toNum($(tds[3]).text());
    const high = toNum($(tds[4]).text());
    const low = toNum($(tds[5]).text());
    const volume = toNum($(tds[6]).text());
    if (close == null || high == null || low == null) return;
    out.push({ date: `${dm[1]}-${dm[2]}-${dm[3]}`, open: open ?? close, high, low, close, volume: volume ?? 0 });
  });
  return out;
}

async function fetchOhlcvHtml(code, needBars) {
  const pages = Math.ceil(needBars / 10) + 1;
  const results = [];
  for (let p = 1; p <= pages; p += 5) {
    const batch = [];
    for (let k = p; k < p + 5 && k <= pages; k++) batch.push(k);
    const r = await Promise.all(batch.map(n => fetchOhlcvPageHtml(code, n).catch(() => [])));
    r.forEach(rows => results.push(...rows));
  }
  const byDate = new Map();
  results.forEach(r => byDate.set(r.date, r));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchOhlcv(code, calendarDays) {
  const days = calendarDays || OHLCV_DAYS;
  const cacheKey = 'ohlcv:' + code + ':' + days;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  let bars, source = 'chart-api';
  try {
    bars = await fetchOhlcvChartApi(code, days);
  } catch (e) {
    // HTML 대체 경로는 한 페이지에 10거래일이라 길게 받으면 요청이 폭증한다.
    // 백테스트처럼 긴 기간이 필요할 때는 차트 API가 사실상 유일한 경로다.
    source = 'html-fallback';
    bars = await fetchOhlcvHtml(code, Math.min(260, Math.round(days * 0.7)));
  }
  const out = { bars, source };
  histCacheSet(cacheKey, out);
  return out;
}

/* ───────────── 업종(섹터) 매핑과 섹터 강도 ─────────────
 *
 * "강한 섹터"를 사람 판단이 아니라 데이터로 정하기 위해, 네이버 업종 분류를 받아
 * 유니버스 종목을 업종별로 묶은 뒤 구성종목의 최근 수익률 평균으로 순위를 매긴다.
 * 업종 목록 1건 + 업종별 상세 약 40건 = 하루 한 번만 받으면 되므로 12시간 캐시한다.
 */

/**
 * 업종 목록을 API에서 받는다.
 *
 * 네이버가 업종 페이지도 Next.js로 재구축해 HTML에서 링크가 사라졌다(2026-09).
 * 대신 이 API가 업종 번호·이름·구성종목수·당일 등락률까지 한 번에 준다.
 * 응답: { groups: [{ no, name, totalCount, changeRate, riseCount, fallCount }] }
 */
async function fetchSectorListApi() {
  // 파라미터를 붙이면 404가 났다. 탐색에서 200을 낸 형태 그대로 부른다.
  const urls = [
    'https://m.stock.naver.com/api/stocks/industry',
    'https://m.stock.naver.com/api/stocks/industry?page=1',
  ];
  let j = null, lastErr = null;
  for (const u of urls) {
    try { j = await fetchJson(u); break; }
    catch (e) { lastErr = e; }
  }
  if (!j) throw lastErr || new Error('업종 API 호출 실패');

  const groups = j?.groups || j?.result?.groups || j?.industries || [];
  if (!Array.isArray(groups) || !groups.length) throw new Error('업종 API에서 groups를 찾지 못했습니다');
  return groups
    .filter(g => g && g.no != null && g.name)
    .map(g => ({
      no: String(g.no),
      name: String(g.name).trim(),
      memberCount: toNum(g.totalCount) ?? null,
      changeRate: toNum(g.changeRate),
    }));
}

/** 업종별 구성종목을 API에서 받는다. */
async function fetchSectorMembersApi(no) {
  // 목록 API와 마찬가지로 파라미터 유무에 따라 404가 날 수 있어 순서대로 시도한다.
  const urls = [
    `https://m.stock.naver.com/api/stocks/industry/${no}`,
    `https://m.stock.naver.com/api/stocks/industry/${no}?page=1`,
    `https://m.stock.naver.com/api/stocks/industry/${no}?page=1&pageSize=200`,
  ];
  let j = null;
  for (const u of urls) {
    try { j = await fetchJson(u); break; } catch { /* 다음 형태로 */ }
  }
  if (!j) return [];
  const list = j?.stocks || j?.result?.stocks || j?.items || j?.stockList || [];
  const out = [];
  (Array.isArray(list) ? list : []).forEach(x => {
    const code = String(x.itemCode || x.code || x.reutersCode || '').match(/\d{6}/);
    if (code) out.push(code[0]);
  });
  return out;
}

async function fetchSectorList() {
  const url = 'https://finance.naver.com/sise/sise_group.naver?type=upjong';
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="sise_group_detail"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/no=(\d+)/);
    if (!m) return;
    const no = m[1];
    if (seen.has(no)) return;
    const name = $(a).text().replace(/\s+/g, ' ').trim();
    if (!name) return;
    seen.add(no);
    out.push({ no, name });
  });
  return out;
}

/**
 * 업종 분류를 종목별 API에서 거꾸로 모은다.
 *
 * 업종 목록 페이지가 재구축돼 0건이 나올 때를 위한 대체 경로다.
 * 종목마다 요청이 하나씩 더 붙지만, 어차피 유니버스는 캐시돼 있고
 * 업종 매핑도 12시간 캐시라 하루 한 번만 부담이 생긴다.
 */
async function fetchSectorMapFromStocks(codes) {
  const byCode = {};
  const counts = {};
  const BATCH = 6;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    await Promise.all(batch.map(async (code) => {
      try {
        const j = await fetchJson(`https://m.stock.naver.com/api/stock/${code}/integration`);
        // 업종명이 industryCodeType.industryName 등 어디에 있든 찾아낸다.
        const name = findStringByKey(j, /industryname|업종/i, 0);
        if (name && name.length <= 30) {
          byCode[code] = name;
          counts[name] = (counts[name] || 0) + 1;
        }
      } catch { /* 개별 실패는 무시 — 일부만 있어도 섹터 강도는 낸다 */ }
    }));
  }
  const sectors = Object.entries(counts).map(([name, memberCount]) => ({ no: name, name, memberCount }));
  return { byCode, sectors };
}

async function fetchSectorMembers(no) {
  const url = `https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=${no}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const codes = new Set();
  $('a[href*="/item/main.naver?code="]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/code=(\d{6})/);
    if (m) codes.add(m[1]);
  });
  return [...codes];
}

/** { byCode: {code: 업종명}, sectors: [{no, name, memberCount}] } */
async function fetchSectorMap() {
  const cached = histCacheGet('sectormap');
  if (cached) return cached;

  // 1순위: 업종 API. HTML 페이지가 재구축된 뒤로 이쪽이 유일하게 살아 있다.
  try {
    const groups = await fetchSectorListApi();
    const byCode = {};
    const sectors = [];
    for (let i = 0; i < groups.length; i += 6) {
      const batch = groups.slice(i, i + 6);
      const res = await Promise.all(batch.map(g => fetchSectorMembersApi(g.no).catch(() => [])));
      batch.forEach((g, k) => {
        res[k].forEach(c => { if (!byCode[c]) byCode[c] = g.name; });
        sectors.push({ no: g.no, name: g.name, memberCount: res[k].length || g.memberCount, changeRate: g.changeRate });
      });
    }
    if (Object.keys(byCode).length) {
      const out = { byCode, sectors, source: 'industry-api', fetchedAt: new Date().toISOString() };
      histCacheSet('sectormap', out);
      return out;
    }
    // 구성종목을 못 받아도 업종 목록만으로는 의미가 없다 — 다음 경로로 넘어간다.
  } catch (e) {
    console.error('업종 API 실패:', e.message);
  }

  const list = await fetchSectorList().catch(() => []);

  // 업종 목록 페이지도 죽었으면 종목별 API로 거꾸로 모은다.
  if (!list.length) {
    const universe = histCacheGet('universe:kospi:150') || histCacheGet('universe:kospi:100') || [];
    const universe2 = histCacheGet('universe:kosdaq:150') || histCacheGet('universe:kosdaq:100') || [];
    const codes = [...universe, ...universe2].map(x => x.code).slice(0, 300);
    if (codes.length) {
      const alt = await fetchSectorMapFromStocks(codes);
      const out2 = { ...alt, source: 'per-stock', fetchedAt: new Date().toISOString() };
      histCacheSet('sectormap', out2);
      return out2;
    }
    const empty = { byCode: {}, sectors: [], source: 'none', fetchedAt: new Date().toISOString() };
    histCacheSet('sectormap', empty);
    return empty;
  }

  const byCode = {};
  const sectors = [];
  for (let i = 0; i < list.length; i += 6) {
    const batch = list.slice(i, i + 6);
    const res = await Promise.all(batch.map(s => fetchSectorMembers(s.no).catch(() => [])));
    batch.forEach((s, k) => {
      const codes = res[k];
      codes.forEach(c => { if (!byCode[c]) byCode[c] = s.name; });
      sectors.push({ no: s.no, name: s.name, memberCount: codes.length });
    });
  }
  const out = { byCode, sectors, source: 'group-page', fetchedAt: new Date().toISOString() };
  histCacheSet('sectormap', out);
  return out;
}

/* ───────────── 스캔 본체 ───────────── */

async function evaluateOne(item, opt, config) {
  try {
    const { bars, source } = await fetchOhlcv(item.code);
    const ev = MC.evaluate(bars, config, { barsAgo: opt.barsAgo });
    if (!ev.ok) return { code: item.code, name: item.name, market: item.market, skipped: ev.reason };
    return { code: item.code, name: item.name, market: item.market || null, source, ...ev };
  } catch (e) {
    return { code: item.code, name: item.name, market: item.market, skipped: e.message };
  }
}

/** 유니버스 평가 결과를 업종별로 묶어 "섹터 강도"를 매긴다. */
function computeSectorStrength(rows, sectorByCode, minMembers) {
  const groups = new Map();
  rows.forEach(r => {
    const name = sectorByCode[r.code];
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  });
  const list = [];
  groups.forEach((members, name) => {
    const r5 = members.map(m => m.ret5).filter(v => v != null);
    const r20 = members.map(m => m.ret20).filter(v => v != null);
    const above = members.filter(m => m.ma20 != null && m.close > m.ma20).length;
    if (!r5.length) return;
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    list.push({
      name,
      memberCount: members.length,
      ret5: Math.round(mean(r5) * 100) / 100,
      ret20: r20.length ? Math.round(mean(r20) * 100) / 100 : null,
      aboveMa20Pct: Math.round((above / members.length) * 100),
      reliable: members.length >= (minMembers || 3),
    });
  });

  // 강도 점수 = 5일 수익률 백분위 70% + 20일 수익률 백분위 30%.
  // 단기 돌파를 찾는 스크리너라 최근 5일에 더 비중을 뒀다.
  const scored = list.filter(s => s.reliable);
  const p5 = MC.percentileRanks(scored.map(s => s.ret5));
  const p20 = MC.percentileRanks(scored.map(s => s.ret20 == null ? 0 : s.ret20));
  scored.forEach((s, i) => { s.strength = Math.round((0.7 * p5[i] + 0.3 * p20[i]) * 1000) / 1000; });
  scored.sort((a, b) => b.strength - a.strength);

  const strengthByName = {};
  scored.forEach(s => { strengthByName[s.name] = s.strength; });
  // 구성종목이 적어 순위에서 뺀 업종은 중립(0.5)으로 둔다.
  list.filter(s => !s.reliable).forEach(s => { s.strength = 0.5; strengthByName[s.name] = 0.5; });

  return { sectors: scored, allSectors: list, strengthByName };
}

/**
 * 최종 후보에만 적정주가를 붙인다.
 *
 * 재무 조회는 종목당 요청이 여러 건이라 유니버스 전체(수백~수천)에 돌리면
 * 스캔이 몇 배로 느려진다. 순위가 정해진 뒤 상위 몇 종목에만 얹어서,
 * 모멘텀 신호와 밸류에이션을 한 화면에서 같이 보게 하는 정도로 쓴다.
 */
async function attachFairValue(list, opt) {
  if (!list.length) return list;
  const BATCH = 3;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    await Promise.all(batch.map(async (c) => {
      try {
        const fund = await getFundamentals(c.code);
        if (!fund.equityEok || !fund.shares || fund.roe.some(v => v == null)) {
          c.fairNote = '재무 데이터 부족';
          return;
        }
        const sharesOut = fund.shares - (fund.treasury || 0);
        const fv = fairValue(fund.equityEok, fund.roe[0], fund.roe[1], fund.roe[2],
                             opt.kbasePct, opt.regime, sharesOut);
        if (fv.fairPrice == null) { c.fairNote = '적정주가 계산 불가'; return; }
        c.fairPrice = Math.round(fv.fairPrice);
        c.roeW = Math.round(fv.roeW * 100) / 100;
        c.marginPct = Math.round((fv.roeW - fv.k * 100) * 100) / 100;
        // 계산 근거를 같이 내보낸다. 적정주가가 터무니없이 나올 때 어디서 비롯됐는지
        // 숫자를 보고 판단할 수 있어야 한다.
        c.fairInputs = {
          roe: fund.roe, equityEok: round2(fund.equityEok), bps: round2(fund.bps),
          shares: fund.shares, equityNote: fund.equityNote,
        };
        // 괴리율은 화면에 띄운 종가 기준으로 계산해야 카드 안에서 앞뒤가 맞는다.
        c.gapPct = round2(gapPct(c.close, fv.fairPrice));

        /* 경고 순서는 "더 위험한 것부터". S-RIM은 ROE가 영원히 유지된다고 가정하므로
         * ROE가 높을수록 값이 기하급수로 커진다. 조선·반도체처럼 실적이 크게 출렁이는
         * 업종에서는 이 가정이 무너져서 적정주가가 몇 배로 부풀려진다. */
        if (fv.roeW <= fv.k * 100) c.fairNote = 'ROE가 요구수익률 이하 (초과이익 없음)';
        else if (fv.roeW >= 20) c.fairNote = 'ROE ' + c.roeW + '%가 계속 유지된다는 가정 — 경기민감주면 과대평가';
        else if (c.gapPct != null && c.gapPct <= -50) c.fairNote = '괴리율이 과도합니다 — 계산 근거를 확인하십시오';
        else if (fund.equityNote && /BPS/.test(fund.equityNote)) c.fairNote = '자기자본이 BPS 기반 추정값';
      } catch (e) {
        c.fairNote = '재무 조회 실패';
      }
    }));
  }
  return list;
}

async function runMomentum(opt) {
  const today = kstDate();
  const config = loadMomentumConfig();
  const cacheKey = 'mom:' + JSON.stringify(opt) + ':' + today;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  const universe = await fetchMarketCapUniverse(opt.universeN, opt.market);
  if (!universe.length) throw new Error('시가총액 순위를 가져오지 못했습니다. /api/diag로 어느 소스가 막혔는지 확인하십시오.');

  // 업종 매핑은 실패해도 스캔 자체는 계속한다(섹터 가중치만 중립이 된다).
  let sectorMap = { byCode: {}, sectors: [] };
  let sectorError = null;
  if (opt.weightSector > 0 || opt.keywords.length) {
    try { sectorMap = await fetchSectorMap(); }
    catch (e) { sectorError = e.message; }
  }

  const results = [];
  for (let i = 0; i < universe.length; i += OHLCV_BATCH) {
    const batch = universe.slice(i, i + OHLCV_BATCH);
    results.push(...await Promise.all(batch.map(it => evaluateOne(it, opt, config))));
  }

  const rows = results.filter(r => !r.skipped);
  const skippedCount = results.length - rows.length;
  rows.forEach(r => { r.sector = sectorMap.byCode[r.code] || null; });

  const sectorInfo = computeSectorStrength(rows, sectorMap.byCode, 3);

  // ── 시장 국면 (유니버스 전체의 상태로 읽는다 — 지수를 따로 받지 않아도 된다)
  const withMa = rows.filter(r => r.ma20 != null);
  const aboveMa20Pct = withMa.length ? Math.round((withMa.filter(r => r.close > r.ma20).length / withMa.length) * 100) : null;
  const withMa60 = rows.filter(r => r.ma60 != null);
  const aboveMa60Pct = withMa60.length ? Math.round((withMa60.filter(r => r.close > r.ma60).length / withMa60.length) * 100) : null;
  const r5s = rows.map(r => r.ret5).filter(v => v != null);
  const avgRet5 = r5s.length ? Math.round((r5s.reduce((s, v) => s + v, 0) / r5s.length) * 100) / 100 : null;
  const regime = aboveMa20Pct == null ? 'unknown'
    : aboveMa20Pct >= 65 ? 'strong'
    : aboveMa20Pct >= 45 ? 'neutral' : 'weak';

  // 조건별 통과 수는 조건 정의에서 키를 읽어 만든다 — 코드에 조건이 박혀 있지 않다.
  const condCount = config.conditions.length;
  const byCondition = {};
  config.conditions.forEach(c => { byCondition[c.key] = rows.filter(r => r.conds && r.conds[c.key]).length; });
  const funnel = {
    evaluated: rows.length,
    byCondition,
    strict: rows.filter(r => r.strict).length,
    nearMiss: condCount > 1 ? rows.filter(r => r.passCount === condCount - 1).length : 0,
    liquidityPassed: rows.filter(r => r.avgTurnoverEok == null || r.avgTurnoverEok >= opt.minTurnoverEok).length,
  };

  // ── 점수: 조건충족수 · 섹터강도 · 거래량비율 백분위의 가중합 + 테마 키워드 가점
  const kw = opt.keywords.map(k => k.trim()).filter(Boolean);
  const matchKeyword = (r) => kw.some(k => (r.name || '').includes(k) || (r.sector || '').includes(k));

  const rankPool = (list) => {
    // minPassCount는 "조건 몇 개 이상"인데, 조건 개수보다 크게 잡히면 아무것도 안 남는다.
    const minPass = Math.min(opt.minPassCount, condCount);
    const filtered = list.filter(r =>
      (r.avgTurnoverEok == null || r.avgTurnoverEok >= opt.minTurnoverEok) &&
      r.passCount >= minPass
    );
    const pVol = MC.percentileRanks(filtered.map(r => r.volumeRatio == null ? 0 : r.volumeRatio));
    filtered.forEach((r, i) => {
      r.sectorStrength = r.sector ? (sectorInfo.strengthByName[r.sector] ?? 0.5) : 0.5;
      r.volumePct = Math.round(pVol[i] * 1000) / 1000;
      r.keywordHit = matchKeyword(r);
      r.score = Math.round((
        opt.weightCond * (condCount ? r.passCount / condCount : 0) +
        opt.weightSector * r.sectorStrength +
        opt.weightVolume * pVol[i] +
        (r.keywordHit ? opt.weightKeyword : 0)
      ) * 1000) / 1000;
    });
    // 조건식을 전부 만족한 종목(strict)을 무조건 앞에 세우고, 그 안에서 점수순.
    filtered.sort((a, b) => (Number(b.strict) - Number(a.strict)) || (b.score - a.score));
    return filtered;
  };

  // 지표 이름을 응답에 박아두지 않는다 — 조건 키(A, B…)와 그 값만 넘기고,
  // 무슨 지표인지는 조건 정의를 읽을 수 있는 사람(=소유자)만 알 수 있다.
  const slim = (r) => ({
    code: r.code, name: r.name, market: r.market, sector: r.sector,
    date: r.date, close: r.close,
    conds: r.conds, values: r.values, passCount: r.passCount, condCount: r.condCount, strict: r.strict,
    volumeRatio: round2(r.volumeRatio), avgTurnoverEok: round2(r.avgTurnoverEok),
    ret1: round2(r.ret1), ret5: round2(r.ret5), ret20: round2(r.ret20),
    aboveMa20: r.ma20 == null ? null : r.close > r.ma20,
    sectorStrength: r.sectorStrength, keywordHit: r.keywordHit, score: r.score,
    price: r.close, // 성과검증이 price 필드를 쓴다
  });

  const poolKospi = rankPool(rows.filter(r => r.market === 'KOSPI')).map(slim);
  const poolKosdaq = rankPool(rows.filter(r => r.market === 'KOSDAQ')).map(slim);
  const N = opt.topN;

  const topKospi = poolKospi.slice(0, N);
  const topKosdaq = poolKosdaq.slice(0, N);
  if (opt.withFairValue) {
    await attachFairValue([...topKospi, ...topKosdaq], opt);
  }

  const out = {
    date: today,
    barsAgo: opt.barsAgo,
    asOfBarDate: rows.length ? rows[0].date : null,
    universeSize: universe.length,
    universeStaleHours: universe.staleHours ?? null,
    consideredCount: rows.length,
    skippedCount,
    conditionsConfigured: condCount > 0,
    conditionSource: config.source || 'none',
    funnel,
    market: {
      regime, aboveMa20Pct, aboveMa60Pct, avgRet5,
      strictCount: funnel.strict,
      condCount,
    },
    sectorTop: sectorInfo.sectors.slice(0, 8),
    sectorBottom: sectorInfo.sectors.slice(-5).reverse(),
    sectorError,
    candidatesKospi: topKospi,
    candidatesKosdaq: topKosdaq,
    runnerUpsKospi: poolKospi.slice(N, N + 10),
    runnerUpsKosdaq: poolKosdaq.slice(N, N + 10),
    candidates: [...topKospi, ...topKosdaq],
    opt,
  };

  try {
    await recordRecommendation(today, opt, out.candidates, 'momentum');
  } catch (e) {
    console.error('모멘텀 추천 기록 저장 실패(스캔 결과에는 영향 없음):', e.message);
  }
  histCacheSet(cacheKey, out);
  return out;
}

function round2(v) {
  return (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;
}

/* ═════════════════════ 미국장 모멘텀 스크리너 ═════════════════════
 *
 * 한국장 탭과 조건식·지표는 같고 데이터 출처만 다르다.
 * 미국은 기관·외국인 일별 순매수 공개 자료가 없어 수급 축을 만들 수 없다.
 * 그래서 축이 셋이다 — 조건 충족 · 섹터 강도 · 거래량 급증. 여기에 적정주가를 얹는다.
 *
 * 유니버스는 두 방식 중에 고른다.
 *   시가총액 상위 — 안정적이지만 움직이는 중소형주를 놓친다.
 *   거래대금 상위 — 잘 움직이는 종목이 들어오지만 작전주 위험이 있다.
 *
 * 작전주 대책은 유니버스 단계에서 건다: 주가 하한, 시가총액 하한, 비주식 종목 제외,
 * 그리고 결정적으로 "20일 평균" 거래대금으로 거른다. 나스닥 스크리너가 주는 거래량은
 * 당일 값이라 하루 띄운 종목이 상위에 오는데, 20일 평균을 내면 그런 종목은 밀려난다.
 * 그 평균은 어차피 받아오는 일봉에서 직접 계산한다.
 */

const US_BATCH = 3;          // 야후 한도(체감 초당 2건)를 넘지 않도록
const US_BATCH_PAUSE_MS = 350;

async function fetchUsUniverse(opt) {
  const cacheKey = 'us-universe:' + opt.mode + ':' + opt.minPrice + ':' + opt.minMarketCapM;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  const rows = await US.fetchUsScreenerRows();
  const built = US.buildUsUniverse(rows, opt);
  histCacheSet(cacheKey, built);
  return built;
}

async function evaluateUsOne(item, opt, config) {
  try {
    const cacheKey = 'us-ohlcv:' + item.code;
    let got = histCacheGet(cacheKey);
    if (!got) {
      got = await US.fetchUsBars(item.code);
      histCacheSet(cacheKey, got);
    }
    const ev = MC.evaluate(got.bars, config, { barsAgo: opt.barsAgo });
    if (!ev.ok) return { ...item, skipped: ev.reason };
    return { ...item, source: got.source, ...ev };
  } catch (e) {
    return { ...item, skipped: e.message };
  }
}

/**
 * 미국 후보에 적정주가를 얹는다.
 *
 * 한국장과 계산식은 같지만 ROE가 최근 12개월 한 개뿐이라 3년 가중평균 대신
 * 같은 값을 세 번 넣는다(= 최근 ROE가 유지된다는 가정). 그래서 신뢰도가 낮고,
 * 카드에 그 사실을 함께 표시한다.
 */
async function attachUsFairValue(list, opt) {
  for (const c of list) {
    try {
      const f = await US.fetchUsFundamentals(c.code);
      if (f.equityUsd == null || f.roePct == null || !f.shares) {
        c.fairNote = '재무 데이터 부족';
        continue;
      }
      // fairValue는 자기자본을 1e8 단위로 받는다(한국은 억원). USD도 같은 배율로 맞추면
      // 주당 값은 달러로 그대로 나온다.
      const fv = fairValue(f.equityUsd / 1e8, f.roePct, f.roePct, f.roePct,
                           opt.kbasePct, opt.regime, f.shares);
      if (fv.fairPrice == null) { c.fairNote = '적정주가 계산 불가'; continue; }
      c.fairPrice = Math.round(fv.fairPrice * 100) / 100;
      c.roeW = Math.round(fv.roeW * 100) / 100;
      c.gapPct = round2(gapPct(c.close, fv.fairPrice));
      c.fairNote = fv.roeW <= fv.k * 100
        ? 'ROE가 요구수익률 이하 (초과이익 없음)'
        : 'ROE는 최근 12개월 값 하나 (3년 평균 아님)';
    } catch (e) {
      c.fairNote = '재무 조회 실패';
    }
    await US.sleep(200);   // quoteSummary도 같은 한도를 공유한다
  }
  return list;
}

async function runUsMomentum(opt) {
  const today = kstDate();
  const config = loadMomentumConfig();
  const cacheKey = 'us-mom:' + JSON.stringify(opt) + ':' + today;
  const cached = histCacheGet(cacheKey);
  if (cached) return cached;

  const universe = await fetchUsUniverse(opt);
  if (!universe.list.length) throw new Error('미국 유니버스가 비었습니다. /api/us-universe-raw로 확인하십시오.');

  // 후보군은 목표보다 넉넉히 잡는다. 아래에서 20일 평균 거래대금으로 다시 거를 것이라,
  // 여기서 딱 맞게 자르면 필터를 통과한 종목이 모자라게 된다.
  const poolSize = Math.min(universe.list.length, Math.round(opt.universeN * opt.poolMultiplier));
  const pool = universe.list.slice(0, poolSize);

  const results = [];
  for (let i = 0; i < pool.length; i += US_BATCH) {
    const batch = pool.slice(i, i + US_BATCH);
    results.push(...await Promise.all(batch.map(it => evaluateUsOne(it, opt, config))));
    if (i + US_BATCH < pool.length) await US.sleep(US_BATCH_PAUSE_MS);
  }

  const rows = results.filter(r => !r.skipped);
  const skippedCount = results.length - rows.length;

  // ── 진짜 유동성 필터: 당일이 아니라 20일 평균 거래대금
  const minTurnoverUsd = opt.minTurnoverM * 1e6;
  const liquid = rows.filter(r => (r.avgTurnoverEok == null) || (r.avgTurnoverEok * 1e8 >= minTurnoverUsd));

  // ── 신규 상장 제외 (지표 워밍업만으로는 SPAC 합병 직후를 못 거른다)
  const seasoned = liquid.filter(r => !opt.minListedYears
    || !r.ipoYear || (new Date().getFullYear() - r.ipoYear) >= opt.minListedYears);

  const condCount = config.conditions.length;
  const byCondition = {};
  config.conditions.forEach(c => { byCondition[c.key] = rows.filter(r => r.conds && r.conds[c.key]).length; });
  const funnel = {
    universeAfterPrefilter: universe.list.length,
    fetched: pool.length,
    evaluated: rows.length,
    byCondition,
    strict: rows.filter(r => r.strict).length,
    nearMiss: condCount > 1 ? rows.filter(r => r.passCount === condCount - 1).length : 0,
    liquidityPassed: liquid.length,
    seasonedPassed: seasoned.length,
    prefilterRejected: universe.rejected,
  };

  // ── 섹터 강도 (나스닥 스크리너가 준 GICS 섹터를 그대로 쓴다)
  const sectorByCode = {};
  rows.forEach(r => { if (r.sector) sectorByCode[r.code] = r.sector; });
  const sectorInfo = computeSectorStrength(rows, sectorByCode, 3);

  const withMa = rows.filter(r => r.ma20 != null);
  const aboveMa20Pct = withMa.length ? Math.round((withMa.filter(r => r.close > r.ma20).length / withMa.length) * 100) : null;
  const withMa60 = rows.filter(r => r.ma60 != null);
  const aboveMa60Pct = withMa60.length ? Math.round((withMa60.filter(r => r.close > r.ma60).length / withMa60.length) * 100) : null;
  const r5s = rows.map(r => r.ret5).filter(v => v != null);
  const avgRet5 = r5s.length ? Math.round((r5s.reduce((s, v) => s + v, 0) / r5s.length) * 100) / 100 : null;
  const regimeRead = aboveMa20Pct == null ? 'unknown'
    : aboveMa20Pct >= 65 ? 'strong' : aboveMa20Pct >= 45 ? 'neutral' : 'weak';

  const kw = opt.keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
  const matchKeyword = (r) => kw.some(k =>
    (r.name || '').toLowerCase().includes(k)
    || (r.sector || '').toLowerCase().includes(k)
    || (r.industry || '').toLowerCase().includes(k));

  const eligible = seasoned.filter(r => r.passCount >= Math.min(opt.minPassCount, condCount));
  const pVol = MC.percentileRanks(eligible.map(r => r.volumeRatio == null ? 0 : r.volumeRatio));
  eligible.forEach((r, i) => {
    r.sectorStrength = r.sector ? (sectorInfo.strengthByName[r.sector] ?? 0.5) : 0.5;
    r.volumePct = Math.round(pVol[i] * 1000) / 1000;
    r.keywordHit = matchKeyword(r);
    r.score = Math.round((
      opt.weightCond * (condCount ? r.passCount / condCount : 0) +
      opt.weightSector * r.sectorStrength +
      opt.weightVolume * pVol[i] +
      (r.keywordHit ? opt.weightKeyword : 0)
    ) * 1000) / 1000;
  });
  eligible.sort((a, b) => (Number(b.strict) - Number(a.strict)) || (b.score - a.score));

  const slim = (r) => ({
    code: r.code, name: r.name, market: 'US', sector: r.sector, industry: r.industry,
    date: r.date, close: r.close,
    conds: r.conds, values: r.values, passCount: r.passCount, condCount: r.condCount, strict: r.strict,
    volumeRatio: round2(r.volumeRatio),
    avgTurnoverM: r.avgTurnoverEok == null ? null : Math.round(r.avgTurnoverEok * 1e8 / 1e6),
    marketCapM: Math.round(r.marketCapUsd / 1e6),
    ret1: round2(r.ret1), ret5: round2(r.ret5), ret20: round2(r.ret20),
    aboveMa20: r.ma20 == null ? null : r.close > r.ma20,
    sectorStrength: r.sectorStrength, keywordHit: r.keywordHit, score: r.score,
    ipoYear: r.ipoYear || null,
    price: r.close,
  });

  const ranked = eligible.map(slim);
  const top = ranked.slice(0, opt.topN);
  if (opt.withFairValue) await attachUsFairValue(top, opt);

  const out = {
    date: today,
    market: 'US',
    universeMode: opt.mode,
    barsAgo: opt.barsAgo,
    asOfBarDate: rows.length ? rows[0].date : null,
    universeSize: universe.list.length,
    fetchedCount: pool.length,
    consideredCount: rows.length,
    skippedCount,
    conditionsConfigured: condCount > 0,
    funnel,
    marketRead: { regime: regimeRead, aboveMa20Pct, aboveMa60Pct, avgRet5, strictCount: funnel.strict, condCount },
    sectorTop: sectorInfo.sectors.slice(0, 8),
    sectorBottom: sectorInfo.sectors.slice(-5).reverse(),
    candidates: top,
    runnerUps: ranked.slice(opt.topN, opt.topN + 12),
    opt,
  };

  histCacheSet(cacheKey, out);
  return out;
}

/* ═════════════════════ 백테스트 ═════════════════════
 *
 * 조건식을 과거 봉에 되돌려 신호를 모두 찾고, 그 뒤 며칠이 어땠는지 센다.
 * 목적은 "좋은 조건식을 찾아내는 것"이 아니라 "조건을 바꿨을 때 나아졌는지
 * 알 수 있게 하는 것"이다. 승률만 보고 고르면 과거에만 맞는 조합을 고르게 되므로
 * 벤치마크·표본 수·검증 구간을 함께 낸다.
 */

/**
 * 추가 필터. 환경변수에 넣어둔 조건식은 그대로 두고, 여기서 하나씩 켜고 끄며
 * 무엇이 성적을 올리는지 비교한다. 앞서 이야기한 "추세 전환·거래대금·지지선"을
 * 조건 정의로 옮긴 것이다.
 */
const BACKTEST_FILTERS = {
  volumeSurge: {
    label: '거래량 급증 (20일 평균의 2.5배 이상)',
    conds: [{ key: 'V', indicator: 'volumeRatio', params: { n: 20 }, type: 'above', level: 2.5 }],
  },
  aboveMa20: {
    label: '종가가 20일선 위 (지지 확보)',
    conds: [{ key: 'M', indicator: 'closeVsMa', params: { n: 20 }, type: 'above', level: 100 }],
  },
  ma20Rising: {
    label: '20일선 상승 전환',
    conds: [{ key: 'R', indicator: 'ma', params: { n: 20 }, type: 'rising', bars: 1 }],
  },
  breakout5: {
    label: '최근 5일 고가 돌파',
    conds: [{ key: 'H', indicator: 'closeVsHigh', params: { n: 5 }, type: 'above', level: 100 }],
  },
  priorDrop: {
    label: '선행 하락 (60일 고점 대비 -15% 이하)',
    conds: [{ key: 'D', indicator: 'drawdown', params: { n: 60 }, type: 'below', level: -15 }],
  },
  notOverheated: {
    label: '당일 과열 배제 (상승률 10% 이하)',
    conds: [{ key: 'O', indicator: 'dayChange', params: {}, type: 'below', level: 10 }],
  },
  calmEnough: {
    label: '변동성 과다 배제 (ATR 10% 이하)',
    conds: [{ key: 'A', indicator: 'atrPct', params: { n: 14 }, type: 'below', level: 10 }],
  },

  /* ── 일목균형표 눌림 계열
   * 널리 참고되는 조건검색식을 그대로 옮긴 것이다. 논리는 "구름 위 상승추세에서
   * 기준선까지 눌린 자리를 잡는다"이고, 이는 실제 매매 방식(30분봉 기준선 대기)과
   * 같은 발상을 일봉으로 옮긴 것이다. 원식의 항목별로 켜고 끌 수 있게 나눠 뒀다.
   */
  ichiAboveTenkan2: {
    label: '[일목] 2봉전 종가가 전환선 위',
    conds: [{ key: 'T', indicator: 'closeVsTenkan', params: {}, type: 'above', level: 100, offset: 2 }],
  },
  ichiNearKijun: {
    label: '[일목] 종가·저가·시가 중 하나가 기준선 1% 이내 (눌림)',
    conds: [{
      key: 'K',
      any: [
        { indicator: 'closeVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
        { indicator: 'lowVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
        { indicator: 'openVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
      ],
    }],
  },
  ichiAboveCloud: {
    label: '[일목] 종가가 선행스팬1·2 위 (구름 위)',
    conds: [
      { key: 'S1', indicator: 'closeVsSpanA', params: {}, type: 'above', level: 100 },
      { key: 'S2', indicator: 'closeVsSpanB', params: {}, type: 'above', level: 100 },
    ],
  },
  bullCandle: {
    label: '당일 양봉 (시가 < 종가)',
    conds: [{ key: 'G', indicator: 'candleBody', params: {}, type: 'above', level: 100 }],
  },
  ma120Up: {
    label: '120일선 2봉 연속 상승',
    conds: [{ key: 'L', indicator: 'ma', params: { n: 120 }, type: 'rising', bars: 2 }],
  },
  ma240Up: {
    label: '240일선 2봉 연속 상승',
    conds: [{ key: 'P', indicator: 'ma', params: { n: 240 }, type: 'rising', bars: 2 }],
  },
  newHigh120: {
    label: '20봉 이내에 120봉 신고가 발생',
    conds: [{ key: 'Q', indicator: 'newHighAge', params: { n: 120 }, type: 'below', level: 20 }],
  },
  turnoverSpike: {
    label: '20봉 이내 거래대금 500억 이상 1회 (미국은 백만$ 기준이라 값 조정 필요)',
    conds: [{ key: 'N', indicator: 'maxTurnoverM', params: { n: 20 }, type: 'above', level: 50000 }],
  },
  volumeSurge500: {
    label: '20봉 이내 전봉 거래량 대비 500% 이상 1회',
    conds: [{ key: 'W', indicator: 'maxVolumeSurge', params: { n: 20 }, type: 'above', level: 500 }],
  },
};

/** 기본 조건식 + 켜둔 추가 필터를 합쳐 하나의 조건 정의로 만든다. */
function buildBacktestConfig(filterNames, useBaseConditions) {
  const base = useBaseConditions ? loadMomentumConfig().conditions : [];
  // 필터 하나가 조건 여러 개를 담을 수 있다(구름 위 = 선행스팬1·2 둘 다처럼).
  const extra = [];
  (filterNames || []).forEach(n => {
    const f = BACKTEST_FILTERS[n];
    if (f) extra.push(...(f.conds || []));
  });
  const seen = new Set();
  const conditions = [...base, ...extra].filter(c => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
  return { label: '백테스트', conditions };
}

async function runBacktest(opt) {
  const config = buildBacktestConfig(opt.filters, opt.useBaseConditions);
  if (!config.conditions.length) {
    throw new Error('조건이 하나도 없습니다. 기본 조건식을 켜거나 추가 필터를 고르십시오.');
  }

  // 유니버스 — 스캔과 같은 경로를 쓴다. 백테스트는 오래 걸리므로 기본을 작게 잡는다.
  let universe;
  if (opt.market === 'US') {
    const built = await fetchUsUniverse({
      mode: opt.usMode, minPrice: opt.usMinPrice, minMarketCapM: opt.usMinMarketCapM,
    });
    universe = built.list.slice(0, opt.universeN);
  } else {
    universe = await fetchMarketCapUniverse(opt.universeN, opt.market);
  }
  if (!universe.length) throw new Error('유니버스가 비었습니다.');

  const perStock = [];
  const failures = [];
  const BATCH = opt.market === 'US' ? 3 : 6;

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const got = await Promise.all(batch.map(async (item) => {
      try {
        const res = opt.market === 'US'
          ? await (async () => {
              const key = 'us-ohlcv-long:' + item.code + ':' + opt.yahooRange;
              let g = histCacheGet(key);
              if (!g) {
                // 야후가 막히면 네이버·Stooq로 넘어가도록 공통 경로를 쓴다.
                // 예전에는 여기서 야후만 직접 불러서, 스크리너는 되는데 백테스트만 죽었다.
                g = await US.fetchUsBars(item.code, opt.yahooRange);
                histCacheSet(key, g);
              }
              return g;
            })()
          : await fetchOhlcv(item.code, opt.krCalendarDays);
        const bars = res.bars;
        if (bars.length < opt.warmupBars + opt.holdDays + 20) {
          return { code: item.code, name: item.name, error: '일봉 ' + bars.length + '개로는 부족' };
        }
        const trades = BT.simulateOne(bars, config, opt);
        return {
          code: item.code, name: item.name, trades,
          benchmark: BT.benchmarkReturns(bars, opt),
          barCount: bars.length, firstDate: bars[0].date, lastDate: bars[bars.length - 1].date,
        };
      } catch (e) {
        return { code: item.code, name: item.name, error: e.message };
      }
    }));
    got.forEach(g => { if (g.error) failures.push(g); else perStock.push(g); });
    if (opt.market === 'US' && i + BATCH < universe.length) await US.sleep(350);
  }

  if (!perStock.length) {
    throw new Error('일봉을 하나도 받지 못했습니다. ' + (failures[0]?.error || ''));
  }

  const agg = BT.aggregate(perStock, opt);
  const dates = perStock.map(s => s.firstDate).filter(Boolean).sort();

  return {
    market: opt.market,
    conditions: config.conditions.map(c => ({
      key: c.key, indicator: c.indicator, params: c.params, type: c.type,
      level: c.level, bars: c.bars, offset: c.offset, tol: c.tol,
      any: c.any ? c.any.map(x => x.indicator) : undefined,
    })),
    filtersUsed: opt.filters,
    useBaseConditions: opt.useBaseConditions,
    universeSize: universe.length,
    stocksUsed: perStock.length,
    stocksFailed: failures.length,
    failureSample: failures.slice(0, 5),
    dataFrom: dates[0] || null,
    dataTo: perStock[0]?.lastDate || null,
    splitDate: opt.splitDate,
    rules: {
      holdDays: opt.holdDays, targetPct: opt.targetPct, stopPct: opt.stopPct,
      minPassCount: Math.min(opt.minPassCount, config.conditions.length),
      entry: opt.pullbackPct > 0
        ? `신호일 종가 대비 -${opt.pullbackPct}% 지정가, ${opt.pullbackWaitBars}봉 안에 안 닿으면 진입 안 함`
        : '신호 다음 봉 시가',
      pullbackPct: opt.pullbackPct, pullbackWaitBars: opt.pullbackWaitBars,
      addOn: opt.addOnDropPct > 0
        ? `진입가 대비 -${opt.addOnDropPct}%에서 나머지 매수 (1차 ${Math.round(opt.firstWeight * 100)}%), 목표·손절은 새 평단 기준`
        : '1회 매수',
      addOnDropPct: opt.addOnDropPct, firstWeight: opt.firstWeight,
      exitPriority: '같은 날 목표·손절 동시 도달 시 손절로 계산',
    },
    ...agg,
  };
}

app.get('/api/backtest/filters', checkStatsAuth, (req, res) => {
  const base = loadMomentumConfig();
  res.json({
    baseConditionCount: base.conditions.length,
    baseLabel: base.label,
    filters: Object.entries(BACKTEST_FILTERS).map(([id, f]) => ({ id, label: f.label })),
  });
});

app.get('/api/backtest', checkStatsAuth, async (req, res) => {
  const num = (raw, def) => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  const market = ['KOSPI', 'KOSDAQ', 'ALL', 'US'].includes(req.query.market) ? req.query.market : 'ALL';
  const krDays = Math.min(1800, Math.max(300, Math.round(num(req.query.krDays, 1800))));

  const opt = {
    market,
    universeN: Math.min(200, Math.max(5, Math.round(num(req.query.n, 150)))),
    useBaseConditions: req.query.base !== '0',
    filters: String(req.query.filters || '').split(',').map(s => s.trim()).filter(Boolean),
    holdDays: Math.min(40, Math.max(1, Math.round(num(req.query.hold, 10)))),
    targetPct: Math.max(0.5, num(req.query.target, 6)),
    stopPct: Math.max(0.5, num(req.query.stop, 6)),
    minPassCount: Math.max(1, Math.round(num(req.query.minPass, 99))),   // 기본은 전부 충족
    warmupBars: Math.min(200, Math.max(60, Math.round(num(req.query.warmup, 80)))),
    // 눌림목 진입: 0이면 예전처럼 다음 봉 시가에 바로 산다.
    pullbackPct: Math.max(0, num(req.query.pullback, 5)),
    pullbackWaitBars: Math.min(10, Math.max(1, Math.round(num(req.query.pullbackWait, 3)))),
    // 분할매수: 0이면 1회 매수. 값을 주면 진입가 대비 그만큼 빠질 때 나머지를 더 산다.
    addOnDropPct: Math.max(0, num(req.query.addOn, 0)),
    firstWeight: Math.min(0.95, Math.max(0.05, num(req.query.firstWeight, 0.5))),
    splitDate: String(req.query.splitDate || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.splitDate : null,
    krCalendarDays: krDays,
    yahooRange: ['1y', '2y', '5y', '10y'].includes(req.query.range) ? req.query.range : '5y',
    usMode: req.query.usMode === 'turnover' ? 'turnover' : 'marketCap',
    usMinPrice: Math.max(0, num(req.query.minPrice, 5)),
    usMinMarketCapM: Math.max(0, num(req.query.minMarketCap, 500)),
  };

  // 검증 구간을 안 정했으면 데이터의 뒤 3분의 1을 자동으로 떼어 둔다.
  if (!opt.splitDate) {
    const d = new Date();
    const span = market === 'US' ? ({ '1y': 365, '2y': 730, '5y': 1825, '10y': 3650 })[opt.yahooRange] : krDays;
    d.setDate(d.getDate() - Math.round(span / 3));
    opt.splitDate = d.toISOString().slice(0, 10);
    opt.splitDateAuto = true;
  }

  try {
    res.json(await runBacktest(opt));
  } catch (e) {
    res.status(502).json({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
  }
});

app.get('/api/us-momentum', checkStatsAuth, async (req, res) => {
  const numParam = (raw, def) => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };

  let wCond = Math.max(0, numParam(req.query.weightCond, 40));
  let wSector = Math.max(0, numParam(req.query.weightSector, 30));
  let wVolume = Math.max(0, numParam(req.query.weightVolume, 10));
  let wKeyword = Math.max(0, numParam(req.query.weightKeyword, 20));
  const sum = wCond + wSector + wVolume + wKeyword;
  if (sum <= 0) { wCond = 0.4; wSector = 0.3; wVolume = 0.1; wKeyword = 0.2; }
  else { wCond /= sum; wSector /= sum; wVolume /= sum; wKeyword /= sum; }

  const opt = {
    mode: req.query.mode === 'turnover' ? 'turnover' : 'marketCap',
    universeN: Math.min(600, Math.max(20, Math.round(numParam(req.query.n, 300)))),
    poolMultiplier: Math.min(3, Math.max(1, numParam(req.query.poolMultiplier, 1.5))),
    barsAgo: numParam(req.query.barsAgo, 0) >= 1 ? 1 : 0,
    minPrice: Math.max(0, numParam(req.query.minPrice, 5)),
    minMarketCapM: Math.max(0, numParam(req.query.minMarketCap, 500)),
    minTurnoverM: Math.max(0, numParam(req.query.minTurnover, 20)),
    minListedYears: Math.max(0, numParam(req.query.minListedYears, 1)),
    minPassCount: Math.min(5, Math.max(0, Math.round(numParam(req.query.minPass, 3)))),
    topN: Math.min(10, Math.max(1, Math.round(numParam(req.query.topN, 6)))),
    keywords: String(req.query.keywords || '').split(/[,]+/).map(s => s.trim()).filter(Boolean).slice(0, 12),
    weightCond: wCond, weightSector: wSector, weightVolume: wVolume, weightKeyword: wKeyword,
    withFairValue: req.query.fairValue !== '0',
    regime: ['up', 'flat', 'down'].includes(req.query.regime) ? req.query.regime : 'up',
    // 미국 회사채 수준을 감안한 기본값. 한국(4.64%)보다 높게 잡는다.
    kbasePct: (() => { const v = numParam(req.query.kbase, 5.5); return v > 0 ? v : 5.5; })(),
  };

  try {
    res.json(await runUsMomentum(opt));
  } catch (e) {
    res.status(502).json({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
  }
});

app.get('/api/us-universe-raw', checkStatsAuth, async (req, res) => {
  try {
    const rows = await US.fetchUsScreenerRows();
    const mode = req.query.mode === 'turnover' ? 'turnover' : 'marketCap';
    const built = US.buildUsUniverse(rows, {
      mode,
      minPrice: Number(req.query.minPrice) || 5,
      minMarketCapM: Number(req.query.minMarketCap) || 500,
    });
    res.json({
      rawCount: rows.length,
      afterFilter: built.list.length,
      sortedBy: built.sortedBy,
      rejected: built.rejected,
      sampleRawKeys: Object.keys(rows[0] || {}),
      top20: built.list.slice(0, 20),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/us-fundamentals-raw/:symbol', checkStatsAuth, async (req, res) => {
  try {
    res.json(await US.fetchUsFundamentals(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message, hint: '야후 quoteSummary는 쿠키·크럼을 요구하며 401을 내는 일이 잦습니다. 적정주가만 빠지고 스크리너 자체는 동작합니다.' });
  }
});

/**
 * 미국 일봉 출처 탐색기.
 *
 * 야후·Stooq가 동시에 막히는 일이 실제로 벌어졌다(2026-09, Render IP 차단으로 추정).
 * 어느 경로가 살아 있는지 짐작으로 고치면 또 헛다리를 짚게 되므로,
 * 후보를 한 번에 찔러보고 상태 코드·응답 크기·앞부분을 그대로 보여준다.
 */
app.get('/api/us-probe/:symbol', checkStatsAuth, async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };

  const cands = [
    ['yahoo-q1', `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1y&interval=1d`, H],
    ['yahoo-q2', `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=1y&interval=1d`, H],
    ['stooq-com', `https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`, H],
    ['stooq-pl', `https://stooq.pl/q/d/l/?s=${sym.toLowerCase()}.us&i=d`, H],
    ['naver-chart-O', `https://api.stock.naver.com/chart/foreign/item/${sym}.O/day?startDateTime=${US.ymdhm(-400)}&endDateTime=${US.ymdhm(0)}`, { ...H, Referer: 'https://m.stock.naver.com/' }],
    ['naver-chart-N', `https://api.stock.naver.com/chart/foreign/item/${sym}.N/day?startDateTime=${US.ymdhm(-400)}&endDateTime=${US.ymdhm(0)}`, { ...H, Referer: 'https://m.stock.naver.com/' }],
    ['naver-basic-O', `https://api.stock.naver.com/stock/${sym}.O/basic`, { ...H, Referer: 'https://m.stock.naver.com/' }],
    ['naver-worldstock', `https://api.stock.naver.com/stock/worldItem/${sym}.O/basic`, { ...H, Referer: 'https://m.stock.naver.com/' }],
  ];

  const results = await Promise.all(cands.map(async ([name, url, headers]) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      return {
        name, url, status: r.status, ok: r.ok, ms: Date.now() - t0, bytes: text.length,
        // 일봉이 몇 개나 들어 있는지 대충 센다. 날짜 패턴 개수로 본다.
        dateHits: (text.match(/\d{4}-\d{2}-\d{2}/g) || []).length
          + (text.match(/"timestamp"\s*:\s*\[/) ? 1000 : 0),
        head: text.slice(0, 200).replace(/\s+/g, ' '),
      };
    } catch (e) {
      return { name, url, error: e.message, ms: Date.now() - t0 };
    }
  }));

  res.json({ symbol: sym, hint: 'dateHits가 크거나 1000 이상이면 그 경로에 일봉이 들어 있습니다.', results });
});

app.get('/api/us-bars/:symbol', checkStatsAuth, async (req, res) => {
  try {
    const { bars, source, note } = await US.fetchUsBars(req.params.symbol);
    const ev = MC.evaluate(bars, loadMomentumConfig(), { barsAgo: Number(req.query.barsAgo) >= 1 ? 1 : 0 });
    res.json({ symbol: req.params.symbol, source, note: note || null, barCount: bars.length, last5: bars.slice(-5), evaluation: ev });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/momentum', checkStatsAuth, async (req, res) => {
  const numParam = (raw, def) => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };

  let wCond = Math.max(0, numParam(req.query.weightCond, 40));
  let wSector = Math.max(0, numParam(req.query.weightSector, 30));
  let wVolume = Math.max(0, numParam(req.query.weightVolume, 20));
  let wKeyword = Math.max(0, numParam(req.query.weightKeyword, 10));
  const wSum = wCond + wSector + wVolume + wKeyword;
  if (wSum <= 0) { wCond = 0.4; wSector = 0.3; wVolume = 0.2; wKeyword = 0.1; }
  else { wCond /= wSum; wSector /= wSum; wVolume /= wSum; wKeyword /= wSum; }

  const opt = {
    universeN: Math.min(2000, Math.max(10, Math.round(numParam(req.query.n, 150)))),
    market: req.query.market === 'KOSPI' ? 'KOSPI' : req.query.market === 'KOSDAQ' ? 'KOSDAQ' : 'ALL',
    barsAgo: numParam(req.query.barsAgo, 0) >= 1 ? 1 : 0,
    minTurnoverEok: Math.max(0, numParam(req.query.minTurnover, 30)),
    minPassCount: Math.min(5, Math.max(0, Math.round(numParam(req.query.minPass, 3)))),
    topN: Math.min(10, Math.max(1, Math.round(numParam(req.query.topN, 3)))),
    keywords: String(req.query.keywords || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 12),
    withFairValue: req.query.fairValue !== '0',
    regime: ['up', 'flat', 'down'].includes(req.query.regime) ? req.query.regime : 'up',
    kbasePct: (() => { const v = numParam(req.query.kbase, 4.64); return v > 0 ? v : 4.64; })(),
    weightCond: wCond, weightSector: wSector, weightVolume: wVolume, weightKeyword: wKeyword,
  };

  try {
    res.json(await runMomentum(opt));
  } catch (e) {
    res.status(502).json({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
  }
});

/* ───────────────────────── 디버그 ───────────────────────── */

/**
 * 조건 정의를 화면에 뿌려주는 엔드포인트. 인증이 걸려 있으므로 소유자만 볼 수 있고,
 * 정의 자체는 저장소가 아니라 환경변수/로컬 파일에서 온다.
 */
app.get('/api/momentum/conditions', checkStatsAuth, (req, res) => {
  const c = loadMomentumConfig();
  res.json({
    configured: c.conditions.length > 0,
    source: c.source || 'none',
    label: c.label,
    conditions: c.conditions.map(x => ({
      key: x.key, desc: x.desc, indicator: x.indicator,
      params: x.params, type: x.type, level: x.level, bars: x.bars,
    })),
    availableIndicators: Object.keys(MC.INDICATORS),
    availableTypes: ['crossUp', 'crossDown', 'above', 'below', 'rising', 'falling'],
  });
});

app.get('/api/ohlcv/:code', checkStatsAuth, async (req, res) => {
  try {
    const { bars, source } = await fetchOhlcv(req.params.code);
    const ev = MC.evaluate(bars, loadMomentumConfig(), { barsAgo: Number(req.query.barsAgo) >= 1 ? 1 : 0 });
    res.json({ code: req.params.code, source, barCount: bars.length, last5: bars.slice(-5), evaluation: ev });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * 종목 하나에 대해 각 출처가 무엇을 돌려줬는지 나란히 보여준다.
 * "검토 0종목"처럼 전 종목이 탈락할 때, 어느 출처의 어느 항목이 비었는지 한눈에 본다.
 */
/**
 * 재무 항목(자기자본·ROE·발행주식수) 출처 탐색기.
 *
 * 2026-09 개편으로 네이버 종목 페이지의 표가 사라졌고 FnGuide 파싱도 값을 못 냈다.
 * 어떤 API가 무엇을 담고 있는지 확인해야 파서를 다시 맞출 수 있는데, 응답 전체를
 * 눈으로 보기엔 너무 커서 — 관심 있는 라벨만 골라 경로와 값을 보여준다.
 */
const FIN_LABEL = /roe|자본|주식수|shares|equity|bps|자기주식|자사주|발행/i;

/** JSON을 훑어 라벨이 관심 항목에 걸리는 자리만 경로와 함께 모은다. */
function findFinancialHits(node, path, out, depth) {
  if (node == null || (depth || 0) > 7 || out.length >= 60) return out;
  if (Array.isArray(node)) {
    node.slice(0, 40).forEach((v, i) => findFinancialHits(v, `${path}[${i}]`, out, (depth || 0) + 1));
    return out;
  }
  if (typeof node !== 'object') return out;

  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (FIN_LABEL.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      out.push({ path: p, value: String(v).slice(0, 40) });
    } else if (typeof v === 'string' && FIN_LABEL.test(v) && v.length < 30) {
      // { title: "ROE", ... } 처럼 라벨이 값 쪽에 있는 경우 — 형제 필드를 같이 보여준다.
      const siblings = {};
      Object.entries(node).slice(0, 12).forEach(([sk, sv]) => {
        if (typeof sv === 'string' || typeof sv === 'number') siblings[sk] = String(sv).slice(0, 30);
        else if (sv && typeof sv === 'object') siblings[sk] = '(' + (Array.isArray(sv) ? 'array' : 'object') + ')';
      });
      out.push({ path: p, labelValue: v, siblings });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') findFinancialHits(v, path ? `${path}.${k}` : k, out, (depth || 0) + 1);
  }
  return out;
}

app.get('/api/probe/:code', async (req, res) => {
  const code = req.params.code;
  const candidates = [
    ['naver-integration', `https://m.stock.naver.com/api/stock/${code}/integration`],
    ['naver-basic', `https://m.stock.naver.com/api/stock/${code}/basic`],
    ['naver-finance-annual', `https://m.stock.naver.com/api/stock/${code}/finance/annual`],
    ['naver-finance-quarter', `https://m.stock.naver.com/api/stock/${code}/finance/quarter`],
    ['naver-price-basic', `https://api.stock.naver.com/stock/${code}/basic`],
    ['naver-integration-alt', `https://api.stock.naver.com/stock/${code}/integration`],
    ['wisereport', `https://navercomp.wisereport.co.kr/v1/company/c1010001.aspx?cmp_cd=${code}&finGubun=MAIN&frq=0`],
  ];

  const results = await Promise.all(candidates.map(async ([name, url]) => {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://m.stock.naver.com/' },
      });
      const text = await r.text();
      if (!r.ok) return { name, url, status: r.status, head: text.slice(0, 150) };
      let j = null;
      try { j = JSON.parse(text); } catch { /* HTML일 수 있다 */ }
      if (!j) {
        // JSON이 아니면 본문에서 라벨 주변 텍스트만 잘라 보여준다.
        const flat = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const snippets = [];
        for (const kw of ['ROE', '지배주주지분', '자본총계', '발행주식수', '자기주식']) {
          const idx = flat.indexOf(kw);
          if (idx >= 0) snippets.push(kw + ' → ' + flat.slice(idx, idx + 90));
        }
        return { name, url, status: r.status, type: 'html', bytes: text.length, snippets };
      }
      return {
        name, url, status: r.status, type: 'json', bytes: text.length,
        topKeys: Object.keys(j).slice(0, 20),
        hits: findFinancialHits(j, '', [], 0).slice(0, 25),
      };
    } catch (e) {
      return { name, url, error: e.message };
    }
  }));

  res.json({ code, results });
});

app.get('/api/fundamentals-raw/:code', async (req, res) => {
  const code = req.params.code;
  const [a, fin, n, f] = await Promise.allSettled([
    fromNaverApi(code), fromNaverFinance(code), fromNaver(code), fromFnGuide(code),
  ]);
  const val = (p) => p.status === 'fulfilled' ? p.value : { error: p.reason?.message || '실패' };
  let merged = null, mergedError = null;
  try { merged = await getFundamentals(code); }
  catch (e) { mergedError = e.message; }
  res.json({
    code,
    naverApi: val(a),
    naverFinance: val(fin),
    naverHtml: val(n),
    fnguide: val(f),
    merged, mergedError,
    // 스크리너가 요구하는 네 항목이 다 찼는지 — 하나라도 비면 그 종목은 제외된다.
    screenerReady: merged ? {
      price: merged.price ?? null,
      equityEok: merged.equityEok ?? null,
      shares: merged.shares ?? null,
      roe: merged.roe,
      ok: !!(merged.price && merged.equityEok && merged.shares && merged.roe.every(v => v != null)),
    } : null,
  });
});

/**
 * 업종 분류·해외 재무 출처 탐색기.
 *
 * 네이버가 시가총액 → 종목 페이지 → 업종 페이지 순으로 차례차례 재구축했다.
 * 짐작으로 고치면 또 빗나가므로 후보를 한 번에 찔러보고 응답을 그대로 보여준다.
 */
app.get('/api/sector-probe', checkStatsAuth, async (req, res) => {
  const H = { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/' };
  const HM = { ...H, Accept: 'application/json', Referer: 'https://m.stock.naver.com/' };

  const cands = [
    ['html-upjong', 'https://finance.naver.com/sise/sise_group.naver?type=upjong', H],
    ['html-theme', 'https://finance.naver.com/sise/theme.naver', H],
    ['api-industry', 'https://m.stock.naver.com/api/stocks/industry', HM],
    ['api-industry-list', 'https://api.stock.naver.com/industry/list', HM],
    ['api-upjong', 'https://m.stock.naver.com/api/stocks/upjong', HM],
    // 종목 하나의 업종 정보 — 종목별로 받아도 되는지 확인용
    ['api-integration-005930', 'https://m.stock.naver.com/api/stock/005930/integration', HM],
  ];

  const results = await Promise.all(cands.map(async ([name, url, headers]) => {
    try {
      const r = await fetch(url, { headers });
      const buf = Buffer.from(await r.arrayBuffer());
      let text = buf.toString('utf8');
      // 구버전 페이지는 EUC-KR이라 utf8로 읽으면 깨진다 — 깨졌으면 다시 디코딩한다.
      if (/\uFFFD/.test(text.slice(0, 500))) text = iconv.decode(buf, 'euc-kr');
      let parsed = null;
      try {
        const j = JSON.parse(text);
        parsed = { type: 'json', topKeys: Object.keys(j).slice(0, 15), sample: JSON.stringify(j).slice(0, 300) };
      } catch {
        parsed = {
          type: 'html',
          groupLinks: (text.match(/sise_group_detail/g) || []).length,
          industryHits: (text.match(/industry/gi) || []).length,
          head: text.slice(0, 250).replace(/\s+/g, ' '),
        };
      }
      return { name, url, status: r.status, bytes: buf.length, ...parsed };
    } catch (e) {
      return { name, url, error: e.message };
    }
  }));
  res.json({ hint: 'groupLinks가 0이 아니거나 json의 topKeys에 업종 목록이 보이는 경로를 씁니다.', results });
});

/** 해외 종목 재무·기본정보 후보 탐색 (네이버가 409를 내는 이유를 찾기 위함) */
app.get('/api/us-fin-probe/:symbol', checkStatsAuth, async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const HM = { 'User-Agent': UA, Accept: 'application/json', Referer: `https://m.stock.naver.com/worldstock/stock/${sym}.O/total` };

  /* 화면(m.stock.naver.com/worldstock/stock/IBM.O/total)에 BPS·EPS·시총·업종이
   * 다 나오므로 데이터는 분명히 있다. 앞서 찍어본 주소가 전부 404였으므로,
   * 일봉이 실제로 동작하는 chart/foreign 계열을 기준으로 이웃 경로를 훑는다. */
  const cands = [
    // 먼저 심볼 형식을 확인한다. 일봉이 되는 경로에서 reutersCode를 확인하면
    // 재무 경로에 어떤 심볼을 써야 하는지 알 수 있다.
    ['chart-day(형식확인)', `https://api.stock.naver.com/chart/foreign/item/${sym}.O/day?startDateTime=${US.ymdhm(-10)}&endDateTime=${US.ymdhm(0)}`],
    ['search', `https://m.stock.naver.com/api/search/stock?query=${sym}`],
    ['stock-basic', `https://api.stock.naver.com/stock/${sym}.O/basic`],
    ['stock-integration', `https://api.stock.naver.com/stock/${sym}.O/integration`],
    ['stock-total', `https://api.stock.naver.com/stock/${sym}.O/total`],
    ['stock-finance', `https://api.stock.naver.com/stock/${sym}.O/finance/annual`],
    ['m-stock-basic', `https://m.stock.naver.com/api/stock/${sym}.O/basic`],
    ['m-stock-integration', `https://m.stock.naver.com/api/stock/${sym}.O/integration`],
    ['m-stock-finance', `https://m.stock.naver.com/api/stock/${sym}.O/finance/annual`],
    ['m-worldstock-total', `https://m.stock.naver.com/api/worldstock/stock/${sym}.O/total`],
    ['api-worldstock-basic', `https://api.stock.naver.com/worldstock/stock/${sym}.O/basic`],
    ['api-worldstock-integration', `https://api.stock.naver.com/worldstock/stock/${sym}.O/integration`],
    ['api-worldstock-finance', `https://api.stock.naver.com/worldstock/stock/${sym}.O/finance/annual`],
    ['chart-sibling-basic', `https://api.stock.naver.com/chart/foreign/item/${sym}.O/basic`],
  ];

  const results = await Promise.all(cands.map(async ([name, url]) => {
    try {
      const r = await fetch(url, { headers: HM });
      const text = await r.text();
      const hit = (re) => re.test(text);
      const out = { name, url, status: r.status, bytes: text.length };
      if (r.ok) {
        out.bpsHit = hit(/bps|주당순자산/i);
        out.roeHit = hit(/\broe\b/i);
        out.epsHit = hit(/\beps\b/i);
        try { out.topKeys = Object.keys(JSON.parse(text)).slice(0, 15); } catch { /* HTML */ }
        out.head = text.slice(0, 220).replace(/\s+/g, ' ');
      } else {
        out.head = text.slice(0, 120).replace(/\s+/g, ' ');
      }
      return out;
    } catch (e) {
      return { name, url, error: e.message };
    }
  }));

  res.json({
    symbol: sym,
    hint: 'status 200이면서 bpsHit 또는 epsHit가 true인 경로를 씁니다.',
    ok: results.filter(r => r.status === 200).map(r => r.name),
    results,
  });
});

app.get('/api/sectors-raw', checkStatsAuth, async (req, res) => {
  try {
    // 어느 단계에서 끊겼는지 같이 보여준다. source만으로는 원인을 알 수 없었다.
    let apiGroups = null, apiError = null, memberSample = null;
    try {
      const g = await fetchSectorListApi();
      apiGroups = g.length;
      if (g.length) memberSample = { no: g[0].no, name: g[0].name, members: (await fetchSectorMembersApi(g[0].no)).length };
    } catch (e) { apiError = e.message; }

    const m = await fetchSectorMap();
    res.json({
      sectorCount: m.sectors.length,
      mappedCodes: Object.keys(m.byCode).length,
      fetchedAt: m.fetchedAt,
      source: m.source || null,
      industryApi: { groups: apiGroups, error: apiError, memberSample },
      sectors: m.sectors,
      sample: Object.entries(m.byCode).slice(0, 10),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/raw/:code', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '');
  const src = req.query.src === 'naver' ? 'naver' : 'fnguide';
  try {
    const url = src === 'naver'
      ? `https://finance.naver.com/item/main.naver?code=${code}`
      : `https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A${code}&cID=&MenuYn=Y&ReportGB=&NewMenuID=101&stkGb=701`;
    res.type('text/plain').send(await fetchHtml(url));
  } catch (e) {
    res.status(502).send(e.message);
  }
});

app.get('/api/history-raw/:code', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '');
  const page = Number(req.query.page) || 1;
  try {
    const url = `https://finance.naver.com/item/sise_day.naver?code=${code}&page=${page}`;
    res.type('text/plain').send(await fetchHtml(url));
  } catch (e) {
    res.status(502).send(e.message);
  }
});

/**
 * 데이터 소스 점검. "낮엔 되다가 밤에 안 된다"처럼 시간대에 따라 달라지는 문제는,
 * 어느 소스가 어떤 상태 코드로 막혔는지 봐야 원인을 알 수 있다.
 * 각 소스에 1건씩만 요청해서 상태·응답크기·파싱 결과를 그대로 보여준다.
 */
app.get('/api/diag', async (req, res) => {
  const UA_H = { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/' };
  const probe = async (name, url, check) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers: UA_H, redirect: 'follow' });
      const buf = Buffer.from(await r.arrayBuffer());
      const text = buf.toString('utf8');
      return {
        source: name, ok: r.ok, status: r.status, ms: Date.now() - t0,
        bytes: buf.length,
        parsed: check ? check(text, buf) : null,
        contentType: r.headers.get('content-type') || null,
        // 차단 페이지는 보통 짧고 안내 문구가 들어 있다 — 앞부분을 그대로 보여준다.
        head: buf.length < 4000 ? text.slice(0, 300).replace(/\s+/g, ' ') : null,
      };
    } catch (e) {
      return { source: name, ok: false, status: null, ms: Date.now() - t0, error: e.message };
    }
  };

  // 시가총액 순위는 수집 경로가 여러 개라, 경로별로 몇 종목을 뽑아냈는지 각각 보여준다.
  const capProbes = [];
  for (const sosok of [0, 1]) {
    for (const src of marketCapSources(1, sosok, 50)) {
      capProbes.push(probe(`시가총액(${MARKET_NAME[sosok]}) ${src.name}`, src.url,
        t => { try { return src.parse(t).length + '종목'; } catch (e) { return '파싱 오류: ' + e.message; } }));
    }
  }

  const results = await Promise.all([
    ...capProbes,
    probe('기본정보API(삼성전자)', 'https://m.stock.naver.com/api/stock/005930/basic', t => {
      try { const p = findValueByKey(JSON.parse(t), PRICE_KEY, 0); return p ? '현재가 ' + p : '현재가 키 없음'; }
      catch { return 'JSON 아님'; }
    }),
    probe('통합API(삼성전자)', 'https://m.stock.naver.com/api/stock/005930/integration', t => {
      try {
        const j = JSON.parse(t);
        return '현재가 ' + (findValueByKey(j, PRICE_KEY, 0) ?? '없음')
          + ' / 상장주식수 ' + (findValueByKey(j, SHARES_KEY, 0) ?? '없음');
      } catch { return 'JSON 아님'; }
    }),
    probe('종목페이지HTML(삼성전자)', 'https://finance.naver.com/item/main.naver?code=005930', t => /no_today/.test(t) ? '현재가 영역 있음' : '현재가 영역 없음'),
    probe('수급(삼성전자)', 'https://stock.naver.com/api/domestic/detail/005930/trend?tradeType=KRX&startIdx=0&pageSize=5', t => { try { return JSON.parse(t).length + '행'; } catch { return 'JSON 아님'; } }),
    probe('일봉 차트API(삼성전자)', 'https://api.finance.naver.com/siseJson.naver?symbol=005930&requestType=1&timeframe=day', t => ((t.match(/\["?\d{8}/g) || []).length) + '봉'),
    probe('일별시세HTML(삼성전자)', 'https://finance.naver.com/item/sise_day.naver?code=005930&page=1', t => ((t.match(/\d{4}\.\d{2}\.\d{2}/g) || []).length) + '개 날짜셀'),
    probe('업종목록', 'https://finance.naver.com/sise/sise_group.naver?type=upjong', t => ((t.match(/sise_group_detail/g) || []).length) + '개 업종링크'),
    probe('FnGuide(삼성전자)', 'https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A005930', t => /highlight_D_A/.test(t) ? '재무표 있음' : '재무표 없음'),
  ]);

  res.json({
    at: new Date().toISOString(),
    kst: kstDate(),
    healthy: results.filter(r => r.ok).length + '/' + results.length,
    universeSourceInUse: LAST_UNIVERSE_SOURCE,
    lastGoodUniverse: [...LAST_GOOD_UNIVERSE.entries()].map(([k, v]) => ({
      key: k, count: v.list.length, ageHours: Math.round((Date.now() - v.at) / 3600000 * 10) / 10,
    })),
    results,
  });
});

app.get('/api/universe-raw', async (req, res) => {
  const page = Number(req.query.page) || 1;
  const sosok = req.query.market === 'KOSDAQ' ? 1 : 0;
  const sources = marketCapSources(page, sosok, 50);

  // ?raw=<경로이름> 이면 그 경로의 원문을 그대로 준다(파서를 고칠 때 필요).
  const rawWanted = String(req.query.raw || '');
  if (rawWanted) {
    const src = sources.find(x => x.name === rawWanted);
    if (!src) return res.status(400).send('경로 이름: ' + sources.map(x => x.name).join(', '));
    try { return res.type('text/plain').send(await fetchHtml(src.url)); }
    catch (e) { return res.status(502).send(e.message); }
  }

  // 기본은 경로별로 몇 종목을 뽑았는지 요약해서 보여준다 — 원문은 너무 길어서 읽기 어렵다.
  const out = [];
  for (const src of sources) {
    try {
      const text = await fetchHtml(src.url);
      const rows = src.parse(text);
      out.push({ source: src.name, url: src.url, bytes: text.length, count: rows.length, sample: rows.slice(0, 5) });
    } catch (e) {
      out.push({ source: src.name, url: src.url, error: e.message });
    }
  }
  res.json({ page, market: MARKET_NAME[sosok], sources: out, hint: '원문이 필요하면 ?raw=경로이름 을 붙이십시오.' });
});

app.get('/api/flow-raw/:code', async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '');
  try {
    const url = `https://stock.naver.com/api/domestic/detail/${code}/trend?tradeType=KRX&startIdx=0&pageSize=20`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://stock.naver.com/' } });
    res.type('text/plain').send(`HTTP ${r.status}\n\n` + await r.text());
  } catch (e) {
    res.status(502).send(e.message);
  }
});

/* ───────────────────────── 스크리너: 성과검증 ─────────────────────────
 *
 * 스캔이 실제로 TOP3를 냈으면(candidates.length>0), 그날의 추천 내역을
 * "reco:날짜" 키로 남겨둔다 — 나중에 "그날 샀으면 지금 몇 %냐"를 계산하려면
 * 그날 실제로 뭘 추천했는지가 남아있어야 하기 때문이다. 방문자 통계와 같은
 * Upstash Redis를 재사용한다(둘 다 redisCmd/hasRedis). Upstash가 없으면
 * 메모리에만 남는데, 이 경우 서버 재시작(Render 무료 플랜은 15분 무접속 시
 * 재시작)마다 과거 추천 이력이 사라진다 — 성과검증 기능은 이 저장이 있어야
 * 의미가 있으므로, 방문자 통계보다도 Upstash 설정이 더 중요하다.
 *
 * 하루에 스캔을 여러 번(조건을 바꿔가며) 돌릴 수도 있으니, 그날 마지막으로
 * TOP3가 나온 스캔 결과로 그날 기록을 덮어쓴다 — "그날의 공식 추천"은
 * 하나만 남기는 식이다.
 */

const RECO_MEM = new Map(); // Upstash 없을 때 쓰는 메모리 저장소: 'kind:date' -> {date, opt, candidates}

// 저평가 스크리너와 모멘텀 스크리너는 같은 날 각자 추천을 남긴다.
// 한쪽이 다른 쪽 기록을 덮어쓰지 않도록 키 앞에 종류를 붙인다.
// (기존 기록과의 호환을 위해 저평가 쪽 접두어는 예전 그대로 'reco'를 쓴다.)
function recoNs(kind) { return kind === 'momentum' ? 'mreco' : 'reco'; }

async function recordRecommendation(date, opt, candidates, kind) {
  if (!candidates || !candidates.length) return;
  const ns = recoNs(kind);
  const payload = {
    date, kind: kind || 'value', opt,
    candidates: candidates.map(c => ({
      code: c.code, name: c.name, market: c.market || null,
      price: c.price, fairPrice: c.fairPrice ?? null, gapPct: c.gapPct ?? null, score: c.score,
    })),
  };
  if (hasRedis()) {
    await redisSetBody(ns + ':' + date, JSON.stringify(payload));
    await redisCmd('SADD', ns + ':dates', date);
  } else {
    RECO_MEM.set(ns + ':' + date, payload);
  }
}

async function getRecommendation(date, kind) {
  const ns = recoNs(kind);
  if (hasRedis()) {
    const raw = await redisCmd('GET', ns + ':' + date);
    return raw ? JSON.parse(raw) : null;
  }
  return RECO_MEM.get(ns + ':' + date) || null;
}

async function listRecommendationDates(kind) {
  const ns = recoNs(kind);
  if (hasRedis()) {
    const dates = await redisCmd('SMEMBERS', ns + ':dates');
    return (dates || []).slice().sort().reverse();
  }
  return [...RECO_MEM.keys()]
    .filter(k => k.startsWith(ns + ':'))
    .map(k => k.slice(ns.length + 1))
    .sort().reverse();
}

/**
 * 종목 하나의 "조회일 기준 가격"을 구한다.
 * 조회일이 오늘이면 실시간 현재가(getFundamentals), 과거 날짜면 그 날짜
 * 이전 중 가장 가까운 거래일 종가(fetchNaverHistory)를 쓴다 — 조회일이
 * 주말·공휴일이면 그 앞의 마지막 거래일 값으로 대체된다는 뜻이다.
 */
async function priceAsOf(code, asOfDate) {
  const today = kstDate();
  if (asOfDate >= today) {
    const fund = await getFundamentals(code);
    return { price: fund.price, actualDate: today, isLive: true };
  }
  const series = await fetchNaverHistory(code, asOfDate.slice(0, 8) + '01'); // 여유 있게 그 달 초부터
  const upTo = series.filter(r => r.date <= asOfDate);
  if (!upTo.length) return { price: null, actualDate: null, isLive: false };
  const last = upTo[upTo.length - 1];
  return { price: last.close, actualDate: last.date, isLive: false };
}

async function computePerformance(recoDate, asOfDate, selectedCodes, kind) {
  const reco = await getRecommendation(recoDate, kind);
  if (!reco) {
    const e = new Error('그 날짜의 추천 기록이 없습니다. /api/performance/dates로 기록이 있는 날짜를 확인하십시오.');
    e.notFound = true;
    throw e;
  }
  const wantAll = !selectedCodes || !selectedCodes.length;
  const stocks = await Promise.all(reco.candidates.map(async (c) => {
    const selected = wantAll || selectedCodes.includes(c.code);
    const base = {
      code: c.code, name: c.name, market: c.market, score: c.score,
      recoPrice: c.price, gapPctAtReco: c.gapPct, selected,
    };
    if (!selected) return { ...base, asOfPrice: null, asOfActualDate: null, returnPct: null };
    try {
      const asOf = await priceAsOf(c.code, asOfDate);
      const returnPct = (asOf.price != null && c.price > 0)
        ? Math.round((asOf.price / c.price - 1) * 10000) / 100
        : null;
      return { ...base, asOfPrice: asOf.price, asOfActualDate: asOf.actualDate, returnPct };
    } catch (e) {
      return { ...base, asOfPrice: null, asOfActualDate: null, returnPct: null, error: e.message };
    }
  }));

  const withReturn = stocks.filter(s => s.selected && s.returnPct != null);
  const portfolioReturnPct = withReturn.length
    ? Math.round((withReturn.reduce((s, x) => s + x.returnPct, 0) / withReturn.length) * 100) / 100
    : null;

  return {
    recoDate, asOfDate,
    kind: kind || 'value',
    recoOpt: reco.opt,
    stocks,
    selectedCodes: wantAll ? stocks.map(s => s.code) : selectedCodes,
    portfolioReturnPct,
  };
}

app.get('/api/performance/dates', checkStatsAuth, async (req, res) => {
  try {
    const kind = req.query.kind === 'momentum' ? 'momentum' : 'value';
    res.json({ kind, dates: await listRecommendationDates(kind), persisted: hasRedis() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/performance', checkStatsAuth, async (req, res) => {
  const recoDate = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recoDate)) {
    return res.status(400).json({ error: '?date=YYYY-MM-DD 형식으로 추천일을 지정하십시오.' });
  }
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf || '') ? req.query.asOf : kstDate();
  const selectedCodes = req.query.codes
    ? String(req.query.codes).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  try {
    const kind = req.query.kind === 'momentum' ? 'momentum' : 'value';
    res.json(await computePerformance(recoDate, asOfDate, selectedCodes, kind));
  } catch (e) {
    res.status(e.notFound ? 404 : 502).json({ error: e.message });
  }
});

/* ───────────────────────── 스크리너 API (Basic Auth, 소유자 전용) ─────────────────────────
 *
 * 종목 하나당 3건(네이버·FnGuide·수급)의 요청이 나가고, 유니버스 크기(기본 100)만큼
 * 곱해진다 — 한 번 스캔에 수백 건. 방문자 아무나 반복 실행하면 안 되므로 /stats와
 * 같은 계정으로 막는다. 결과는 그날(KST) 하루 캐시되어, 같은 조건이면 재계산하지 않는다.
 */

app.get('/api/screen', checkStatsAuth, async (req, res) => {
  // "숫자 || 기본값" 패턴은 0을 "값 없음"으로 오인해 몰래 기본값으로 되돌린다
  // (예: 사용자가 최소 수급강도를 0으로 명시해도 결과적으로 3%가 적용됨).
  // 쿼리 파라미터가 실제로 없을 때만 기본값을 쓰도록 구분한다.
  const numParam = (raw, def) => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  // 가중치 세 개가 합쳐서 1이 되게 정규화한다. 셋 다 0 이하면 기본 비중(저평가 50%)으로 되돌린다.
  const normWeights = (g, f, v) => {
    const sum = g + f + v;
    if (!(sum > 0)) return { g: 0.5, f: 0.3, v: 0.2 };
    return { g: g / sum, f: f / sum, v: v / sum };
  };
  const w = normWeights(
    Math.max(0, numParam(req.query.weightGap, 0.5)),
    Math.max(0, numParam(req.query.weightFlow, 0.3)),
    Math.max(0, numParam(req.query.weightVolume, 0.2)),
  );
  const opt = {
    universeN: Math.min(300, Math.max(10, numParam(req.query.n, 100))),
    market: ['KOSPI', 'KOSDAQ', 'ALL'].includes(req.query.market) ? req.query.market : 'KOSPI',
    regime: ['up', 'flat', 'down'].includes(req.query.regime) ? req.query.regime : 'up',
    kbasePct: numParam(req.query.kbase, 4.64), // 기본: AA등급 5년물 — 대형주 위주 유니버스 기준
    // 이 세 값은 이제 "필수 조건"이 아니라 선택적 사전 필터다. 기본값 0은 "필터 없음"을 뜻한다 —
    // 실제 순위는 아래 가중치로 합친 복합 점수로 매긴다.
    minGapPct: Math.max(0, numParam(req.query.minGap, 0)),
    // flowStrength는 순매도일 때 음수가 나올 수 있는 지표라, 0으로 바닥을 깔면
    // "필터 끔"이 아니라 "순매수인 종목만" 이 되어버린다. 기본값(-1 = -100%)은
    // 사실상 아무것도 거르지 않는 하한이고, 사용자가 원하면 0 이상 값을 넣어 필터로 쓴다.
    minFlowStrength: numParam(req.query.minFlow, -1),
    minVolumeRatio: Math.max(0, numParam(req.query.minVolRatio, 0)),
    flowDays: Math.min(20, Math.max(1, numParam(req.query.flowDays, 5))),
    weightGap: w.g,
    weightFlow: w.f,
    weightVolume: w.v,
  };
  try {
    const result = await runScreen(opt);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message, stack: String(e.stack || '').split('\n').slice(0, 5) });
  }
});

// 스캔 전체를 안 돌리고, 종목 하나의 수급 계산값만 빠르게 확인하는 진단용 엔드포인트.
app.get('/api/flow/:code', checkStatsAuth, async (req, res) => {
  const code = String(req.params.code).replace(/\D/g, '').padStart(6, '0');
  const days = Number(req.query.days) || 5;
  try {
    const flow = await fetchInvestorFlow(code, days);
    res.json({
      code,
      hasData: flow.hasData,
      flowStrength: flow.flowStrength,
      flowStrengthPct: flow.flowStrength != null ? (flow.flowStrength * 100).toFixed(2) + '%' : null,
      volumeRatio: flow.volumeRatio,
      flowSum: flow.flowSum,
      volAvg20: flow.volAvg20,
      lastVol: flow.lastVol,
      recentRows: flow.rows.slice(-days),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * 배포 확인용 표식.
 * "고쳤는데 왜 그대로냐"의 원인이 대부분 "아직 예전 코드가 돌고 있다"였다.
 * BUILD를 올려두면 /api/health만 열어봐도 지금 무엇이 떠 있는지 바로 알 수 있다.
 */
const BUILD = '2026-09-13e 업종 API 파라미터 수정';

app.get('/api/health', (_, res) => res.json({
  ok: true,
  build: BUILD,
  features: {
    momentumTab: true,              // 모멘텀·섹터 스크리너
    conditionsExternalized: true,   // 조건식을 환경변수/로컬파일에서 로드
    conditionsConfigured: loadMomentumConfig().conditions.length > 0,
    conditionSource: loadMomentumConfig().source || 'none',
    universeMultiSource: true,      // 시가총액 수집 3경로
    stockBasicViaApi: true,         // 현재가·종목명을 JSON API에서 우선 수집
    financeViaApi: true,            // ROE·자기자본을 네이버 재무 API에서도 수집
    momentumFairValue: true,        // 모멘텀 최종 후보에 적정주가 표시
    usMomentumTab: true,            // 미국장 모멘텀 스크리너
    backtest: true,                 // 과거 데이터 되돌림 검증
    probeEndpoint: true,            // /api/probe/:code
    universeMax: 2000,
    diagEndpoint: true,             // /api/diag
  },
  universeSourceInUse: LAST_UNIVERSE_SOURCE,
  cache: cache.size,
  at: new Date().toISOString(),
}));

/* ───────────────────────── 방문자 통계 ─────────────────────────
 *
 * 방문자 IP는 저장하지 않는다. IP + salt를 해시한 값만 남기고,
 * 그 해시를 HyperLogLog(PFADD/PFCOUNT)에 넣어 "대략 몇 명"만 센다.
 * 정확한 명단이 필요한 게 아니라 추세만 보면 되기 때문.
 *
 * 영구 저장은 Upstash Redis REST API를 그대로 fetch로 호출한다(별도 SDK 불필요).
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 이 없으면
 * 메모리에만 세는데, 이 경우 서버가 재시작되면(Render 무료 플랜은
 * 15분 무접속 시 잠들었다 재시작) 숫자가 0으로 돌아간다.
 * rain-proxy에서 쓰던 것과 같은 Upstash 무료 DB를 재사용해도 되고,
 * 새로 하나 더 만들어도 된다 — 키 이름이 겹치지 않아 서로 방해하지 않는다.
 */

// 콘솔 화면 값을 따옴표째로 복사해 붙여넣는 실수가 흔해서(예: "https://x.upstash.io"),
// 앞뒤 공백과 감싸는 따옴표(' 또는 ")를 자동으로 벗겨낸다.
function cleanEnv(raw) {
  if (!raw) return raw;
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}
const UPSTASH_URL = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
const BOOT_SALT = crypto.randomBytes(16).toString('hex'); // VISIT_SALT 미설정 시 임시로 씀 (재시작마다 바뀜)

async function redisCmd(...args) {
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const r = await fetch(`${UPSTASH_URL}/${path}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const j = await r.json();
  return j.result;
}

/**
 * SET처럼 값 자체가 복잡한(JSON 문자열 등, 중괄호·따옴표·콜론이 잔뜩 든) 경우 쓴다.
 * 값을 URL 경로에 욱여넣으면(redisCmd처럼) 인코딩이 왕복하면서 깨지는 경우가 있었다
 * (실제로 겪음 — 저장은 되는데 불러오면 URL 인코딩된 문자열 그대로 나옴).
 * Upstash REST API가 지원하는 대로, 명령어와 키만 경로에 넣고 값은 요청 본문에 실어 보낸다.
 */
async function redisSetBody(key, value) {
  const path = ['SET', key].map(a => encodeURIComponent(String(a))).join('/');
  const r = await fetch(`${UPSTASH_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
    body: String(value),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const j = await r.json();
  return j.result;
}
// URL/TOKEN 값이 서로 바뀌어 들어가거나 잘못된 값이 들어가면(예: URL 칸에 토큰이 들어감),
// fetch가 그 순간 예외를 던지는 대신 여기서 미리 걸러서 "Redis 없음"으로 조용히 처리한다.
function hasRedis() { return !!(UPSTASH_URL && UPSTASH_TOKEN && /^https?:\/\//.test(UPSTASH_URL)); }

// Upstash 없을 때 쓰는 메모리 저장소 — 재시작하면 초기화됨
const mem = {
  pvTotal: 0,
  pvDaily: new Map(),          // date → count
  uvTotal: new Set(),          // hashed id
  uvDaily: new Map(),          // date → Set(hashed id)
};

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|discordbot|headless|monitor|uptime/i;

function kstDate(d) {
  const t = (d instanceof Date ? d : new Date()).getTime() + 9 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(kstDate(new Date(Date.now() - i * 86400000)));
  return out;
}

async function recordVisit(req) {
  const ua = req.headers['user-agent'] || '';
  if (BOT_RE.test(ua)) return;

  const ip = String(req.ip || '').replace('::ffff:', '');
  const salt = process.env.VISIT_SALT || BOOT_SALT;
  const id = crypto.createHash('sha256').update(ip + '|' + salt).digest('hex').slice(0, 16);
  const date = kstDate();

  if (hasRedis()) {
    await Promise.all([
      redisCmd('INCR', 'pv:total'),
      redisCmd('INCR', `pv:${date}`),
      redisCmd('PFADD', 'uv:total', id),
      redisCmd('PFADD', `uv:${date}`, id),
    ]);
  } else {
    mem.pvTotal++;
    mem.pvDaily.set(date, (mem.pvDaily.get(date) || 0) + 1);
    mem.uvTotal.add(id);
    if (!mem.uvDaily.has(date)) mem.uvDaily.set(date, new Set());
    mem.uvDaily.get(date).add(id);
  }
}

async function getStats(daysBack) {
  const days = lastNDays(daysBack);
  const today = kstDate();

  if (hasRedis()) {
    const [pvTotal, uvTotal] = await Promise.all([
      redisCmd('GET', 'pv:total'),
      redisCmd('PFCOUNT', 'uv:total'),
    ]);
    const daily = await Promise.all(days.map(async (day) => {
      const [pv, uv] = await Promise.all([redisCmd('GET', `pv:${day}`), redisCmd('PFCOUNT', `uv:${day}`)]);
      return { day, pv: Number(pv) || 0, uv: Number(uv) || 0 };
    }));
    return { today, totalPV: Number(pvTotal) || 0, totalUV: Number(uvTotal) || 0, daily, persisted: true };
  }

  const daily = days.map(day => ({
    day,
    pv: mem.pvDaily.get(day) || 0,
    uv: mem.uvDaily.has(day) ? mem.uvDaily.get(day).size : 0,
  }));
  return { today, totalPV: mem.pvTotal, totalUV: mem.uvTotal.size, daily, persisted: false };
}

function checkStatsAuth(req, res, next) {
  const user = process.env.STATS_USER || 'owner';
  const pass = process.env.STATS_PASS || 'changeme';
  const hdr = req.headers.authorization || '';
  const [scheme, encoded] = hdr.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0 && decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="stats"');
  res.status(401).send('인증이 필요합니다.');
}

function renderStatsHtml(s) {
  const rows = s.daily.map(d => {
    const isToday = d.day === s.today;
    return `<tr${isToday ? ' style="font-weight:700;background:#F4F7FA"' : ''}>
      <td>${d.day}${isToday ? ' · 오늘' : ''}</td>
      <td style="text-align:right">${d.uv.toLocaleString('ko-KR')}</td>
      <td style="text-align:right">${d.pv.toLocaleString('ko-KR')}</td>
    </tr>`;
  }).join('');
  const todayRow = s.daily.find(d => d.day === s.today) || { uv: 0, pv: 0 };
  const warn = s.persisted ? '' : `<p style="color:#B4451C;font-size:13px">
    UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN이 설정되지 않아 메모리에만 세는 중입니다.
    서버가 재시작되면(Render 무료 플랜은 15분 무접속 시 재시작) 숫자가 0으로 돌아갑니다.
  </p>`;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>방문자 통계</title>
  <style>
    body{font-family:-apple-system,"Malgun Gothic",sans-serif;background:#EDF0F4;color:#16202C;margin:0;padding:20px 16px 60px}
    .wrap{max-width:640px;margin:0 auto}
    h1{font-size:20px;margin:0 0 4px}
    .sub{color:#7B8896;font-size:13px;margin:0 0 20px}
    .big{display:flex;gap:10px;margin-bottom:20px}
    .card{flex:1;background:#fff;border:1px solid #D6DDE5;border-radius:10px;padding:14px}
    .card b{display:block;font-size:11.5px;color:#7B8896;font-weight:600;margin-bottom:6px}
    .card span{font-size:26px;font-weight:800;letter-spacing:-0.02em}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #D6DDE5;border-radius:10px;overflow:hidden}
    th,td{padding:8px 12px;font-size:13.5px;border-bottom:1px solid #E9EEF3}
    th{text-align:right;color:#7B8896;font-weight:600;font-size:12px}
    th:first-child,td:first-child{text-align:left}
    tr:last-child td{border-bottom:none}
  </style></head><body><div class="wrap">
    <h1>방문자 통계</h1>
    <p class="sub">방문자 수는 IP를 해시해 대략 세는 값이라 정확한 실인원과는 오차가 있습니다. 최근 14일 기준.</p>
    <div class="big">
      <div class="card"><b>오늘 방문자</b><span>${todayRow.uv.toLocaleString('ko-KR')}</span></div>
      <div class="card"><b>오늘 조회수</b><span>${todayRow.pv.toLocaleString('ko-KR')}</span></div>
    </div>
    <div class="big">
      <div class="card"><b>누적 방문자</b><span>${s.totalUV.toLocaleString('ko-KR')}</span></div>
      <div class="card"><b>누적 조회수</b><span>${s.totalPV.toLocaleString('ko-KR')}</span></div>
    </div>
    ${warn}
    <table>
      <thead><tr><th>날짜</th><th>방문자</th><th>조회수</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div></body></html>`;
}

app.get('/stats', checkStatsAuth, async (req, res) => {
  try {
    const s = await getStats(14);
    res.type('html').send(renderStatsHtml(s));
  } catch (e) {
    res.status(502).send('통계를 불러오지 못했습니다: ' + e.message);
  }
});

app.get('/api/stats.json', checkStatsAuth, async (req, res) => {
  try {
    res.json(await getStats(14));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`fairprice-proxy listening on ${PORT}`));

module.exports = {
  app, fromNaver, fromFnGuide, toNum, rowByLabel, recordVisit, getStats, kstDate, lastNDays,
  fetchNaverHistoryPage, fetchNaverHistory, getFundamentals, fromNaverApi, fromNaverFinance, extractLabeledSeries, collectEstimatePeriods, parseKoreanAmount, pickTotalInfo, findValueByKey, findStringByKey, searchByNaverPage,
  fetchMarketCapPage, fetchMarketCapSingle, fetchMarketCapUniverse, fetchInvestorFlow, screenOne, runScreen, percentileRanks,
  recordRecommendation, getRecommendation, listRecommendationDates, priceAsOf, computePerformance, hasRedis,
  fetchOhlcv, fetchOhlcvChartApi, fetchOhlcvHtml, fetchSectorMap, fetchSectorList, fetchSectorMembers,
  evaluateOne, computeSectorStrength, runMomentum, fetchSectorMap, fetchSectorMapFromStocks,
  fetchSectorListApi, fetchSectorMembersApi, runUsMomentum, fetchUsUniverse,
  runBacktest, buildBacktestConfig, BACKTEST_FILTERS, loadMomentumConfig, normalizeConditions,
  withRetry, fetchMarketCapPage, collectStocksFromJson, extractStocksFromText, extractStocksFromAnchors,
  // 테스트에서 캐시 상태를 리셋하기 위한 것. alsoLastGood=true면 '마지막 성공 목록'까지 지운다.
  __clearCaches(alsoLastGood) {
    cache.clear();
    histCache.clear();
    if (alsoLastGood) LAST_GOOD_UNIVERSE.clear();
  },
};
