/**
 * market='ALL'일 때 코스피·코스닥이 섞여서 한쪽이 TOP3를 싹쓸이하던 문제를 고쳤다.
 * 이제는 두 시장을 따로 랭킹해서 각각 TOP3(candidatesKospi/candidatesKosdaq)를 뽑고,
 * 성과검증용 기록(out.candidates)에는 둘을 합친 것(최대 6종목)이 들어간다.
 *
 * 시나리오: 코스피 3종목(전부 저평가), 코스닥 3종목(전부 저평가) — 코스피 쪽 점수가
 * 코스닥보다 전체적으로 훨씬 높게 설계했다. 예전 방식(합쳐서 랭킹)이었다면 코스닥은
 * TOP3에 하나도 못 들었을 상황이지만, 지금은 시장별로 따로 뽑히므로 둘 다 나와야 한다.
 */
process.env.PORT = '39979';

function fnHtml({ name, equityEok, roe, shares, treasury }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <h1 id="giName">${name}</h1>
  <div>발행주식수 ${shares.toLocaleString('en-US')} 자기주식 ${treasury.toLocaleString('en-US')}</div>
  <table id="highlight_D_A">
  <thead><tr><th>IFRS(연결)</th><th>2024/12</th><th>2025/12</th><th>2026/12</th></tr></thead>
  <tbody><tr><th>지배주주지분</th><td>${equityEok}</td><td>${equityEok}</td><td>${equityEok}</td></tr>
  <tr><th>ROE</th><td>${roe}</td><td>${roe}</td><td>${roe}</td></tr></tbody></table></body></html>`;
}
function nvHtml({ name, price, shares }) {
  return `<html><head><meta charset="utf-8"></head><body>
  <div class="wrap_company"><h2><a href="#">${name}</a></h2></div>
  <p class="no_today"><em><span class="blind">${price}</span></em></p>
  <table id="tab_con1"><tr><th>상장주식수</th><td>${shares.toLocaleString('en-US')}</td></tr></table>
  </body></html>`;
}
function trendJson(strength) {
  const rows = [];
  for (let i = 19; i >= 1; i--) {
    const d = new Date('2026-09-08T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    rows.push({
      itemCode: '000000', bizdate: d.toISOString().slice(0, 10).replace(/-/g, ''),
      closePrice: '10000', tradeVolume: '100000',
      organPureBuyQuant: '100', foreignerPureBuyQuant: '50', individualPureBuyQuant: '-150',
    });
  }
  rows.push({
    itemCode: '000000', bizdate: '20260908', closePrice: '10000',
    tradeVolume: String(strength.vol), organPureBuyQuant: String(strength.inst),
    foreignerPureBuyQuant: String(strength.foreign), individualPureBuyQuant: '0',
  });
  return rows;
}

// 코스피 3종목: 전부 강한 저평가+수급(점수가 높게 나오도록 설계)
// 코스닥 3종목: 저평가는 되지만 코스피보다 약한 수급(점수는 낮아도 여전히 저평가 상태이므로 pool에는 든다)
const SPEC = {
  '100001': { name: 'K1_코스피', market: 'KOSPI', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 7000, flow: { inst: 50000, foreign: 30000, vol: 800000 } },
  '100002': { name: 'K2_코스피', market: 'KOSPI', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 7500, flow: { inst: 40000, foreign: 25000, vol: 600000 } },
  '100003': { name: 'K3_코스피', market: 'KOSPI', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 8000, flow: { inst: 30000, foreign: 20000, vol: 500000 } },
  '200001': { name: 'D1_코스닥', market: 'KOSDAQ', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 9000, flow: { inst: 1000, foreign: 500, vol: 110000 } },
  '200002': { name: 'D2_코스닥', market: 'KOSDAQ', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 9500, flow: { inst: 800, foreign: 400, vol: 105000 } },
  '200003': { name: 'D3_코스닥', market: 'KOSDAQ', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 10000, flow: { inst: 500, foreign: 200, vol: 102000 } },
};

function marketCapPage(sosok) {
  const codes = Object.entries(SPEC).filter(([, s]) => (sosok === 1 ? s.market === 'KOSDAQ' : s.market === 'KOSPI'));
  const trs = codes.map(([code, s]) => `<tr><td><a href="/item/main.naver?code=${code}">${s.name}</a></td></tr>`).join('');
  return `<html><body><table>${trs}</table></body></html>`;
}

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });
  if (u.includes('sise_market_sum')) {
    const mSosok = u.match(/sosok=(\d)/); const sosok = mSosok ? Number(mSosok[1]) : 0;
    const mPage = u.match(/page=(\d+)/); const page = mPage ? Number(mPage[1]) : 1;
    if (page > 1) return html('<html><body></body></html>');
    return html(marketCapPage(sosok));
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

const { runScreen } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  const opt = {
    universeN: 20, market: 'ALL', regime: 'flat', kbasePct: 4.64,
    minGapPct: 0, minFlowStrength: -1, minVolumeRatio: 0, flowDays: 5,
    weightGap: 0.5, weightFlow: 0.3, weightVolume: 0.2,
  };
  const r = await runScreen(opt);

  console.log('candidatesKospi:', JSON.stringify(r.candidatesKospi.map(c => c.code)));
  console.log('candidatesKosdaq:', JSON.stringify(r.candidatesKosdaq.map(c => c.code)));
  console.log('candidates(합침):', JSON.stringify(r.candidates.map(c => c.code)));

  check('코스피 TOP3에 코스피 3종목 다 들어감', r.candidatesKospi.length === 3
    && r.candidatesKospi.every(c => c.market === 'KOSPI'), r.candidatesKospi);
  check('코스닥 TOP3에 코스닥 3종목 다 들어감(코스피 점수가 훨씬 높아도 안 밀려남)',
    r.candidatesKosdaq.length === 3 && r.candidatesKosdaq.every(c => c.market === 'KOSDAQ'), r.candidatesKosdaq);
  check('합친 candidates에 총 6종목(코스피3+코스닥3)', r.candidates.length === 6, r.candidates.length);
  check('합친 목록에 코스피·코스닥 둘 다 있음(예전엔 한쪽이 아예 빠질 수 있었음)',
    r.candidates.some(c => c.market === 'KOSPI') && r.candidates.some(c => c.market === 'KOSDAQ'));

  check('코스피 TOP3는 코스피 안에서 점수 내림차순 정렬됨',
    r.candidatesKospi[0].score >= r.candidatesKospi[1].score && r.candidatesKospi[1].score >= r.candidatesKospi[2].score);
  check('코스닥 TOP3도 코스닥 안에서 점수 내림차순 정렬됨',
    r.candidatesKosdaq[0].score >= r.candidatesKosdaq[1].score && r.candidatesKosdaq[1].score >= r.candidatesKosdaq[2].score);

  console.log('\n단일 시장(KOSPI만) 지정 시 기존처럼 candidatesKospi 필드는 안 생김');
  const r2 = await runScreen({ ...opt, market: 'KOSPI', universeN: 10 });
  check('market=KOSPI면 candidatesKospi 필드 없음(기존 동작 그대로)', r2.candidatesKospi === undefined);
  check('market=KOSPI면 candidates에 코스피만 3개', r2.candidates.length === 3 && r2.candidates.every(c => c.market === 'KOSPI'));

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
