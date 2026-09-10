/**
 * fetchMarketCapUniverse의 market 파라미터(KOSPI/KOSDAQ/ALL) 검증.
 * sosok=0(코스피), sosok=1(코스닥)에 각각 다른 종목 목록을 물리고,
 * market별로 올바른 소스에서 가져오는지 · 'ALL'이 둘을 섞는지 확인한다.
 */
process.env.PORT = '39985';

function marketCapPage(rows) {
  const trs = rows.map(([code, name], i) =>
    `<tr><td>${i + 1}</td><td><a href="/item/main.naver?code=${code}">${name}</a></td><td>1</td></tr>`
  ).join('');
  return `<html><body><table>${trs}</table></body></html>`;
}

const KOSPI_PAGE1 = marketCapPage(Array.from({ length: 50 }, (_, i) => [String(500000 + i), '코스피종목' + (i + 1)]));
const KOSDAQ_PAGE1 = marketCapPage(Array.from({ length: 50 }, (_, i) => [String(600000 + i), '코스닥종목' + (i + 1)]));

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });
  if (u.includes('sise_market_sum')) {
    const mSosok = u.match(/sosok=(\d)/);
    const sosok = mSosok ? mSosok[1] : '0';
    const mPage = u.match(/page=(\d+)/);
    const page = mPage ? Number(mPage[1]) : 1;
    if (page > 1) return html(marketCapPage([])); // 2페이지부터는 빈 걸로 충분
    return html(sosok === '1' ? KOSDAQ_PAGE1 : KOSPI_PAGE1);
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const { fetchMarketCapPage, fetchMarketCapUniverse } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('개별 페이지 조회');
  const p0 = await fetchMarketCapPage(1, 0);
  const p1 = await fetchMarketCapPage(1, 1);
  check('sosok=0 → 코스피 목록', p0[0].name === '코스피종목1', p0[0]);
  check('sosok=1 → 코스닥 목록', p1[0].name === '코스닥종목1', p1[0]);
  check('sosok 생략 → 코스피(기본)', (await fetchMarketCapPage(1))[0].name === '코스피종목1');

  console.log('\nmarket 파라미터별 유니버스');
  const uKospi = await fetchMarketCapUniverse(20, 'KOSPI');
  check('KOSPI만 20개, 전부 코스피', uKospi.length === 20 && uKospi.every(x => x.market === 'KOSPI'), uKospi.length);

  const uKosdaq = await fetchMarketCapUniverse(20, 'KOSDAQ');
  check('KOSDAQ만 20개, 전부 코스닥', uKosdaq.length === 20 && uKosdaq.every(x => x.market === 'KOSDAQ'), uKosdaq.length);

  const uAll = await fetchMarketCapUniverse(20, 'ALL');
  check('ALL은 20개(코스피10+코스닥10)로 섞임', uAll.length === 20, uAll.length);
  check('ALL 안에 코스피·코스닥 둘 다 있음',
    uAll.some(x => x.market === 'KOSPI') && uAll.some(x => x.market === 'KOSDAQ'), uAll.map(x => x.market));
  check('ALL 코스피 쪽은 상위 10개(1~10위)', uAll.filter(x => x.market === 'KOSPI').length === 10);
  check('ALL 코스닥 쪽도 10개', uAll.filter(x => x.market === 'KOSDAQ').length === 10);

  const uDefault = await fetchMarketCapUniverse(15);
  check('market 생략 → 기본 KOSPI', uDefault.every(x => x.market === 'KOSPI') && uDefault.length === 15);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
