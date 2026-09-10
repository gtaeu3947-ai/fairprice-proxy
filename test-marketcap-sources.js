/**
 * 시가총액 순위 수집 경로 검증.
 *
 * 겪은 문제(2026-09): 네이버가 시가총액 페이지를 Next.js로 다시 만들면서
 * HTML에서 <a href="/item/main.naver?code="> 링크가 사라졌다. 앵커만 보던
 * 파서가 0개를 읽어 스캔 전체가 죽었다.
 *
 * 이제 세 경로(모바일 JSON API → 페이지 내장 JSON → 예전 앵커)를 순서대로
 * 시도한다. 여기서는 각 경로가 제대로 읽는지, 앞 경로가 죽으면 뒤로 넘어가는지,
 * 순위 순서가 보존되는지를 본다.
 */
process.env.PORT = '39992';

const SAMPLE = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '373220', name: 'LG에너지솔루션' },
  { code: '207940', name: '삼성바이오로직스' },
  { code: '005380', name: '현대차' },
];

/* ── 픽스처 ─────────────────────────────────────────────── */

// 1) 모바일 JSON API — 껍데기를 일부러 깊게 감싸서 재귀 탐색이 되는지 본다
function mobileApiJson() {
  return JSON.stringify({
    result: {
      pagination: { page: 1, totalCount: 900 },
      stocks: SAMPLE.map((s, i) => ({
        itemCode: s.code,
        stockName: s.name,
        closePrice: String(70000 - i * 1000),
        marketValue: String(4000000 - i * 100000),
      })),
    },
  });
}

// 2) Next.js 내장 JSON — 데이터가 JS 문자열 안에 이스케이프돼 실린다
function nextJsHtml() {
  const payload = SAMPLE.map(s =>
    `{\\"itemCode\\":\\"${s.code}\\",\\"stockName\\":\\"${s.name}\\",\\"closePrice\\":\\"70000\\"}`
  ).join(',');
  return '<!DOCTYPE html><html lang="ko" data-theme="light"><head><meta charSet="utf-8"/>'
    + '<link rel="stylesheet" href="https://ssl.pstatic.net/imgstock/fn/real/pc/_next/static/css/9349f3b462cc41d1.css"/>'
    + '</head><body><div id="__next"></div>'
    + `<script>self.__next_f.push([1,"7:[\\"$\\",\\"div\\",null,{\\"stocks\\":[${payload}]}]\\n"])</script>`
    + '</body></html>';
}

// 3) 예전 표 마크업
function legacyHtml() {
  return '<html><head><meta charset="utf-8"></head><body><table>'
    + SAMPLE.map(s => `<tr><td><a href="/item/main.naver?code=${s.code}">${s.name}</a></td></tr>`).join('')
    + '</table></body></html>';
}

/* ── 어떤 경로를 살려둘지 시나리오로 제어 ───────────────── */
let alive = { mobile: true, next: true, legacy: true };
let hits = { mobile: 0, page: 0 };

global.fetch = async (url) => {
  const u = String(url);
  const bad = { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
  const send = (t) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(t, 'utf8') });

  if (u.includes('m.stock.naver.com/api/stocks/marketValue')) {
    hits.mobile++;
    return alive.mobile ? send(mobileApiJson()) : bad;
  }
  if (u.includes('sise_market_sum')) {
    hits.page++;
    if (alive.next) return send(nextJsHtml());
    if (alive.legacy) return send(legacyHtml());
    return bad;
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}
const codesOf = (rows) => rows.map(r => r.code);

(async () => {
  console.log('\n[1] 파서 단위 — 모바일 JSON');
  const fromJson = S.collectStocksFromJson(JSON.parse(mobileApiJson()), [], new Set(), 0);
  check('깊게 감싼 JSON에서도 5종목을 찾아냄', fromJson.length === 5, fromJson.length);
  check('코드·종목명이 짝지어짐', fromJson[0].code === '005930' && fromJson[0].name === '삼성전자', fromJson[0]);
  check('시가총액 순서가 보존됨', codesOf(fromJson).join() === codesOf(SAMPLE).join(), codesOf(fromJson));
  check('가격 같은 숫자 필드를 종목명으로 오인하지 않음',
    fromJson.every(r => !/^\d+$/.test(r.name)), fromJson.map(r => r.name));

  console.log('\n[2] 파서 단위 — Next.js 내장 JSON (이번에 깨진 그 페이지)');
  const fromText = S.extractStocksFromText(nextJsHtml());
  check('이스케이프된 JSON에서 5종목을 뽑아냄', fromText.length === 5, fromText.length);
  check('종목명이 한글 그대로 나옴', fromText[1].name === 'SK하이닉스', fromText[1]);
  check('순서 보존', codesOf(fromText).join() === codesOf(SAMPLE).join(), codesOf(fromText));

  console.log('\n[3] 파서 단위 — 예전 앵커');
  const fromAnchor = S.extractStocksFromAnchors(legacyHtml());
  check('예전 마크업도 그대로 읽음', fromAnchor.length === 5, fromAnchor.length);
  check('새 페이지에서는 앵커 파서가 0개를 낸다(문제의 원인 재현)',
    S.extractStocksFromAnchors(nextJsHtml()).length === 0);

  console.log('\n[4] 경로 선택 — 모바일 API가 살아 있으면 그것을 쓴다');
  S.__clearCaches(true);
  alive = { mobile: true, next: true, legacy: true };
  hits = { mobile: 0, page: 0 };
  let rows = await S.fetchMarketCapPage(1, 0, 50);
  check('5종목 수집', rows.length === 5, rows.length);
  check('페이지 HTML은 받아오지도 않음', hits.page === 0, hits);

  console.log('\n[5] 모바일 API가 죽으면 페이지 내장 JSON으로 넘어간다');
  S.__clearCaches(true);
  alive = { mobile: false, next: true, legacy: true };
  hits = { mobile: 0, page: 0 };
  rows = await S.fetchMarketCapPage(1, 0, 50);
  check('여전히 5종목 수집', rows.length === 5, rows.length);
  check('모바일 API를 먼저 시도했음', hits.mobile > 0, hits);
  check('페이지로 넘어갔음', hits.page > 0, hits);

  console.log('\n[6] 둘 다 죽고 예전 페이지만 남아도 수집된다');
  S.__clearCaches(true);
  alive = { mobile: false, next: false, legacy: true };
  rows = await S.fetchMarketCapPage(1, 0, 50);
  check('앵커 경로로 5종목 수집', rows.length === 5, rows.length);

  console.log('\n[7] 전부 죽으면 경로별 실패 사유를 한 줄로 모아 던진다');
  S.__clearCaches(true);
  alive = { mobile: false, next: false, legacy: false };
  let msg = null;
  try { await S.fetchMarketCapPage(1, 0, 50); } catch (e) { msg = e.message; }
  check('에러가 던져짐', msg != null);
  check('세 경로가 모두 메시지에 들어감',
    /mobile-api/.test(msg || '') && /embedded-json/.test(msg || '') && /legacy-anchors/.test(msg || ''), msg);

  console.log('\n[8] 전체 유니버스 수집');
  S.__clearCaches(true);
  alive = { mobile: false, next: true, legacy: true };   // 이번에 실제로 벌어진 상황
  const uni = await S.fetchMarketCapUniverse(10, 'ALL');
  check('코스피·코스닥이 함께 수집됨',
    uni.some(x => x.market === 'KOSPI') && uni.some(x => x.market === 'KOSDAQ'),
    uni.map(x => x.market));
  check('종목명이 채워져 있음', uni.every(x => x.name && x.code), uni.slice(0, 2));

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
