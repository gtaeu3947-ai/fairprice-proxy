/**
 * 재무 항목(자기자본·ROE) 수집 검증.
 *
 * 겪은 문제(2026-09): 네이버 종목 페이지 개편 이후 HTML 표가 사라졌고,
 * FnGuide도 값을 못 냈다. 현재가는 API로 살렸지만 equityEok·roe·shares가
 * 전부 null이라 저평가 스크리너가 전 종목을 "데이터 부족"으로 버렸다.
 *
 * 그래서 네이버 재무 API를 출처로 추가했다. 응답을 감싸는 이름이 판마다 달라서,
 * "문자열 라벨 + 기간별 숫자 묶음"이라는 모양만 보고 뽑는다.
 * 여기서는 그 추출기가 실제로 있을 법한 여러 모양을 다 소화하는지 확인한다.
 */
process.env.PORT = '39990';

/** 모양 1: { rowList: [{ title, columns: { 기간: { value } } }] } */
function shapeColumns() {
  return {
    financeInfo: {
      trTitleList: [{ key: '202312' }, { key: '202412' }, { key: '202512' }],
      rowList: [
        { title: '매출액', columns: { '202312': { value: '2589355' }, '202412': { value: '3007700' }, '202512': { value: '3210000' } } },
        { title: '지배주주지분', columns: { '202312': { value: '3600000' }, '202412': { value: '3800000' }, '202512': { value: '4020000' } } },
        { title: 'ROE', columns: { '202312': { value: '8.1' }, '202412': { value: '9.4' }, '202512': { value: '11.2' } } },
      ],
    },
  };
}

/** 모양 2: 값이 배열이고 필드명이 다름 */
function shapeArray() {
  return {
    result: {
      rows: [
        { name: 'ROE(%)', data: ['8.1', '9.4', '11.2'] },
        { name: '자본총계', data: ['3700000', '3900000', '4100000'] },
      ],
    },
  };
}

/** 모양 3: 라벨은 있지만 숫자가 하나뿐 — 시계열이 아니므로 무시돼야 한다 */
function shapeTooShort() {
  return { items: [{ title: 'ROE', columns: { '202512': { value: '11.2' } } }] };
}

let mode = 'columns';
let alive = { annual: true, annualAlt: true };
let calls = [];

global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const bad = { ok: false, status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
  const send = (o) => {
    const t = JSON.stringify(o);
    return { ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') };
  };

  if (u.includes('m.stock.naver.com') && u.includes('/finance/annual')) {
    if (!alive.annual) return bad;
    return send(mode === 'array' ? shapeArray() : mode === 'short' ? shapeTooShort() : shapeColumns());
  }
  if (u.includes('api.stock.naver.com') && u.includes('/finance/annual')) {
    if (!alive.annualAlt) return bad;
    return send(shapeArray());
  }
  // 나머지 출처는 이 테스트 범위 밖 — 전부 실패시켜 재무 API만 보게 한다.
  if (u.includes('/api/stock/') || u.includes('/trend') || u.includes('item/main.naver') || u.includes('fnguide')) return bad;
  throw new Error('예상치 못한 URL: ' + u);
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('\n[1] 라벨 시계열 추출기');
  let rows = S.extractLabeledSeries(shapeColumns(), [], 0);
  const roeRow = rows.find(r => /^ROE/.test(r.label));
  check('ROE 행을 찾음', !!roeRow, rows.map(r => r.label));
  check('값 3개를 순서대로 뽑음', roeRow && roeRow.values.join() === '8.1,9.4,11.2', roeRow && roeRow.values);
  check('지배주주지분도 찾음', rows.some(r => r.label === '지배주주지분'), rows.map(r => r.label));

  rows = S.extractLabeledSeries(shapeArray(), [], 0);
  check('배열형·다른 필드명도 소화', rows.find(r => /ROE/.test(r.label)).values.join() === '8.1,9.4,11.2',
    rows.map(r => ({ l: r.label, v: r.values })));

  rows = S.extractLabeledSeries(shapeTooShort(), [], 0);
  check('값이 하나뿐인 행은 시계열로 보지 않음', rows.length === 0, rows);

  console.log('\n[2] 재무 API 출처');
  mode = 'columns'; alive = { annual: true, annualAlt: true }; S.__clearCaches(true);
  let r = await S.fromNaverFinance('005930');
  check('ROE 3년치 확보', r.roeSeries.join() === '8.1,9.4,11.2', r.roeSeries);
  check('자기자본은 가장 최근 값', r.equityEok === 4020000, r.equityEok);
  check('지배주주지분을 썼으므로 연결총계 플래그는 꺼짐',
    r.equityIsConsolidatedTotal === false, r.equityIsConsolidatedTotal);

  console.log('\n[3] 지배주주지분이 없으면 자본총계로 대체하고 표시를 남긴다');
  mode = 'array'; S.__clearCaches(true);
  r = await S.fromNaverFinance('005930');
  check('자본총계 값을 씀', r.equityEok === 4100000, r.equityEok);
  check('연결총계를 썼다는 표시가 켜짐', r.equityIsConsolidatedTotal === true, r.equityIsConsolidatedTotal);

  console.log('\n[4] 첫 URL이 죽으면 두 번째로 넘어간다');
  mode = 'columns'; alive = { annual: false, annualAlt: true }; S.__clearCaches(true); calls = [];
  r = await S.fromNaverFinance('005930');
  check('대체 URL에서 ROE 확보', r.roeSeries.join() === '8.1,9.4,11.2', r.roeSeries);
  check('사용한 출처가 기록됨', /api\.stock\.naver\.com/.test(r.sourceUrl), r.sourceUrl);

  console.log('\n[5] 둘 다 죽으면 이유를 담아 던진다');
  alive = { annual: false, annualAlt: false }; S.__clearCaches(true);
  let msg = null;
  try { await S.fromNaverFinance('005930'); } catch (e) { msg = e.message; }
  check('에러 메시지가 남음', /읽지 못했습니다/.test(msg || ''), msg);

  console.log('\n[6] 합쳐진 결과 — FnGuide가 죽어도 ROE·자기자본이 채워진다');
  mode = 'columns'; alive = { annual: true, annualAlt: true }; S.__clearCaches(true);
  let fund = null, err = null;
  try { fund = await S.getFundamentals('005930'); } catch (e) { err = e.message; }
  check('결과가 나옴', fund != null, err);
  if (fund) {
    // roe는 오래된 것 → 최신 순으로 담긴다 (fairValue가 roe3, roe2, roe1 순서로 받는다).
    check('ROE가 3년치로 채워짐(오래된 순)', fund.roe.join() === '8.1,9.4,11.2', fund.roe);
    check('자기자본이 채워짐', fund.equityEok === 4020000, fund.equityEok);
    check('출처 표기가 네이버 재무 API로 바뀜', /네이버 재무/.test(fund.equityNote), fund.equityNote);
    check('FnGuide 실패는 경고로만 남음', fund.warnings.some(w => /FnGuide/.test(w)), fund.warnings);
    // 이 테스트에서는 현재가·주식수 출처를 전부 죽여놨으므로 그 둘은 비어 있는 게 정상이다.
    check('현재가 출처가 없으면 현재가는 비어 있다', fund.price == null, fund.price);
  }

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
