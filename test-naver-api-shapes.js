/**
 * 실제 네이버 API 응답 모양으로 재무 수집을 검증한다.
 *
 * /api/probe/005930 결과에서 확인한 사실 (2026-09):
 *   - integration.totalInfos 는 { code, key, value, valueDesc } 목록이고
 *     value가 "86,052원", "1,605조 5,679억원" 같은 표시용 문자열이다.
 *   - 상장주식수 항목은 없다. 시가총액과 현재가로 역산해야 한다.
 *   - finance/annual 의 항목은 매출액·영업이익·…·ROE·EPS·BPS 뿐이고
 *     자본총계나 지배주주지분이 없다. 자기자본은 BPS × 주식수로 만들어야 한다.
 *   - ROE가 [4.15, 9.03, 10.85, 56.4]로 나왔는데 마지막은 추정치(E) 컬럼이다.
 *
 * 이 테스트는 그 모양을 그대로 재현해, 최종적으로 스크리너가 요구하는
 * 네 항목(현재가·자기자본·발행주식수·ROE 3년)이 채워지는지 본다.
 */
process.env.PORT = '39989';

const PRICE = 269000;
const BPS = 86052;
const SHARES = 5969782550;
// 시가총액 = 현재가 × 주식수 = 269,000 × 5,969,782,550 ≈ 1,605조 8,714억원
const MARKET_CAP_TEXT = '1,605조 8,714억원';

function integrationJson() {
  return {
    stockEndType: 'stock', itemCode: '005930', reutersCode: 'KR7005930003', stockName: '삼성전자',
    totalInfos: [
      { code: 'quant', key: '거래량', value: '12,345,678' },
      { code: 'marketValue', key: '시가총액', value: MARKET_CAP_TEXT, valueDesc: '코스피 1위' },
      { code: 'per', key: 'PER', value: '15.2배' },
      { code: 'eps', key: 'EPS', value: '17,700원', valueDesc: '2026.06.' },
      { code: 'bps', key: 'BPS', value: '86,052원', valueDesc: '2026.06.' },
      { code: 'pbr', key: 'PBR', value: '3.13배' },
    ],
    dealTrendInfos: [], industryCode: '005930',
  };
}

function basicJson() {
  return {
    stockEndType: 'stock', itemCode: '005930', stockName: '삼성전자',
    closePrice: String(PRICE), compareToPreviousClosePrice: '1,500',
    fluctuationsRatio: '0.56', marketStatus: 'CLOSE', stockExchangeName: 'KOSPI',
  };
}

/** 마지막 컬럼이 추정치(E)인 연간 재무 */
function financeAnnualJson() {
  const P = ['202312', '202412', '202512', '202612'];
  const row = (title, vals) => ({
    title,
    columns: P.reduce((o, p, i) => { o[p] = { value: String(vals[i]) }; return o; }, {}),
  });
  return {
    itemCode: '005930', financePeriodType: 'ANNUAL',
    financeInfo: {
      trTitleList: [
        { key: '202312', title: '2023.12' },
        { key: '202412', title: '2024.12' },
        { key: '202512', title: '2025.12' },
        { key: '202612', title: '2026.12(E)' },
      ],
      rowList: [
        row('매출액', [2589355, 3007700, 3210000, 3400000]),
        row('영업이익', [65670, 327260, 410000, 520000]),
        row('당기순이익', [154871, 340000, 390000, 480000]),
        row('ROE', [4.15, 9.03, 10.85, 56.4]),
        row('EPS', [2131, 5000, 5800, 7000]),
        row('BPS', [52002, 57000, 86052, 92000]),
      ],
    },
  };
}

let alive = { basic: true, integration: true, trend: true, annual: true, html: true, fnguide: true };

global.fetch = async (url) => {
  const u = String(url);
  const bad = { ok: false, status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
  const send = (o) => {
    const t = typeof o === 'string' ? o : JSON.stringify(o);
    return { ok: true, status: 200, text: async () => t, arrayBuffer: async () => Buffer.from(t, 'utf8') };
  };

  if (u.includes('/finance/annual')) return alive.annual ? send(financeAnnualJson()) : bad;
  if (u.endsWith('/integration')) return alive.integration ? send(integrationJson()) : bad;
  if (u.endsWith('/basic')) return alive.basic ? send(basicJson()) : bad;
  if (u.includes('/trend')) return alive.trend ? send([{ bizdate: '20260910', closePrice: String(PRICE) }]) : bad;
  // 개편된 종목 페이지 — 표도 현재가도 없다
  if (u.includes('item/main.naver')) {
    return alive.html ? send('<html><head><meta charset="utf-8"></head><body><div id="__next"></div></body></html>') : bad;
  }
  // FnGuide는 페이지는 오지만 표를 못 찾는 상태
  if (u.includes('fnguide')) {
    return alive.fnguide ? send('<html><head><meta charset="utf-8"></head><body><div>내용 없음</div></body></html>') : bad;
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}
const near = (a, b, tolPct) => a != null && Math.abs(a - b) / b <= (tolPct || 0.01);

(async () => {
  console.log('\n[1] 한국식 금액 표기 해석');
  check('"86,052원" → 86052', S.parseKoreanAmount('86,052원') === 86052);
  check('"1,605조 5,679억원" → 조·억 합산',
    S.parseKoreanAmount('1,605조 5,679억원') === 1605e12 + 5679e8, S.parseKoreanAmount('1,605조 5,679억원'));
  check('"3.13배" → 3.13', S.parseKoreanAmount('3.13배') === 3.13);
  check('단위 없는 숫자도 그대로', S.parseKoreanAmount('12,345,678') === 12345678);
  check('빈 값은 null', S.parseKoreanAmount('') === null && S.parseKoreanAmount(null) === null);

  console.log('\n[2] totalInfos에서 라벨로 값 찾기');
  check('code로 BPS를 찾음', S.pickTotalInfo(integrationJson(), /^bps$/i, null, 0).value === 86052);
  check('시가총액도 단위까지 해석', near(S.pickTotalInfo(integrationJson(), /시가총액/, null, 0).value, 1605e12 + 8714e8));

  console.log('\n[3] 추정치(E) 컬럼 걸러내기');
  const est = S.collectEstimatePeriods(financeAnnualJson(), null, 0);
  check('2026.12(E) 기간이 추정치로 잡힘', est.has('202612'), [...est]);
  check('실적 기간은 안 잡힘', !est.has('202512'), [...est]);

  console.log('\n[4] 재무 API');
  S.__clearCaches(true);
  const fin = await S.fromNaverFinance('005930');
  check('ROE에서 추정치 56.4가 빠짐',
    fin.roeSeries.join() === '4.15,9.03,10.85', fin.roeSeries);
  check('어느 기간 값을 썼는지 남김',
    fin.roeColumns.map(x => x.period).join() === '202312,202412,202512', fin.roeColumns);
  check('BPS도 실적 기준 최근값', fin.bps === 86052, fin.bps);
  check('자본총계·지배주주지분이 없으므로 equityEok는 null', fin.equityEok == null, fin.equityEok);
  check('읽은 항목 목록을 남김', fin.labelsSeen.includes('ROE'), fin.labelsSeen);

  console.log('\n[5] 기본정보 API — 주식수 역산');
  S.__clearCaches(true);
  const api = await S.fromNaverApi('005930');
  check('현재가', api.price === PRICE, api.price);
  check('종목명', api.name === '삼성전자', api.name);
  check('BPS를 표시용 문자열에서 해석', api.bps === BPS, api.bps);
  check('시가총액 확보', api.marketCapWon > 0, api.marketCapWon);
  check('상장주식수를 시가총액 ÷ 현재가로 역산 (오차 1% 이내)',
    near(api.shares, SHARES, 0.01), { got: api.shares, expect: SHARES });
  check('역산했다는 표시가 남음', /역산/.test(api.sharesNote || ''), api.sharesNote);

  console.log('\n[6] 최종 결과 — 스크리너가 요구하는 네 항목');
  S.__clearCaches(true);
  const f = await S.getFundamentals('005930');
  check('현재가', f.price === PRICE, f.price);
  check('ROE 3년 (추정치 제외, 오래된 순)', f.roe.join() === '4.15,9.03,10.85', f.roe);
  check('발행주식수', near(f.shares, SHARES, 0.01), f.shares);
  check('자기자본 = BPS × 주식수 (억원)',
    near(f.equityEok, BPS * SHARES / 1e8, 0.02), { got: f.equityEok, expect: Math.round(BPS * SHARES / 1e8) });
  check('추정값임을 표기', /BPS/.test(f.equityNote), f.equityNote);
  check('역산 사실을 경고로 남김', f.warnings.some(w => /역산/.test(w)), f.warnings);
  check('네 항목이 모두 채워져 스크리너가 통과시킬 수 있다',
    !!(f.price && f.equityEok && f.shares && f.roe.every(v => v != null)),
    { p: f.price, e: f.equityEok, s: f.shares, r: f.roe });

  console.log('\n[7] 시가총액을 못 읽으면 주식수는 비운다 (엉뚱한 값을 만들지 않는다)');
  S.__clearCaches(true);
  alive.integration = false;
  const api2 = await S.fromNaverApi('005930');
  check('현재가는 여전히 확보', api2.price === PRICE, api2.price);
  check('주식수는 null', api2.shares == null, api2.shares);
  alive.integration = true;

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
