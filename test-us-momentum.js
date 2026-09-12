/**
 * 미국장 스크리너 검증.
 *
 * 핵심 관심사는 "거래대금 상위로 뽑으면 작전주가 들어오지 않는가"이다.
 * 나스닥 스크리너가 주는 거래량은 당일 값이라, 그것만 보면 하루 띄운 종목이
 * 1등으로 올라온다. 그래서 후보군만 그걸로 넓게 잡고 실제 20일 평균 거래대금은
 * 일봉에서 직접 계산해 거르는 2단 구조로 만들었다 — 그게 실제로 먹히는지 본다.
 */
process.env.PORT = '39988';
process.env.MOMENTUM_CONDITIONS = JSON.stringify({
  label: '테스트 조건',
  conditions: [
    { key: 'X', desc: 'CCI 돌파', indicator: 'cci', params: { n: 20 }, type: 'crossUp', level: 100 },
    { key: 'Y', desc: 'MACD Osc 상승', indicator: 'macdOsc', params: { fast: 12, slow: 26, signal: 9 }, type: 'rising', bars: 1 },
    { key: 'Z', desc: '거래량 급증', indicator: 'volumeRatio', params: { n: 20 }, type: 'above', level: 1.5 },
  ],
});

const US = require('./us-market.js');

/* ── 종목 정의 ───────────────────────────────────────────────
 * PUMP  : 당일 거래대금은 1위인데 20일 평균은 바닥 — 딱 하루 띄운 모양
 * BIGCO : 시총·거래대금 모두 꾸준한 대형주
 * MIDCO : 중형주, 꾸준한 거래대금
 * PENNY : 주가 $2 — 주가 하한에 걸려야 함
 * TINY  : 시총 $1억 — 시총 하한에 걸려야 함
 * WARR  : 워런트 — 비주식으로 걸러져야 함
 * NEWCO : 올해 상장 — 상장기간 필터에 걸려야 함
 */
const SPEC = {
  PUMP:  { name: 'Pump Technologies Inc', price: 12, capM: 800, dayVol: 90e6, avgVolShares: 20000, kind: 'breakout', sector: 'Technology', ipo: 2015 },
  BIGCO: { name: 'Big Company Inc', price: 200, capM: 500000, dayVol: 5e6, avgVolShares: 4000000, kind: 'breakout', sector: 'Technology', ipo: 1990 },
  MIDCO: { name: 'Mid Industrials Corp', price: 60, capM: 8000, dayVol: 2e6, avgVolShares: 1500000, kind: 'drift', sector: 'Industrials', ipo: 2005 },
  MID2:  { name: 'Second Industrials Corp', price: 40, capM: 6000, dayVol: 1.5e6, avgVolShares: 1200000, kind: 'drift', sector: 'Industrials', ipo: 2006 },
  MID3:  { name: 'Third Tech Corp', price: 90, capM: 9000, dayVol: 1.8e6, avgVolShares: 1000000, kind: 'flat', sector: 'Technology', ipo: 2008 },
  PENNY: { name: 'Penny Stock Co', price: 2, capM: 900, dayVol: 50e6, avgVolShares: 3000000, kind: 'breakout', sector: 'Technology', ipo: 2010 },
  TINY:  { name: 'Tiny Cap Inc', price: 8, capM: 100, dayVol: 40e6, avgVolShares: 2000000, kind: 'breakout', sector: 'Technology', ipo: 2010 },
  NEWCO: { name: 'Newly Listed Inc', price: 30, capM: 3000, dayVol: 10e6, avgVolShares: 900000, kind: 'breakout', sector: 'Technology', ipo: new Date().getFullYear() },
};
const NON_ORDINARY = [
  { symbol: 'WARR.W', name: 'Something Acquisition Warrant', lastsale: '$1.20', marketCap: '900000000', volume: '1000000', sector: 'Finance' },
  { symbol: 'UNIT.U', name: 'Something Acquisition Unit', lastsale: '$10.10', marketCap: '900000000', volume: '1000000', sector: 'Finance' },
  { symbol: 'PFD.P', name: 'Bank Preferred Series A', lastsale: '$25.00', marketCap: '900000000', volume: '900000', sector: 'Finance' },
];

function screenerJson() {
  const rows = Object.entries(SPEC).map(([sym, s]) => ({
    symbol: sym, name: s.name,
    lastsale: '$' + s.price.toFixed(2),
    netchange: '1.00', pctchange: '1.00%',
    marketCap: String(s.capM * 1e6),
    country: 'United States', ipoyear: String(s.ipo),
    volume: String(Math.round(s.dayVol / s.price)),
    sector: s.sector, industry: s.sector + ' Equipment',
    url: '/market-activity/stocks/' + sym.toLowerCase(),
  }));
  return { data: { rows: rows.concat(NON_ORDINARY) }, message: null, status: { rCode: 200 } };
}

/** 일봉 생성. avgVolShares가 평소 거래량이고, 돌파일에만 5배가 실린다. */
function makeBars(spec) {
  const n = 140, PULLBACK = 133;
  const bars = [];
  const t0 = Math.floor(new Date('2026-01-02T21:00:00Z').getTime() / 1000);
  for (let i = 0; i < n; i++) {
    let c, v = spec.avgVolShares;
    if (spec.kind === 'breakout') {
      const peak = spec.price * Math.pow(1.002, PULLBACK - 1) / 1.14 / Math.pow(0.98, 6);
      if (i < PULLBACK) c = (spec.price / Math.pow(1.14, 1)) * Math.pow(1.002, i - PULLBACK + 1) * Math.pow(0.98, -6);
      else if (i < n - 1) c = spec.price / 1.14 * Math.pow(0.98, i - PULLBACK + 1 - 6);
      else { c = spec.price; v = spec.avgVolShares * 5; }
      if (!isFinite(c) || c <= 0) c = spec.price;
      void peak;
    } else if (spec.kind === 'drift') {
      c = spec.price * Math.pow(0.999, n - 1 - i);
    } else {
      c = spec.price;
    }
    bars.push({ t: t0 + i * 86400, o: c, h: c * 1.01, l: c * 0.99, c, v });
  }
  return bars;
}

function yahooJson(symbol) {
  const spec = SPEC[symbol];
  const bars = makeBars(spec);
  return {
    chart: {
      result: [{
        meta: { symbol, currency: 'USD' },
        timestamp: bars.map(b => b.t),
        indicators: {
          quote: [{
            open: bars.map(b => b.o), high: bars.map(b => b.h),
            low: bars.map(b => b.l), close: bars.map(b => b.c), volume: bars.map(b => b.v),
          }],
        },
      }],
      error: null,
    },
  };
}

let yahooAlive = true;
let calls = { screener: 0, yahoo: 0, stooq: 0 };

global.fetch = async (url) => {
  const u = String(url);
  const send = (o) => {
    const t = typeof o === 'string' ? o : JSON.stringify(o);
    return { ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') };
  };

  if (u.includes('api.nasdaq.com/api/screener')) { calls.screener++; return send(screenerJson()); }
  if (u.includes('query1.finance.yahoo.com')) {
    calls.yahoo++;
    if (!yahooAlive) return { ok: false, status: 429, text: async () => 'Too Many Requests' };
    const sym = decodeURIComponent(u.split('/chart/')[1].split('?')[0]);
    if (!SPEC[sym]) return send({ chart: { result: null, error: { description: 'No data found' } } });
    return send(yahooJson(sym));
  }
  if (u.includes('stooq.com')) {
    calls.stooq++;
    const sym = (u.match(/s=([a-z.]+)\.us/) || [])[1].toUpperCase();
    const bars = makeBars(SPEC[sym]);
    const lines = ['Date,Open,High,Low,Close,Volume'].concat(bars.map(b =>
      [new Date(b.t * 1000).toISOString().slice(0, 10), b.o.toFixed(2), b.h.toFixed(2), b.l.toFixed(2), b.c.toFixed(2), b.v].join(',')));
    return send(lines.join('\n'));
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('\n[1] 비주식 종목 걸러내기');
  check('워런트 제외', !US.isOrdinaryShare({ symbol: 'WARR.W', name: 'X Warrant' }));
  check('유닛 제외', !US.isOrdinaryShare({ symbol: 'UNIT.U', name: 'X Unit' }));
  check('우선주 제외', !US.isOrdinaryShare({ symbol: 'PFD.P', name: 'Bank Preferred' }));
  check('보통주는 통과', US.isOrdinaryShare({ symbol: 'AAPL', name: 'Apple Inc' }));
  check('BRK/B 표기를 야후식으로', US.toYahooSymbol('BRK/B') === 'BRK-B');

  console.log('\n[2] 사전 필터 — 작전주가 잘 걸리는 값들');
  const rows = screenerJson().data.rows;
  const built = US.buildUsUniverse(rows, { mode: 'turnover', minPrice: 5, minMarketCapM: 500 });
  const syms = built.list.map(x => x.code);
  check('$5 미만 페니스톡 제외', !syms.includes('PENNY'), syms);
  check('시총 $5억 미만 제외', !syms.includes('TINY'), syms);
  check('워런트·유닛·우선주 제외', !syms.some(s => /WARR|UNIT|PFD/.test(s)), syms);
  check('제외 사유가 집계됨',
    built.rejected.price === 1 && built.rejected.marketCap === 1 && built.rejected.nonOrdinary === 3, built.rejected);

  console.log('\n[3] 정렬 방식 전환');
  const byCap = US.buildUsUniverse(rows, { mode: 'marketCap', minPrice: 5, minMarketCapM: 500 });
  check('시총 모드는 대형주가 1등', byCap.list[0].code === 'BIGCO', byCap.list.map(x => x.code));
  check('거래대금 모드는 당일 거래대금 1등이 앞',
    built.list[0].code === 'PUMP', built.list.map(x => x.code));
  console.log('  → 당일 거래대금만 보면 PUMP가 1등이다. 여기서 끝내면 안 되는 이유가 이것.');

  console.log('\n[4] 야후 일봉');
  const got = await US.fetchUsBars('BIGCO');
  check('일봉 140개', got.bars.length === 140, got.bars.length);
  check('출처는 야후', got.source === 'yahoo', got.source);
  check('OHLCV가 채워짐', got.bars.every(b => b.high >= b.low && b.close > 0 && b.volume > 0));
  check('날짜 오름차순', got.bars[0].date < got.bars[139].date);

  console.log('\n[5] 야후가 429면 Stooq로 넘어간다');
  yahooAlive = false; calls = { screener: 0, yahoo: 0, stooq: 0 };
  const fb = await US.fetchUsBars('BIGCO');
  check('Stooq에서 일봉 확보', fb.bars.length >= 60 && fb.source === 'stooq', { n: fb.bars.length, s: fb.source });
  check('야후를 먼저 시도했음', calls.yahoo > 0, calls);
  check('실패 사유를 남김', /429/.test(fb.note || ''), fb.note);
  yahooAlive = true;

  console.log('\n[6] 거래대금 모드 전체 스캔 — 20일 평균으로 작전주가 걸러지는가');
  S.__clearCaches(true);
  const r = await S.runUsMomentum({
    mode: 'turnover', universeN: 10, poolMultiplier: 2, barsAgo: 0,
    minPrice: 5, minMarketCapM: 500, minTurnoverM: 20, minListedYears: 1,
    minPassCount: 2, topN: 6, keywords: [],
    weightCond: 0.4, weightSector: 0.3, weightVolume: 0.1, weightKeyword: 0.2,
  });
  console.log('  funnel:', JSON.stringify(r.funnel));
  console.log('  후보:', JSON.stringify(r.candidates.map(c => ({
    s: c.code, pass: c.passCount + '/' + c.condCount, avg$M: c.avgTurnoverM, score: c.score,
  }))));

  const picked = r.candidates.map(c => c.code);
  check('PUMP는 20일 평균 거래대금 미달로 탈락', !picked.includes('PUMP'), picked);
  check('꾸준한 대형주는 남음', picked.includes('BIGCO'), picked);
  check('신규 상장(NEWCO) 제외', !picked.includes('NEWCO'), picked);
  check('유동성 필터가 실제로 종목을 걸렀다',
    r.funnel.liquidityPassed < r.funnel.evaluated, r.funnel);
  check('후보의 20일 평균 거래대금이 모두 기준 이상',
    r.candidates.every(c => c.avgTurnoverM == null || c.avgTurnoverM >= 20),
    r.candidates.map(c => c.avgTurnoverM));

  console.log('\n[7] 시총 모드로 전환해도 동작');
  S.__clearCaches(true);
  const r2 = await S.runUsMomentum({
    mode: 'marketCap', universeN: 10, poolMultiplier: 2, barsAgo: 0,
    minPrice: 5, minMarketCapM: 500, minTurnoverM: 20, minListedYears: 1,
    minPassCount: 2, topN: 6, keywords: [],
    weightCond: 0.4, weightSector: 0.3, weightVolume: 0.1, weightKeyword: 0.2,
  });
  check('모드가 결과에 기록됨', r2.universeMode === 'marketCap', r2.universeMode);
  check('시총 모드에서도 후보가 나옴', r2.candidates.length > 0, r2.candidates.map(c => c.code));
  check('섹터 강도가 붙음', r2.candidates.every(c => typeof c.sectorStrength === 'number'));
  check('시장 국면이 계산됨',
    ['strong', 'neutral', 'weak'].includes(r2.marketRead.regime), r2.marketRead);

  console.log('\n[8] 테마 키워드는 영문 기준으로 걸린다');
  S.__clearCaches(true);
  const r3 = await S.runUsMomentum({
    mode: 'marketCap', universeN: 10, poolMultiplier: 2, barsAgo: 0,
    minPrice: 5, minMarketCapM: 500, minTurnoverM: 20, minListedYears: 1,
    minPassCount: 1, topN: 6, keywords: ['industrials'],
    weightCond: 0.2, weightSector: 0.1, weightVolume: 0.1, weightKeyword: 0.6,
  });
  check('섹터명 대소문자 무시하고 매칭',
    r3.candidates.some(c => c.keywordHit && /Industrials/i.test(c.sector || '')),
    r3.candidates.map(c => ({ s: c.code, sec: c.sector, hit: c.keywordHit })));

  console.log('\n[9] 유니버스 사전 필터 통계가 응답에 담긴다');
  check('제외 사유가 응답에 포함', r.funnel.prefilterRejected != null, r.funnel.prefilterRejected);
  check('받아온 종목 수가 유니버스보다 작거나 같음',
    r.fetchedCount <= r.universeSize, { f: r.fetchedCount, u: r.universeSize });


console.log('\n[10] 네이버 해외 일봉 (야후·Stooq가 동시에 막혔을 때의 세 번째 경로)');
{
  const rows = [];
  for (let i = 0; i < 80; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    rows.push({
      localDate: d.toISOString().slice(0, 10).replace(/-/g, ''),
      openPrice: 100 + i, highPrice: 101 + i, lowPrice: 99 + i, closePrice: 100 + i,
      accumulatedTradingVolume: 12345,
    });
  }
  const saved = global.fetch;
  let tried = [];
  global.fetch = async (url) => {
    const u = String(url);
    tried.push(u);
    const t = JSON.stringify(u.includes('.O/') ? [] : rows);   // .O는 빈 응답, .N에서 성공
    return { ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') };
  };
  const r = await US.fetchNaverForeignBars('AAPL');
  check('접미사 후보를 순서대로 시도', tried.length >= 2, tried.length);
  check('두 번째 후보(.N)에서 성공', r.naverSymbol === 'AAPL.N', r.naverSymbol);
  check('80봉 파싱', r.bars.length === 80, r.bars.length);
  check('OHLCV가 채워짐', r.bars.every(b => b.high >= b.low && b.close > 0 && b.volume > 0));
  check('날짜가 YYYY-MM-DD로 정규화', /^\d{4}-\d{2}-\d{2}$/.test(r.bars[0].date), r.bars[0].date);
  check('오름차순 정렬', r.bars[0].date < r.bars[79].date);
  global.fetch = saved;
}

console.log('\n[11] 세 경로가 모두 막히면 사유를 전부 담아 던진다');
{
  const saved = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden', arrayBuffer: async () => Buffer.alloc(0) });
  let msg = null;
  try { await US.fetchUsBars('AAPL'); } catch (e) { msg = e.message; }
  check('야후 사유가 남는다', /yahoo/.test(msg || ''), msg);
  check('네이버 사유가 남는다', /naver/.test(msg || ''), msg);
  check('Stooq 사유가 남는다', /stooq/.test(msg || ''), msg);
  global.fetch = saved;
}

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
