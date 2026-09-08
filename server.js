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

const path = require('path');
const express = require('express');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { fairValue, gapPct } = require('./public/fairvalue-core.js');

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
  res.sendFile(path.join(__dirname, 'public', 'screener.html'));
});

app.use(express.static('public'));

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
  const [n, f] = await Promise.allSettled([fromNaver(code), fromFnGuide(code)]);
  const naver = n.status === 'fulfilled' ? n.value : null;
  const fn = f.status === 'fulfilled' ? f.value : null;
  if (!naver) warnings.push('네이버 금융을 읽지 못했습니다: ' + (n.reason?.message || '알 수 없음'));
  if (!fn) warnings.push('FnGuide를 읽지 못했습니다: ' + (f.reason?.message || '알 수 없음'));
  if (!naver && !fn) {
    const e = new Error('두 사이트 모두 읽지 못했습니다.');
    e.warnings = warnings;
    throw e;
  }

  // ROE 최근 3개 (과거 → 최근 순)
  let roe = (fn && fn.roeSeries) || (naver && naver.roeSeries) || [];
  roe = roe.filter(v => v != null).slice(-3);
  while (roe.length < 3) roe.unshift(null);
  if (roe.some(v => v == null)) warnings.push('최근 3년 ROE를 다 채우지 못했습니다. 빈 칸은 직접 입력하십시오.');

  let equityEok = fn ? fn.equityEok : null;
  let equityNote = 'FnGuide 지배주주지분 (최근 연간)';
  if (equityEok == null && naver && naver.bps && naver.shares) {
    equityEok = (naver.bps * naver.shares) / 1e8;   // 원 → 억원
    equityNote = 'BPS × 상장주식수로 추정한 값 (확인 필요)';
    warnings.push('지배주주지분을 직접 읽지 못해 BPS × 상장주식수로 추정했습니다. FnGuide에서 실제 값을 확인하십시오.');
  }
  if (fn && fn.equityIsConsolidatedTotal) {
    warnings.push('지배주주지분 항목이 없어 자본총계를 사용했습니다. 비지배지분이 크면 값이 달라집니다.');
  }

  const shares = (fn && fn.shares) || (naver && naver.shares) || null;
  const treasury = (fn && fn.treasury != null) ? fn.treasury : null;
  if (treasury == null) warnings.push('자사주 수를 읽지 못했습니다. 0으로 두거나 DART에서 확인해 직접 넣으십시오.');
  if (!shares) warnings.push('발행주식수를 읽지 못했습니다. 직접 입력하십시오.');

  const payload = {
    code,
    name: (naver && naver.name) || (fn && fn.name) || null,
    price: naver ? naver.price : null,
    equityEok: equityEok != null ? Math.round(equityEok) : null,
    equityNote,
    roe,                       // [3년 전, 2년 전, 전년도] 단위 %
    shares,
    treasury: treasury ?? 0,
    warnings,
    sources: {
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

async function fetchMarketCapPage(page, sosok) {
  sosok = sosok === 1 ? 1 : 0; // 0=코스피, 1=코스닥
  const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/item/main.naver?code="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/code=(\d{6})/);
    if (!m) return;
    const code = m[1];
    if (seen.has(code)) return;
    const name = $(a).text().replace(/\s+/g, ' ').trim();
    if (!name) return;
    seen.add(code);
    out.push({ code, name });
  });
  return out;
}

// 단일 시장(코스피 또는 코스닥) 안에서 시가총액 상위 n개를 모은다.
async function fetchMarketCapSingle(n, sosok) {
  const marketName = sosok === 1 ? 'kosdaq' : 'kospi';
  const cacheKey = 'universe:' + marketName + ':' + n;
  const cached = histCacheGet(cacheKey); // 하루 단위로 바뀌어도 무방 — 12시간 캐시 재사용
  if (cached) return cached;

  const perPage = 50;
  const pages = Math.ceil(n / perPage);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => fetchMarketCapPage(i + 1, sosok).catch(() => []))
  );
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
  histCacheSet(cacheKey, out);
  return out;
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
    const [kospi, kosdaq] = await Promise.all([
      fetchMarketCapSingle(half, 0),
      fetchMarketCapSingle(half, 1),
    ]);
    return [...kospi, ...kosdaq].slice(0, n);
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
    if (!fund.price || !fund.equityEok || !fund.shares || fund.roe.some(v => v == null)) {
      return { code: item.code, name: item.name, skipped: '데이터 부족' };
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
    throw new Error('시가총액 순위를 가져오지 못했습니다. 잠시 후 다시 시도하거나 /api/universe-raw로 원본을 확인하십시오.');
  }
  const results = [];
  for (let i = 0; i < universe.length; i += SCREEN_BATCH) {
    const batch = universe.slice(i, i + SCREEN_BATCH);
    const r = await Promise.all(batch.map(item => screenOne(item, opt)));
    results.push(...r);
  }

  const scored = results.filter(r => !r.skipped);
  const skippedCount = results.length - scored.length;

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
  const pool = scored.filter(r =>
    r.undervalued &&
    r.gapPct <= -opt.minGapPct &&
    r.flowDataAvailable &&
    r.flowStrength >= opt.minFlowStrength &&
    r.volumeRatio >= opt.minVolumeRatio
  );

  const pGap = percentileRanks(pool.map(r => -r.gapPct));      // 클수록 더 저평가
  const pFlow = percentileRanks(pool.map(r => r.flowStrength));
  const pVol = percentileRanks(pool.map(r => r.volumeRatio));
  pool.forEach((r, i) => {
    r.score = opt.weightGap * pGap[i] + opt.weightFlow * pFlow[i] + opt.weightVolume * pVol[i];
    r.score = Math.round(r.score * 1000) / 1000;
  });
  pool.sort((a, b) => b.score - a.score); // 점수 높은 순

  const out = {
    date: today,
    universeSize: universe.length,
    consideredCount: scored.length,
    skippedCount,
    passedCount: pool.length,
    funnel,
    candidates: pool.slice(0, 3),
    runnerUps: pool.slice(3, 13), // 참고용으로 좀 더 보여줌
    opt,
  };
  histCacheSet(cacheKey, out);
  return out;
}

/* ───────────────────────── 디버그 ───────────────────────── */

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

app.get('/api/universe-raw', async (req, res) => {
  const page = Number(req.query.page) || 1;
  const sosok = req.query.market === 'KOSDAQ' ? 1 : 0;
  try {
    const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
    res.type('text/plain').send(await fetchHtml(url));
  } catch (e) {
    res.status(502).send(e.message);
  }
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

app.get('/api/health', (_, res) => res.json({ ok: true, cache: cache.size, at: new Date().toISOString() }));

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

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOOT_SALT = crypto.randomBytes(16).toString('hex'); // VISIT_SALT 미설정 시 임시로 씀 (재시작마다 바뀜)

async function redisCmd(...args) {
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const r = await fetch(`${UPSTASH_URL}/${path}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const j = await r.json();
  return j.result;
}
function hasRedis() { return !!(UPSTASH_URL && UPSTASH_TOKEN); }

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
  fetchNaverHistoryPage, fetchNaverHistory, getFundamentals, searchByNaverPage,
  fetchMarketCapPage, fetchMarketCapSingle, fetchMarketCapUniverse, fetchInvestorFlow, screenOne, runScreen, percentileRanks,
};