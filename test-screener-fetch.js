/**
 * fetchMarketCapPage / fetchMarketCapUniverse / fetchInvestorFlow 검증.
 * fetchInvestorFlow 픽스처는 2026-09 실제 캡처로 확인된 필드명을 그대로 쓴다
 * (organPureBuyQuant, foreignerPureBuyQuant, tradeVolume, bizdate, 배열 응답).
 * 시가총액 페이지는 여전히 표 구조를 모사한 픽스처다.
 */
process.env.PORT = '39996';

function marketCapPage(rows) {
  const trs = rows.map(([code, name], i) =>
    `<tr><td>${i + 1}</td><td><a href="/item/main.naver?code=${code}">${name}</a></td><td>70,000</td></tr>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <table class="type_2"><tr><th>순위</th><th>종목명</th><th>현재가</th></tr>${trs}</table>
    </body></html>`;
}

const UNIVERSE_PAGES = {
  1: marketCapPage(Array.from({ length: 50 }, (_, i) => [String(5930 + i).padStart(6, '0'), '종목' + (i + 1)])),
  2: marketCapPage(Array.from({ length: 50 }, (_, i) => [String(6000 + i).padStart(6, '0'), '종목' + (i + 51)])),
  3: marketCapPage([]),
};

// stock.naver.com trend API 픽스처 — 실제 캡처로 확인된 필드명 그대로 씀
// (배열을 바로 반환, bizdate는 구분자 없는 YYYYMMDD, organPureBuyQuant/foreignerPureBuyQuant/tradeVolume)
function trendFixture() {
  const rows = [];
  for (let i = 19; i >= 0; i--) {
    const isLast = i === 0;
    const d = new Date('2026-08-29T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const bizdate = d.toISOString().slice(0, 10).replace(/-/g, '');
    rows.push({
      itemCode: '005930',
      bizdate,
      closePrice: String(50000 + (19 - i) * 100),
      tradeVolume: String(isLast ? 500000 : 100000),
      organPureBuyQuant: String(isLast ? 30000 : 1000),
      foreignerPureBuyQuant: String(isLast ? 20000 : 500),
      individualPureBuyQuant: '-1000',
    });
  }
  return rows; // 실제 응답은 {result:[...]}이 아니라 배열 자체다
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('sise_market_sum')) {
    const m = u.match(/page=(\d+)/);
    const p = m ? Number(m[1]) : 1;
    const html = UNIVERSE_PAGES[p] || marketCapPage([]);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(html, 'utf8') };
  }
  if (u.includes('stock.naver.com/api/domestic/detail')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(trendFixture()) };
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const {
  fetchMarketCapPage, fetchMarketCapUniverse, fetchInvestorFlow,
} = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('시가총액 페이지 파싱');
  const p1 = await fetchMarketCapPage(1);
  check('50종목 파싱', p1.length === 50, p1.length);
  check('첫 종목 코드', p1[0].code === '005930', p1[0]);
  check('첫 종목명', p1[0].name === '종목1', p1[0]);

  console.log('\n유니버스 수집 (100종목 요청 → 2페이지)');
  const uni = await fetchMarketCapUniverse(100);
  check('정확히 100개', uni.length === 100, uni.length);
  check('순서 유지 (50번째=페이지1 마지막, 51번째=페이지2 시작)',
    uni[49].code === '005979' && uni[50].code === '006000', { r50: uni[49], r51: uni[50] });
  check('중복 없음', new Set(uni.map(u => u.code)).size === uni.length);

  console.log('\n유니버스 수집 (150종목 요청했지만 실제로는 100개뿐)');
  const uniShort = await fetchMarketCapUniverse(150);
  check('있는 만큼만 반환 (100개)', uniShort.length === 100, uniShort.length);

  console.log('\n수급(기관/외국인) 파싱 — 가상 필드명(foreignPureBuyQuant 등) 기준');
  const flow = await fetchInvestorFlow('005930', 5);
  check('데이터 있음으로 판정', flow.hasData === true, flow);
  check('20개 행 파싱됨', flow.rows.length === 20, flow.rows.length);
  check('날짜 형식 변환됨', /^\d{4}-\d{2}-\d{2}$/.test(flow.rows[0].date), flow.rows[0]);
  check('거래량비율 > 1 (마지막날 급증)', flow.volumeRatio > 1, flow.volumeRatio);
  check('순매수강도 > 0 (기관+외국인 순매수)', flow.flowStrength > 0, flow.flowStrength);
  check('flowSum > 0', flow.flowSum > 0, flow.flowSum);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
