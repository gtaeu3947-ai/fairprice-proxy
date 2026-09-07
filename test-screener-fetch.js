/**
 * fetchMarketCapPage / fetchMarketCapUniverse / fetchInvestorFlow 검증.
 * 실제 사이트에 나가지 않고, 표 구조를 모사한 픽스처로 확인한다.
 */
process.env.PORT = '39996';

function marketCapPage(rows) {
  // 실제 페이지는 순위/종목명/현재가/... 여러 컬럼이 있고, 종목명 칸에
  // "/item/main.naver?code=XXXXXX" 링크가 들어 있다. 그 구조만 재현한다.
  const trs = rows.map(([code, name], i) =>
    `<tr><td>${i + 1}</td><td><a href="/item/main.naver?code=${code}">${name}</a></td><td>70,000</td></tr>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <table class="type_2"><tr><th>순위</th><th>종목명</th><th>현재가</th></tr>${trs}</table>
    </body></html>`;
}

function flowPage(rows) {
  // date(간략 YY.MM.DD), 종가, 전일비, 등락률, 거래량, 기관순매매량, 외국인순매매량, 외국인보유율
  const trs = rows.map(r =>
    `<tr><td>${r.d}</td><td>${r.close}</td><td>0</td><td>0.0%</td><td>${r.vol}</td>` +
    `<td>${r.inst}</td><td>${r.frn}</td><td>10.5%</td></tr>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <table class="type2">
      <tr><th>날짜</th><th>종가</th><th>전일비</th><th>등락률</th><th>거래량</th><th>기관 순매매량</th><th>외국인 순매매량</th><th>외국인 보유율</th></tr>
      ${trs}
    </table></body></html>`;
}

const UNIVERSE_PAGES = {
  1: marketCapPage(Array.from({ length: 50 }, (_, i) => [String(5930 + i).padStart(6, '0'), '종목' + (i + 1)])),
  2: marketCapPage(Array.from({ length: 50 }, (_, i) => [String(6000 + i).padStart(6, '0'), '종목' + (i + 51)])),
  3: marketCapPage([]), // 3페이지는 없다고 가정
};

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('sise_market_sum')) {
    const m = u.match(/page=(\d+)/);
    const p = m ? Number(m[1]) : 1;
    const html = UNIVERSE_PAGES[p] || marketCapPage([]);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(html, 'utf8') };
  }
  if (u.includes('frgn.naver')) {
    // 20 거래일: 마지막 날(가장 최근)에 거래량 급증 + 기관·외국인 동반 순매수 시나리오
    const rows = [];
    for (let i = 19; i >= 0; i--) {
      const isLast = i === 0;
      rows.push({
        d: `26.08.${String(20 + (19 - i)).padStart(2, '0')}`.length === 8 ? `26.08.${String(10 + (19-i)).padStart(2,'0')}` : '26.08.10',
        close: 50000 + (19 - i) * 100,
        vol: isLast ? 500000 : 100000,
        inst: isLast ? 30000 : 1000,
        frn: isLast ? 20000 : 500,
      });
    }
    const html = flowPage(rows);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(html, 'utf8') };
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

  console.log('\n수급(기관/외국인) 파싱');
  const flow = await fetchInvestorFlow('005930', 5);
  check('데이터 있음으로 판정', flow.hasData === true);
  check('거래량비율 > 1 (마지막날 급증)', flow.volumeRatio > 1, flow.volumeRatio);
  check('순매수강도 > 0 (기관+외국인 순매수)', flow.flowStrength > 0, flow.flowStrength);
  check('flowSum > 0', flow.flowSum > 0, flow.flowSum);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
