/**
 * screenOne / runScreen 통합 검증 — 복합 스코어링(랭킹 기반) 버전.
 *
 * 예전 AND-게이트 방식(저평가·수급·거래량 세 조건을 전부 동시에 넘겨야 함)은
 * 실제로 "결과가 너무 안 나온다"는 문제가 있었다. 지금은 세 지표를 백분위로 바꿔
 * 가중합한 점수로 순위를 매기고, 절대 임계값은 선택적 사전 필터로만 쓴다.
 *
 * 이 테스트는 동점(tie)이 안 생기도록 종목마다 저평가폭·수급강도·거래량비율을
 * 전부 다르게 설계했다 — A가 세 지표 전부에서 확실히 1등이 되게 해서, 가중치가
 * 뭐든 A가 반드시 1순위가 되는지까지 확인한다.
 *
 * 실제 사이트 구조가 아니라 이 테스트에서 설계한 픽스처를 쓰므로,
 * 여기서 검증하는 것은 "회로가 맞게 연결됐는가"이지 "실제 사이트를 정확히 파싱하는가"가 아니다.
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

// 마지막(최근) 거래일만 종목별로 다르게, 나머지 19일은 전부 동일한 기준값으로 둔다.
// 이러면 flowStrength·volumeRatio가 종목마다 뚜렷하게 갈려서 동점이 안 생긴다.
function trendJson(lastDay) {
  const rows = [];
  for (let i = 19; i >= 1; i--) {
    const d = new Date('2026-08-29T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    rows.push({
      itemCode: '000000', bizdate: d.toISOString().slice(0, 10).replace(/-/g, ''),
      closePrice: '10000', tradeVolume: '100000',
      organPureBuyQuant: '100', foreignerPureBuyQuant: '50', individualPureBuyQuant: '-150',
    });
  }
  rows.push({
    itemCode: '000000', bizdate: '20260908', closePrice: '10000',
    tradeVolume: String(lastDay.vol),
    organPureBuyQuant: String(lastDay.inst), foreignerPureBuyQuant: String(lastDay.foreign),
    individualPureBuyQuant: '0',
  });
  return rows;
}

// 공통 스펙: 자기자본 10,000억, 발행주식 1억주, 자사주 0 → sharesOut=1억
// k=4.64%(AA), w=1.0(상승장) 일 때 fairPrice ≈ ? — 아래서 직접 계산해 fair 변수로 씀.
const SPEC = {
  '100001': { name: 'A_전지표1등', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0,
    price: 7000, flow: { inst: 50000, foreign: 30000, vol: 800000 } },
  '100002': { name: 'B_수급최악', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0,
    price: 7500, flow: { inst: -20000, foreign: -10000, vol: 50000 } },
  '100003': { name: 'C_고평가', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0,
    price: 16000, flow: { inst: 50000, foreign: 30000, vol: 800000 } },
  '100004': { name: 'D_저평가폭_얕음', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0,
    price: 10500, flow: { inst: 5000, foreign: 2000, vol: 150000 } },
  '100005': { name: 'E_ROE낮음', equityEok: 10000, roe: 2, shares: 100000000, treasury: 0,
    price: 5000, flow: { inst: 50000, foreign: 30000, vol: 800000 } },
  '100006': { name: 'G_중간', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0,
    price: 9000, flow: { inst: 20000, foreign: 10000, vol: 300000 } },
};

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });

  if (u.includes('sise_market_sum')) {
    const m = u.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    if (page > 1) return html('<html><body></body></html>');
    return html(`<html><body><table>${Object.entries(SPEC).map(([code, s]) =>
      `<tr><td><a href="/item/main.naver?code=${code}">${s.name}</a></td></tr>`).join('')}</table></body></html>`);
  }
  const mCode = u.match(/code=A?(\d{6})/) || u.match(/\/detail\/(\d{6})\//);
  const code = mCode ? mCode[1] : null;
  const spec = code && SPEC[code];
  if (!spec) throw new Error('알 수 없는 코드: ' + u);

  if (u.includes('SVD_Main.asp')) return html(fnHtml(spec));
  if (u.includes('item/main.naver')) return html(nvHtml(spec));
  if (u.includes('stock.naver.com/api/domestic/detail')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(trendJson(spec.flow)) };
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const { runScreen, fairValue } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 0.02); }

(async () => {
  // ── 시나리오 1: 절대 임계값 전부 끔(기본값) → 랭킹 모드 ──────────────
  const opt1 = {
    universeN: 6, regime: 'flat', kbasePct: 4.64,
    minGapPct: 0, minFlowStrength: -1, minVolumeRatio: 0, flowDays: 5,
    weightGap: 0.5, weightFlow: 0.3, weightVolume: 0.2,
  };
  const r1 = await runScreen(opt1);
  console.log('시나리오1(필터 꺼짐) funnel:', JSON.stringify(r1.funnel));
  console.log('시나리오1 candidates:', JSON.stringify(r1.candidates.map(c => ({ code: c.code, score: c.score, gapPct: c.gapPct }))));
  console.log('시나리오1 runnerUps:', JSON.stringify(r1.runnerUps.map(c => c.code)));

  check('유니버스 6개 수집', r1.universeSize === 6);
  check('ROE낮은 E는 스킵됨(consideredCount=5)', r1.consideredCount === 5, r1.consideredCount);
  check('고평가 C 제외하고 4개가 저평가로 잡힘', r1.funnel.undervalued === 4, r1.funnel);
  check('필터 꺼졌으니 저평가 4개 전부 pool에 들어감', r1.passedCount === 4, r1.passedCount);
  check('top3 = 3개, runnerUp = 1개', r1.candidates.length === 3 && r1.runnerUps.length === 1,
    { c: r1.candidates.length, r: r1.runnerUps.length });

  const codes1 = r1.candidates.map(c => c.code);
  check('1순위 = A (세 지표 전부 1등)', codes1[0] === '100001', codes1);
  check('2순위 = G', codes1[1] === '100006', codes1);
  check('3순위 = B (저평가폭은 있지만 수급·거래량 최악이라도 top3엔 듦)', codes1[2] === '100002', codes1);
  check('4위(runnerUp) = D (저평가폭이 제일 얕아서 밀림)', r1.runnerUps[0].code === '100004', r1.runnerUps);

  check('A 점수 ≈ 1.0 (모든 지표 최고)', near(r1.candidates[0].score, 1.0, 0.02), r1.candidates[0].score);
  check('marginPct 계산됨 (roeW 15% − k 4.64% ≈ 10.36%p)', near(r1.candidates[0].marginPct, 10.36, 0.05), r1.candidates[0].marginPct);
  check('여유폭 충분하니 thinMargin=false', r1.candidates.every(c => c.thinMargin === false), r1.candidates.map(c => c.thinMargin));
  check('점수는 내림차순 정렬됨', r1.candidates[0].score >= r1.candidates[1].score
    && r1.candidates[1].score >= r1.candidates[2].score, r1.candidates.map(c => c.score));
  check('C(고평가)는 candidates/runnerUps 어디에도 없음',
    !codes1.includes('100003') && !r1.runnerUps.some(x => x.code === '100003'));
  check('E(ROE낮음)도 어디에도 없음',
    !codes1.includes('100005') && !r1.runnerUps.some(x => x.code === '100005'));

  // ── 시나리오 2: 절대 임계값을 켜서(선택적 사전 필터) 예전처럼 좁히기 ──
  const opt2 = {
    universeN: 6, regime: 'flat', kbasePct: 4.64,
    minGapPct: 20, minFlowStrength: 0.03, minVolumeRatio: 1.05, flowDays: 5,
    weightGap: 0.5, weightFlow: 0.3, weightVolume: 0.2,
  };
  const r2 = await runScreen(opt2);
  console.log('\n시나리오2(필터 켜짐) funnel:', JSON.stringify(r2.funnel));
  const codes2 = r2.candidates.map(c => c.code).sort();

  check('필터 켜면 A, G만 통과 (B·D는 수급강도 3% 미달)', JSON.stringify(codes2) === JSON.stringify(['100001', '100006']), codes2);
  check('runnerUps는 빔', r2.runnerUps.length === 0, r2.runnerUps.length);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
