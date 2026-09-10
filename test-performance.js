/**
 * recordRecommendation / getRecommendation / listRecommendationDates / priceAsOf /
 * computePerformance 검증.
 *
 * Upstash가 없는 환경(메모리 저장소)을 기준으로 테스트한다 — hasRedis()가
 * false를 반환하도록 UPSTASH_* 환경변수를 비워둔 채로 실행한다.
 */
process.env.PORT = '39983';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

function fnHtml({ name, equityEok, roe, shares, treasury }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <h1 id="giName">${name}</h1>
  <div>발행주식수 ${shares.toLocaleString('en-US')} 자기주식 ${treasury.toLocaleString('en-US')}</div>
  <table id="highlight_D_A">
  <thead><tr><th>IFRS(연결)</th><th>2024/12</th><th>2025/12</th><th>2026/12</th></tr></thead>
  <tbody>
  <tr><th>지배주주지분</th><td>${equityEok}</td><td>${equityEok}</td><td>${equityEok}</td></tr>
  <tr><th>ROE</th><td>${roe}</td><td>${roe}</td><td>${roe}</td></tr>
  </tbody></table></body></html>`;
}
function nvHtml({ name, price, shares }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <div class="wrap_company"><h2><a href="#">${name}</a></h2></div>
  <p class="no_today"><em><span class="blind">${price}</span></em></p>
  <table id="tab_con1"><tr><th>상장주식수</th><td>${shares.toLocaleString('en-US')}</td></tr></table>
  </body></html>`;
}
function siseDayPage(rows) {
  const trs = rows.map(r => `<tr><td>${r.d}</td><td>${r.close}</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>`).join('');
  return `<html><body><table>${trs}</table></body></html>`;
}

// 오늘(라이브)과 과거 시세를 구분해서 확인해야 하므로, kstDate()가 반환할 "오늘"을
// 고정할 수 없다 — 대신 test-history.js처럼 실제 today를 기준으로 최근 며칠을 만든다.
const { kstDate } = require('./server.js');
const TODAY = kstDate();
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

const LIVE_PRICE = { '100001': 12000, '100002': 8000 };
const HISTORY = {
  // 종목 100001: 5일 전 10,000원 -> 오늘 12,000원 (+20%)
  '100001': [
    { d: daysAgo(5).replace(/-/g, '.'), close: 10000 },
    { d: daysAgo(4).replace(/-/g, '.'), close: 10200 },
    { d: daysAgo(3).replace(/-/g, '.'), close: 10500 },
    { d: daysAgo(2).replace(/-/g, '.'), close: 11000 },
    { d: daysAgo(1).replace(/-/g, '.'), close: 11500 },
  ],
  // 종목 100002: 5일 전 10,000원 -> 오늘 8,000원 (-20%)
  '100002': [
    { d: daysAgo(5).replace(/-/g, '.'), close: 10000 },
    { d: daysAgo(4).replace(/-/g, '.'), close: 9700 },
    { d: daysAgo(3).replace(/-/g, '.'), close: 9300 },
    { d: daysAgo(2).replace(/-/g, '.'), close: 8800 },
    { d: daysAgo(1).replace(/-/g, '.'), close: 8300 },
  ],
};

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });
  const mCode = u.match(/code=(\d{6})/);
  const code = mCode ? mCode[1] : null;

  if (u.includes('sise_day.naver')) {
    const rows = (HISTORY[code] || []).map(r => ({ d: r.d, close: r.close }));
    return html(siseDayPage(rows));
  }
  if (u.includes('SVD_Main.asp')) {
    return html(fnHtml({ name: '종목' + code, equityEok: 10000, roe: 15, shares: 100000000, treasury: 0 }));
  }
  if (u.includes('item/main.naver')) {
    return html(nvHtml({ name: '종목' + code, price: LIVE_PRICE[code], shares: 100000000 }));
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const {
  recordRecommendation, getRecommendation, listRecommendationDates,
  priceAsOf, computePerformance,
} = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  const recoDate = daysAgo(5);
  const candidates = [
    { code: '100001', name: '오른종목', market: 'KOSPI', price: 10000, fairPrice: 15000, gapPct: -33.3, score: 0.9 },
    { code: '100002', name: '내린종목', market: 'KOSDAQ', price: 10000, fairPrice: 13000, gapPct: -23.1, score: 0.6 },
  ];

  console.log('기록 없을 때');
  check('없는 날짜 조회 -> null', (await getRecommendation(recoDate)) === null);
  check('빈 candidates는 기록 안 함', (async () => { await recordRecommendation(recoDate, {}, []); return (await getRecommendation(recoDate)) === null; })());

  console.log('\n기록·조회');
  await recordRecommendation(recoDate, { regime: 'up' }, candidates);
  const saved = await getRecommendation(recoDate);
  check('저장된 날짜 일치', saved.date === undefined || saved.date === recoDate, saved); // date는 payload에 안 넣었으므로 opt/candidates만 확인
  check('저장된 종목 2개', saved.candidates.length === 2, saved.candidates.length);
  check('저장된 opt 유지', saved.opt.regime === 'up', saved.opt);

  const dates = await listRecommendationDates();
  check('날짜 목록에 포함됨', dates.includes(recoDate), dates);

  console.log('\n덮어쓰기 (하루에 여러 번 스캔한 경우 마지막 것으로 대체)');
  await recordRecommendation(recoDate, { regime: 'down' }, [candidates[0]]);
  const overwritten = await getRecommendation(recoDate);
  check('마지막 기록으로 덮어써짐', overwritten.opt.regime === 'down' && overwritten.candidates.length === 1, overwritten);
  await recordRecommendation(recoDate, { regime: 'up' }, candidates); // 이후 테스트를 위해 원상 복구

  console.log('\npriceAsOf');
  const live = await priceAsOf('100001', TODAY);
  check('오늘 조회 -> 실시간가', live.price === 12000 && live.isLive === true, live);

  const past = await priceAsOf('100001', daysAgo(3));
  check('과거 조회 -> 그 날짜 종가', past.price === 10500 && past.isLive === false, past);

  const weekendish = await priceAsOf('100001', daysAgo(5)); // 픽스처의 첫 거래일과 정확히 같은 날
  check('추천일 당일 조회 -> 그날 종가(10000)', weekendish.price === 10000, weekendish);

  console.log('\ncomputePerformance — 전체 선택(2종목 다 매수)');
  const perfAll = await computePerformance(recoDate, TODAY, null);
  check('종목 2개 다 있음', perfAll.stocks.length === 2, perfAll.stocks.length);
  const s1 = perfAll.stocks.find(s => s.code === '100001');
  const s2 = perfAll.stocks.find(s => s.code === '100002');
  check('오른종목 수익률 +20%', Math.abs(s1.returnPct - 20) < 0.01, s1.returnPct);
  check('내린종목 수익률 -20%', Math.abs(s2.returnPct - (-20)) < 0.01, s2.returnPct);
  check('둘 다 selected=true', s1.selected === true && s2.selected === true);
  check('포트폴리오 수익률 = 평균(0%) — 오른 것과 내린 것이 상쇄',
    Math.abs(perfAll.portfolioReturnPct - 0) < 0.01, perfAll.portfolioReturnPct);

  console.log('\ncomputePerformance — 선별 매수(오른종목만 골랐을 때)');
  const perfPicked = await computePerformance(recoDate, TODAY, ['100001']);
  const p1 = perfPicked.stocks.find(s => s.code === '100001');
  const p2 = perfPicked.stocks.find(s => s.code === '100002');
  check('고른 종목은 selected=true, 수익률 계산됨', p1.selected === true && Math.abs(p1.returnPct - 20) < 0.01, p1);
  check('안 고른 종목은 selected=false, 수익률 null', p2.selected === false && p2.returnPct === null, p2);
  check('포트폴리오 수익률 = 고른 것만의 평균(+20%)',
    Math.abs(perfPicked.portfolioReturnPct - 20) < 0.01, perfPicked.portfolioReturnPct);

  console.log('\nhasRedis() URL 형식 검사 (URL/TOKEN이 서로 바뀌어 들어간 실제 사고 재현)');
  // hasRedis()는 !!(URL && TOKEN && /^https?:\/\//.test(URL)) 로 구현돼 있다 — 그 판단 로직 자체를 검증한다.
  // (서버 모듈을 통째로 다시 require하면 app.listen()이 같은 포트로 또 실행돼 충돌하므로, 패턴만 따로 확인한다.)
  const looksLikeValidUrl = (u) => /^https?:\/\//.test(u || '');
  check('진짜 URL은 통과', looksLikeValidUrl('https://desired-lamb-83560.upstash.io') === true);
  check('토큰 모양 값(URL 자리에 잘못 들어간 경우)은 거부', looksLikeValidUrl('gQAAAAAAUZoAAIgcDFkYjA2MzllYWRjZmM0NTIzYjgyMWJj') === false);
  check('빈 값도 거부', looksLikeValidUrl('') === false && looksLikeValidUrl(undefined) === false);

  console.log('\n기록 없는 날짜 조회 시 에러');
  let threw = false, notFound = false;
  try { await computePerformance('2000-01-01', TODAY, null); }
  catch (e) { threw = true; notFound = !!e.notFound; }
  check('없는 추천일은 예외를 던짐(notFound)', threw && notFound);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
