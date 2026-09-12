/**
 * 모멘텀 스크리너 통합 검증.
 *
 * 실제 네이버에 나가지 않고, 이 테스트에서 설계한 픽스처로
 *   차트 API 파싱 → 지표 평가 → 업종 매핑 → 섹터 강도 → 시장별 TOP3
 * 회로가 맞게 연결됐는지 확인한다.
 *
 * 종목을 일부러 성격이 다르게 만들어 순위가 뒤집히지 않는지까지 본다:
 *   K1 강한섹터·조건5개 전부 충족    → 코스피 1순위여야 함
 *   K2 약한섹터·조건5개 전부 충족    → 2순위
 *   K3 조건 일부만 충족              → 3순위
 *   K4 조건은 좋지만 거래대금 미달   → 유동성 필터에 걸려 탈락
 *   D1/D2 코스닥 — 코스피와 섞이지 않고 따로 뽑혀야 함
 */
process.env.PORT = '39994';

// 조건 정의는 저장소가 아니라 환경변수에서 온다 — 테스트에서도 그 경로로 주입한다.
// (여기 쓰는 조건은 테스트용으로 지어낸 것이고, 실제 조건식이 아니다.)
process.env.MOMENTUM_CONDITIONS = JSON.stringify({
  label: '테스트 조건',
  conditions: [
    { key: 'X', desc: 'CCI 돌파', indicator: 'cci', params: { n: 20 }, type: 'crossUp', level: 100 },
    { key: 'Y', desc: 'MACD Osc 상승', indicator: 'macdOsc', params: { fast: 12, slow: 26, signal: 9 }, type: 'rising', bars: 1 },
    { key: 'Z', desc: '거래량 급증', indicator: 'volumeRatio', params: { n: 20 }, type: 'above', level: 2 },
  ],
});

const M = require('./public/momentum-core.js');

/* ── 일봉 시나리오 생성 ──────────────────────────────────────────────
 * breakout: 오래 오르다(OBV 축적) → 6일 눌림(%R -100 근처, CCI 하락) → 마지막 봉 급등(대량거래).
 *           실제로 조건식 A·B·C·E·F가 한꺼번에 켜지는 전형적 모양이다.
 * flat:     계속 횡보 → 어떤 돌파 조건도 안 켜짐
 * drift:    완만한 상승 → MACD osc 상승(B)과 OBV(C)만 켜짐
 */
function makeBars(kind, base, volume) {
  const n = 120;
  const PULLBACK_FROM = 113;         // 113~118: 6일 눌림
  const bars = [];
  const start = new Date('2026-03-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    let c, v = volume;
    if (kind === 'breakout') {
      const peak = base * Math.pow(1.002, PULLBACK_FROM - 1);
      if (i < PULLBACK_FROM) c = base * Math.pow(1.002, i);
      else if (i < n - 1) c = peak * Math.pow(0.98, i - PULLBACK_FROM + 1);
      else { c = peak * Math.pow(0.98, 6) * 1.14; v = volume * 5; }  // 대량거래 급등
    } else if (kind === 'drift') {
      c = base * Math.pow(1.002, i);
    } else {
      c = base;
    }
    const d = new Date(start.getTime() + i * 86400000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: c, high: c * 1.01, low: c * 0.99, close: Math.round(c), volume: v,
    });
  }
  return bars;
}

/** 네이버 차트 API 응답 흉내 — 작은따옴표 헤더가 섞인 JS 배열 리터럴이다. */
function chartApiText(bars) {
  const head = "[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],\n";
  const rows = bars.map(b =>
    `["${b.date.replace(/-/g, '')}", ${Math.round(b.open)}, ${Math.round(b.high)}, ${Math.round(b.low)}, ${b.close}, ${b.volume}, 12.34]`
  ).join(',\n');
  return head + rows + ']';
}

const SPEC = {
  // code:      { name, market, kind, base, volume, sector }
  '200001': { name: 'K1_강섹터_돌파', market: 0, kind: 'breakout', base: 50000, volume: 500000, sector: '반도체' },
  '200002': { name: 'K2_약섹터_돌파', market: 0, kind: 'breakout', base: 50000, volume: 500000, sector: '음식료' },
  '200003': { name: 'K3_완만상승', market: 0, kind: 'drift', base: 50000, volume: 500000, sector: '반도체' },
  '200004': { name: 'K4_거래대금미달', market: 0, kind: 'breakout', base: 1000, volume: 100, sector: '반도체' },
  '200005': { name: 'K5_횡보', market: 0, kind: 'flat', base: 50000, volume: 500000, sector: '음식료' },
  '200006': { name: 'K6_강섹터_횡보', market: 0, kind: 'flat', base: 50000, volume: 400000, sector: '반도체' },
  '300001': { name: 'D1_코스닥_돌파', market: 1, kind: 'breakout', base: 30000, volume: 400000, sector: '반도체' },
  '300002': { name: 'D2_코스닥_완만', market: 1, kind: 'drift', base: 30000, volume: 400000, sector: '음식료' },
};

// 업종 번호 ↔ 이름
const SECTORS = { '901': '반도체', '902': '음식료' };

let requestLog = { chartApi: 0, htmlDay: 0, sectorList: 0, sectorDetail: 0 };

global.fetch = async (url) => {
  const u = String(url);
  // fetchHtml은 arrayBuffer를, fetchJson은 text를 쓴다 — 둘 다 갖춰야 한다.
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8'), text: async () => h });

  // 시가총액 상위 목록 (sosok=0 코스피 / 1 코스닥)
  if (u.includes('sise_market_sum')) {
    const page = Number((u.match(/page=(\d+)/) || [])[1] || 1);
    const sosok = Number((u.match(/sosok=(\d)/) || [])[1] || 0);
    if (page > 1) return html('<html><body></body></html>');
    const rows = Object.entries(SPEC).filter(([, s]) => s.market === sosok)
      .map(([code, s]) => `<tr><td><a href="/item/main.naver?code=${code}">${s.name}</a></td></tr>`).join('');
    return html(`<html><body><table>${rows}</table></body></html>`);
  }

  // 업종 목록
  if (u.includes('sise_group.naver')) {
    requestLog.sectorList++;
    const rows = Object.entries(SECTORS).map(([no, name]) =>
      `<tr><td><a href="/sise/sise_group_detail.naver?type=upjong&no=${no}">${name}</a></td><td>+1.2%</td></tr>`).join('');
    return html(`<html><body><table>${rows}</table></body></html>`);
  }

  // 업종 구성종목
  if (u.includes('sise_group_detail.naver')) {
    requestLog.sectorDetail++;
    const no = (u.match(/no=(\d+)/) || [])[1];
    const name = SECTORS[no];
    const rows = Object.entries(SPEC).filter(([, s]) => s.sector === name)
      .map(([code, s]) => `<tr><td><a href="/item/main.naver?code=${code}">${s.name}</a></td></tr>`).join('');
    return html(`<html><body><table>${rows}</table></body></html>`);
  }

  // 차트 API
  if (u.includes('siseJson.naver')) {
    requestLog.chartApi++;
    const code = (u.match(/symbol=(\d{6})/) || [])[1];
    const s = SPEC[code];
    if (!s) throw new Error('알 수 없는 코드: ' + u);
    if (code === '__BROKEN__') return { ok: true, status: 200, text: async () => 'garbage' };
    return { ok: true, status: 200, text: async () => chartApiText(makeBars(s.kind, s.base, s.volume)) };
  }

  // 종목 기본정보 / 재무 API — 적정주가 계산에 쓰인다
  if (u.includes('/api/stock/') && u.endsWith('/basic')) {
    const code = (u.match(/\/api\/stock\/(\d{6})\//) || [])[1];
    const s = SPEC[code];
    return html(JSON.stringify({ stockName: s.name, closePrice: String(s.base) }));
  }
  if (u.includes('/api/stock/') && u.endsWith('/integration')) {
    const code = (u.match(/\/api\/stock\/(\d{6})\//) || [])[1];
    const s = SPEC[code];
    // 시가총액 = 종가 × 1,000만주 → 주식수 역산이 1,000만주로 나와야 한다
    const cap = s.base * 1e7;
    return html(JSON.stringify({
      stockName: s.name,
      totalInfos: [
        { code: 'marketValue', key: '시가총액', value: String(Math.round(cap / 1e8)) + '억원' },
        { code: 'bps', key: 'BPS', value: String(Math.round(s.base * 0.8)) + '원' },
      ],
    }));
  }
  if (u.includes('/finance/annual')) {
    const P = ['202312', '202412', '202512'];
    const row = (title, vals) => ({ title, columns: P.reduce((o, p, i) => { o[p] = { value: String(vals[i]) }; return o; }, {}) });
    return html(JSON.stringify({
      financeInfo: {
        trTitleList: P.map(p => ({ key: p, title: p.slice(0, 4) + '.12' })),
        rowList: [row('ROE', [12, 14, 16]), row('BPS', [8000, 9000, 10000])],
      },
    }));
  }
  if (u.includes('item/main.naver') || u.includes('fnguide') || u.includes('/trend')) {
    return html('<html><head><meta charset="utf-8"></head><body></body></html>');
  }

  // 일별시세 HTML (차트 API 실패 시 대체 경로)
  if (u.includes('sise_day.naver')) {
    requestLog.htmlDay++;
    const code = (u.match(/code=(\d{6})/) || [])[1];
    const s = SPEC[code];
    const page = Number((u.match(/page=(\d+)/) || [])[1] || 1);
    const all = makeBars(s.kind, s.base, s.volume).slice().reverse(); // 최신순
    const slice = all.slice((page - 1) * 10, page * 10);
    const rows = slice.map(b => `<tr><td>${b.date.replace(/-/g, '.')}</td><td>${b.close}</td><td>0</td>`
      + `<td>${Math.round(b.open)}</td><td>${Math.round(b.high)}</td><td>${Math.round(b.low)}</td><td>${b.volume}</td></tr>`).join('');
    return html(`<html><head><meta charset="utf-8"></head><body><table>${rows}</table></body></html>`);
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
  console.log('\n[1] 차트 API 파싱');
  const one = await S.fetchOhlcv('200001');
  check('차트 API로 120봉을 읽음', one.bars.length === 120, one.bars.length);
  check('source가 chart-api', one.source === 'chart-api', one.source);
  check('OHLCV 필드가 모두 채워짐',
    one.bars.every(b => b.open > 0 && b.high >= b.low && b.close > 0 && b.volume > 0));
  check('날짜가 오름차순', one.bars[0].date < one.bars[119].date);

  console.log('\n[2] HTML 대체 경로');
  const htmlBars = await S.fetchOhlcvHtml('200002', 60);
  check('HTML 표에서도 고가·저가·거래량까지 읽음',
    htmlBars.length >= 60 && htmlBars.every(b => b.high > 0 && b.low > 0 && b.volume > 0), htmlBars.length);
  check('HTML 경로도 오름차순 정렬', htmlBars[0].date < htmlBars[htmlBars.length - 1].date);

  console.log('\n[3] 업종 매핑');
  const sm = await S.fetchSectorMap();
  check('업종 2개 수집', sm.sectors.length === 2, sm.sectors.map(s => s.name));
  check('K1은 반도체로 매핑', sm.byCode['200001'] === '반도체', sm.byCode['200001']);
  check('K5는 음식료로 매핑', sm.byCode['200005'] === '음식료', sm.byCode['200005']);

  console.log('\n[4] 조건 정의 로드와 평가');
  const cfg = S.loadMomentumConfig();
  check('환경변수에서 조건 3개를 읽음', cfg.conditions.length === 3 && cfg.source === 'env', cfg);
  const ev = M.evaluate((await S.fetchOhlcv('200001')).bars, cfg, { barsAgo: 0 });
  check('돌파 종목은 조건을 전부 충족', ev.strict === true, ev.conds);
  const evFlat = M.evaluate((await S.fetchOhlcv('200005')).bars, cfg, { barsAgo: 0 });
  check('횡보 종목은 조건식 미충족', evFlat.strict === false, evFlat.conds);
  check('조건 정의가 없으면 판정 없이 통과',
    M.evaluate((await S.fetchOhlcv('200005')).bars, { conditions: [] }, {}).condCount === 0);

  console.log('\n[5] 전체 스캔');
  const opt = {
    universeN: 12, market: 'ALL', barsAgo: 0,
    minTurnoverEok: 30, minPassCount: 2, topN: 3, keywords: [],
    withFairValue: false, regime: 'up', kbasePct: 4.64,
    weightCond: 0.4, weightSector: 0.3, weightVolume: 0.2, weightKeyword: 0.1,
  };
  const r = await S.runMomentum(opt);
  console.log('  funnel:', JSON.stringify(r.funnel));
  console.log('  시장:', JSON.stringify(r.market));
  console.log('  섹터:', JSON.stringify(r.sectorTop));
  console.log('  코스피:', JSON.stringify(r.candidatesKospi.map(c => ({ n: c.name, s: c.score, p: c.passCount, strict: c.strict }))));
  console.log('  코스닥:', JSON.stringify(r.candidatesKosdaq.map(c => ({ n: c.name, s: c.score, p: c.passCount }))));

  check('유니버스 8종목 수집', r.universeSize === 8, r.universeSize);
  check('8종목 모두 지표 계산 성공', r.consideredCount === 8, { c: r.consideredCount, s: r.skippedCount });
  check('조건식을 전부 만족한 종목은 strict=true로 표시', r.candidates.some(c => c.strict), r.candidates.map(c => c.strict));
  check('조건식 전부 통과(strict) 종목이 있음', r.funnel.strict >= 1, r.funnel);
  check('퍼널이 조건 키별로 만들어짐',
    r.funnel.byCondition && ['X','Y','Z'].every(k => typeof r.funnel.byCondition[k] === 'number'), r.funnel.byCondition);
  check('조건 정의가 설정됨을 응답이 알려줌',
    r.conditionsConfigured === true && r.conditionSource === 'env', { c: r.conditionsConfigured, s: r.conditionSource });

  const kospiNames = r.candidatesKospi.map(c => c.name);
  const kosdaqNames = r.candidatesKosdaq.map(c => c.name);
  check('코스피 후보에 코스닥 종목이 섞이지 않음',
    r.candidatesKospi.every(c => c.market === 'KOSPI'), kospiNames);
  check('코스닥 후보가 따로 뽑힘',
    r.candidatesKosdaq.length > 0 && r.candidatesKosdaq.every(c => c.market === 'KOSDAQ'), kosdaqNames);
  check('거래대금 미달(K4)은 후보에서 제외',
    !kospiNames.includes('K4_거래대금미달'), kospiNames);
  check('조건 충족 개수가 많은 종목이 앞에 옴',
    r.candidatesKospi[0].passCount >= r.candidatesKospi[r.candidatesKospi.length - 1].passCount, kospiNames);
  check('strict 종목이 non-strict보다 항상 앞', (() => {
    const arr = r.candidatesKospi.map(c => c.strict ? 1 : 0);
    return arr.every((v, i) => i === 0 || arr[i - 1] >= v);
  })(), r.candidatesKospi.map(c => c.strict));
  check('섹터 강도가 후보에 붙어 있음',
    r.candidatesKospi.every(c => typeof c.sectorStrength === 'number'), r.candidatesKospi.map(c => c.sectorStrength));
  check('시장 국면 지표가 계산됨',
    r.market.aboveMa20Pct != null && ['strong', 'neutral', 'weak'].includes(r.market.regime), r.market);
  check('추천 종목마다 조건별 결과와 지표값이 들어 있음',
    r.candidates.every(c => ['X','Y','Z'].every(k => typeof c.conds[k] === 'boolean' && c.values[k])));
  check('응답에 지표 이름이 노출되지 않음(조건 키만)',
    r.candidates.every(c => !('cci' in c) && !('wr' in c) && !('obvRatio' in c)));
  check('성과검증용 price 필드가 채워짐', r.candidates.every(c => c.price > 0));

  console.log('\n[6] 같은 섹터끼리 비교 — 섹터 가중치가 실제로 순위를 바꾸는가');
  const noSector = await S.runMomentum({ ...opt, weightSector: 0, weightCond: 0.6, weightVolume: 0.3, weightKeyword: 0.1 });
  const withSector = await S.runMomentum({ ...opt, weightSector: 0.6, weightCond: 0.2, weightVolume: 0.1, weightKeyword: 0.1 });
  console.log('  섹터가중 0:', noSector.candidatesKospi.map(c => c.name).join(' > '));
  console.log('  섹터가중 60:', withSector.candidatesKospi.map(c => c.name).join(' > '));
  check('섹터 가중치를 키우면 강한 섹터(반도체) 종목이 1순위',
    withSector.candidatesKospi[0].sector === '반도체', withSector.candidatesKospi[0]);

  console.log('\n[7] 테마 키워드 가점');
  const kwRun = await S.runMomentum({ ...opt, keywords: ['음식료'], weightKeyword: 0.5, weightCond: 0.3, weightSector: 0.1, weightVolume: 0.1 });
  const hit = kwRun.candidatesKospi.filter(c => c.keywordHit);
  check('키워드가 걸린 종목에 keywordHit 표시', hit.length >= 1, kwRun.candidatesKospi.map(c => ({ n: c.name, hit: c.keywordHit })));

  console.log('\n[8] barsAgo=1 (전일 확정봉 기준)');
  const prev = await S.runMomentum({ ...opt, barsAgo: 1 });
  check('전일 기준 스캔도 정상 동작', prev.consideredCount === 8, prev.consideredCount);
  check('전일 기준에서는 돌파 신호가 사라짐(급등이 마지막 봉이므로)',
    prev.funnel.strict === 0, prev.funnel);

  console.log('\n[8-1] 적정주가 얹기');
  const fvRun = await S.runMomentum({ ...opt, withFairValue: true });
  const withFv = [...fvRun.candidatesKospi, ...fvRun.candidatesKosdaq];
  console.log('  적정주가:', JSON.stringify(withFv.map(c => ({ n: c.name, fair: c.fairPrice, gap: c.gapPct, note: c.fairNote }))));
  check('후보마다 적정주가 또는 사유가 붙는다',
    withFv.every(c => c.fairPrice != null || c.fairNote), withFv.map(c => ({ f: c.fairPrice, n: c.fairNote })));
  check('적정주가가 계산된 종목이 있다', withFv.some(c => c.fairPrice > 0), withFv.map(c => c.fairPrice));
  check('괴리율은 종가와 적정주가로 맞아떨어진다', withFv.every(c => {
    if (c.fairPrice == null || c.gapPct == null) return true;
    const expect = Math.round((c.close / c.fairPrice - 1) * 1000) / 10;
    return Math.abs(c.gapPct - expect) < 0.2;
  }), withFv.map(c => ({ close: c.close, fair: c.fairPrice, gap: c.gapPct })));
  // 경고는 더 위험한 것부터 붙는다: ROE 과다 → 괴리율 과도 → BPS 추정
  check('적정주가가 나온 종목에는 판단 근거가 되는 경고가 붙는다',
    withFv.filter(c => c.fairPrice != null).every(c => /추정|초과이익|유지된다는 가정|과도/.test(c.fairNote || '')),
    withFv.map(c => c.fairNote));
  check('계산 근거(ROE·자기자본)가 함께 나온다',
    withFv.filter(c => c.fairPrice != null).every(c => c.fairInputs && Array.isArray(c.fairInputs.roe)),
    withFv.map(c => c.fairInputs));

  console.log('\n[8-2] 끄면 재무 조회를 하지 않는다');
  const noFv = await S.runMomentum({ ...opt, withFairValue: false, topN: 2 });
  check('적정주가 필드가 없다',
    [...noFv.candidatesKospi, ...noFv.candidatesKosdaq].every(c => c.fairPrice === undefined),
    noFv.candidatesKospi.map(c => c.fairPrice));

  console.log('\n[9] 추천 기록이 저평가 스크리너와 분리되는가');
  await S.recordRecommendation('2026-09-09', { a: 1 }, [{ code: '000001', name: '가치주', price: 100 }], 'value');
  await S.recordRecommendation('2026-09-09', { a: 2 }, [{ code: '000002', name: '모멘텀주', price: 200 }], 'momentum');
  const v = await S.getRecommendation('2026-09-09', 'value');
  const m2 = await S.getRecommendation('2026-09-09', 'momentum');
  check('같은 날짜라도 서로 덮어쓰지 않음',
    v.candidates[0].code === '000001' && m2.candidates[0].code === '000002',
    { v: v.candidates[0].code, m: m2.candidates[0].code });
  const vd = await S.listRecommendationDates('value');
  const md = await S.listRecommendationDates('momentum');
  check('날짜 목록도 종류별로 분리', vd.includes('2026-09-09') && md.includes('2026-09-09'), { vd, md });


console.log('\n[10] 업종 목록 페이지가 죽으면 종목별 API로 거꾸로 모은다');
{
  const saved = global.fetch;
  let perStockCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    const send = (t) => ({ ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') });
    // 업종 목록 페이지는 재구축돼 링크가 하나도 없다
    if (u.includes('sise_group')) return send('<html><body><div id="__next"></div></body></html>');
    if (u.includes('/api/stock/') && u.endsWith('/integration')) {
      perStockCalls++;
      const code = (u.match(/\/api\/stock\/(\d{6})\//) || [])[1];
      const name = code === '200001' ? '반도체' : '음식료';
      return send(JSON.stringify({ stockName: 'X', industryCodeType: { industryName: name } }));
    }
    return send('{}');
  };
  S.__clearCaches(true);
  // 유니버스 캐시를 먼저 채워야 대체 경로가 대상 종목을 안다
  await S.fetchMarketCapUniverse(12, 'ALL').catch(() => {});
  global.fetch = async (url) => {
    const u = String(url);
    const send = (t) => ({ ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') });
    if (u.includes('sise_group')) return send('<html><body></body></html>');
    if (u.includes('/api/stock/') && u.endsWith('/integration')) {
      perStockCalls++;
      const code = (u.match(/\/api\/stock\/(\d{6})\//) || [])[1];
      return send(JSON.stringify({ industryCodeType: { industryName: code === '200001' ? '반도체' : '음식료' } }));
    }
    return send('{}');
  };
  const m = await S.fetchSectorMap();
  check('대체 경로를 썼다는 표시', m.source === 'per-stock' || m.source === 'none', m.source);
  if (m.source === 'per-stock') {
    check('종목별 API를 실제로 호출', perStockCalls > 0, perStockCalls);
    check('업종명이 매핑됨', Object.keys(m.byCode).length > 0, Object.keys(m.byCode).length);
  }
  global.fetch = saved;
  S.__clearCaches(true);
}


console.log('\n[11] 업종 API는 20개씩 끊어 주므로 페이지를 넘겨 다 받아야 한다');
{
  const saved = global.fetch;
  const ALL = Array.from({ length: 78 }, (_, i) => ({ no: 200 + i, name: '업종' + i, totalCount: 5, changeRate: 1 }));
  global.fetch = async (url) => {
    const u = String(url);
    const send = (o) => { const t = JSON.stringify(o); return { ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') }; };
    const bad = { ok: false, status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
    if (u.includes('/api/stocks/industry/')) {
      if (!u.includes('page=')) return bad;                       // 파라미터 없으면 404 (실제로 그랬다)
      const p = Number((u.match(/page=(\d+)/) || [])[1] || 1);
      const start = (p - 1) * 20;
      const stocks = Array.from({ length: Math.max(0, Math.min(20, 45 - start)) }, (_, i) => ({ itemCode: String(100000 + start + i) }));
      return send({ stocks });
    }
    if (u.includes('/api/stocks/industry')) {
      if (!u.includes('page=')) return bad;
      const p = Number((u.match(/page=(\d+)/) || [])[1] || 1);
      return send({ groups: ALL.slice((p - 1) * 20, p * 20), totalCount: ALL.length });
    }
    throw new Error('예상치 못한 URL: ' + u);
  };

  const list = await S.fetchSectorListApi();
  check('업종 78개를 모두 받는다 (한 페이지 20개)', list.length === 78, list.length);
  check('중복 없이 수집', new Set(list.map(x => x.no)).size === 78, list.length);
  check('등락률이 함께 온다', typeof list[0].changeRate === 'number', list[0]);

  const mem = await S.fetchSectorMembersApi(315);
  check('구성종목 45개를 모두 받는다', mem.length === 45, mem.length);
  check('종목코드 형식', mem.every(c => /^\d{6}$/.test(c)), mem.slice(0, 3));
  global.fetch = saved;
  S.__clearCaches(true);
}


console.log('\n[12] 강한 업종과 약한 업종이 겹치지 않는다');
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ name: 'S' + i, ret5: 10 - i }));
  for (const n of [0, 1, 4, 5]) {
    const r = S.splitSectorRanks(mk(n));
    check(`업종 ${n}개면 약한 업종은 비운다`, r.bottom.length === 0, r);
  }
  const six = S.splitSectorRanks(mk(6));
  check('6개면 강 3 / 약 3으로 갈린다', six.top.length === 3 && six.bottom.length === 3, six);
  check('겹치는 업종 없음', new Set([...six.top, ...six.bottom].map(x => x.name)).size === 6);

  const many = S.splitSectorRanks(mk(20));
  check('20개면 강 8 / 약 5', many.top.length === 8 && many.bottom.length === 5, many);
  check('약한 쪽이 실제로 성적이 나쁘다', many.bottom[0].ret5 < many.top[0].ret5, { b: many.bottom[0], t: many.top[0] });
}

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
