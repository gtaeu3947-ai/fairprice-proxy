/**
 * screenOne / runScreen 통합 검증.
 * 6개의 가상 종목(펀더멘털을 직접 설계)으로 유니버스를 구성해,
 * 저평가 필터·수급 필터·정렬·top3 슬라이싱이 의도대로 동작하는지 확인한다.
 *
 * 실제 사이트 구조가 아니라 이 테스트에서 설계한 픽스처를 쓰므로,
 * 여기서 검증하는 것은 "회로가 맞게 연결됐는가"이지 "실제 사이트를 정확히 파싱하는가"가 아니다.
 * 파싱 자체는 test-parser.js / test-screener-fetch.js에서 별도로 검증했다.
 */
process.env.PORT = '39995';

function fnHtml({ name, equityEok, roe, shares, treasury }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <h1 id="giName">${name}</h1>
  <div>발행주식수 ${shares.toLocaleString('en-US')} 자기주식 ${treasury.toLocaleString('en-US')}</div>
  <table id="highlight_D_A">
  <thead><tr><th>IFRS(연결)</th><th>2024/12</th><th>2025/12</th><th>2026/12</th><th>2027/12(E)</th></tr></thead>
  <tbody>
  <tr><th>지배주주지분</th><td>${equityEok}</td><td>${equityEok}</td><td>${equityEok}</td><td>${equityEok}</td></tr>
  <tr><th>ROE</th><td>${roe}</td><td>${roe}</td><td>${roe}</td><td>${roe}</td></tr>
  </tbody></table></body></html>`;
}
function nvHtml({ name, price, shares }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <div class="wrap_company"><h2><a href="#">${name}</a></h2></div>
  <p class="no_today"><em><span class="blind">${price}</span></em></p>
  <table id="tab_con1"><tr><th>상장주식수</th><td>${shares.toLocaleString('en-US')}</td></tr></table>
  </body></html>`;
}
function flowHtml(strong) {
  const rows = [];
  for (let i = 19; i >= 0; i--) {
    const isLast = i === 0;
    rows.push({
      d: `26.08.${String(10 + (19 - i)).padStart(2, '0')}`,
      close: 10000,
      vol: (isLast && strong) ? 500000 : 100000,
      inst: (isLast && strong) ? 30000 : (strong ? 1000 : -500),
      frn: (isLast && strong) ? 20000 : (strong ? 500 : -200),
    });
  }
  const trs = rows.map(r =>
    `<tr><td>${r.d}</td><td>${r.close}</td><td>0</td><td>0.0%</td><td>${r.vol}</td><td>${r.inst}</td><td>${r.frn}</td><td>10%</td></tr>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <table class="type2">
      <tr><th>날짜</th><th>종가</th><th>전일비</th><th>등락률</th><th>거래량</th><th>기관 순매매량</th><th>외국인 순매매량</th><th>외국인 보유율</th></tr>
      ${trs}
    </table></body></html>`;
}
function marketCapPage(entries) {
  const trs = entries.map(([code, name], i) =>
    `<tr><td>${i + 1}</td><td><a href="/item/main.naver?code=${code}">${name}</a></td><td>1</td></tr>`
  ).join('');
  return `<html><body><table>${trs}</table></body></html>`;
}

// 공통 스펙: 자기자본 10,000억, 발행주식 1억주, 자사주 0 → sharesOut=1억
// k(요구수익률)=4.64%(AA, 기본값), w=0.8(횡보) 일 때 fairPrice ≈ 13,364원 (별도 계산, test-fairvalue.js와 동일 공식)
const SPEC = {
  '100001': { name: 'A_딥밸류_수급강함', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 8000, strongFlow: true },   // gap ≈ -40%, 통과 1순위
  '100002': { name: 'B_딥밸류_수급약함', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 8000, strongFlow: false },  // gap ≈ -40%, 수급 미달로 탈락
  '100003': { name: 'C_고평가_수급강함', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 16000, strongFlow: true },  // gap ≈ +20%, 저평가 아님 → 탈락
  '100004': { name: 'D_경계선저평가_수급강함', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 10000, strongFlow: true }, // gap ≈ -25%, 통과 3순위
  '100005': { name: 'E_ROE낮음', equityEok: 10000, roe: 2, shares: 100000000, treasury: 0, price: 5000, strongFlow: true },           // ROE<k → 스킵
  '100006': { name: 'G_중간저평가_수급강함', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 9300, strongFlow: true },   // gap ≈ -30%, 통과 2순위
};

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });

  if (u.includes('sise_market_sum')) {
    const m = u.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    if (page > 1) return html(marketCapPage([]));
    return html(marketCapPage(Object.entries(SPEC).map(([code, s]) => [code, s.name])));
  }
  const mCode = u.match(/code=A?(\d{6})/);
  const code = mCode ? mCode[1] : null;
  const spec = code && SPEC[code];
  if (!spec) throw new Error('알 수 없는 코드: ' + u);

  if (u.includes('SVD_Main.asp')) return html(fnHtml(spec));
  if (u.includes('item/main.naver')) return html(nvHtml(spec));
  if (u.includes('frgn.naver')) return html(flowHtml(spec.strongFlow));
  throw new Error('예상치 못한 URL: ' + u);
};

const { runScreen } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  const opt = {
    universeN: 6, regime: 'flat', kbasePct: 4.64,
    minGapPct: 20, minFlowStrength: 0.05, minVolumeRatio: 1.3, flowDays: 5,
  };
  const result = await runScreen(opt);

  console.log('스캔 결과 개요:', JSON.stringify({
    universeSize: result.universeSize, consideredCount: result.consideredCount,
    skippedCount: result.skippedCount, passedCount: result.passedCount,
  }));

  check('유니버스 6개 전부 수집', result.universeSize === 6, result.universeSize);
  check('ROE 낮은 종목 1개 스킵됨', result.skippedCount === 1, result.skippedCount);
  check('필터 통과 3개 (A, G, D)', result.passedCount === 3, result.passedCount);
  check('top3에 정확히 3개', result.candidates.length === 3, result.candidates.length);
  check('runnerUps는 빔 (통과 3개뿐이라)', result.runnerUps.length === 0, result.runnerUps.length);

  const codes = result.candidates.map(c => c.code);
  check('1순위 = A(가장 저평가)', codes[0] === '100001', codes);
  check('2순위 = G', codes[1] === '100006', codes);
  check('3순위 = D(경계선)', codes[2] === '100004', codes);

  check('B(수급약함)는 후보에 없음', !codes.includes('100002'));
  check('C(고평가)는 후보에 없음', !codes.includes('100003'));
  check('E(ROE낮음)는 후보에 없음', !codes.includes('100005'));

  check('1순위 gapPct가 가장 음수', result.candidates[0].gapPct < result.candidates[1].gapPct, result.candidates.map(c=>c.gapPct));
  check('적정주가가 약 13,364원대', Math.abs(result.candidates[0].fairPrice - 13364) < 5, result.candidates[0].fairPrice);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
