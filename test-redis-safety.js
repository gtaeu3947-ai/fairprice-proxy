/**
 * 실제로 겪은 사고 재현: UPSTASH_REDIS_REST_URL/TOKEN 값이 서로 바뀌어 들어가면서
 * (URL 자리에 토큰 모양 문자열이 들어감) runScreen() 전체가 크래시했었다.
 * 성과검증은 부가 기능이므로, Redis 설정이 뭘로 잘못돼 있든 스캔 결과 자체는
 * 항상 정상적으로 나와야 한다 — 이 파일은 그 보장을 검증한다.
 */
process.env.PORT = '39981';
// 실제로 발생했던 값 그대로 재현 (URL 자리에 토큰이, TOKEN 자리에 URL이 들어감)
process.env.UPSTASH_REDIS_REST_URL = 'gQAAAAAAUZoAAIgcDFkYjA2MzllYWRjZmM0NTIzYjgyMWJj';
process.env.UPSTASH_REDIS_REST_TOKEN = 'https://desired-lamb-83560.upstash.io';

const SPEC = { '100001': { name: 'A', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 7000 } };
function fnHtml(s) {
  return `<html><body><h1 id="giName">${s.name}</h1><div>발행주식수 ${s.shares} 자기주식 ${s.treasury}</div>
  <table id="highlight_D_A"><thead><tr><th>x</th><th>2024/12</th><th>2025/12</th><th>2026/12</th></tr></thead>
  <tbody><tr><th>지배주주지분</th><td>${s.equityEok}</td><td>${s.equityEok}</td><td>${s.equityEok}</td></tr>
  <tr><th>ROE</th><td>${s.roe}</td><td>${s.roe}</td><td>${s.roe}</td></tr></tbody></table></body></html>`;
}
function nvHtml(s) {
  return `<html><body><div class="wrap_company"><h2><a>${s.name}</a></h2></div>
  <p class="no_today"><em><span class="blind">${s.price}</span></em></p>
  <table id="tab_con1"><tr><th>상장주식수</th><td>${s.shares}</td></tr></table></body></html>`;
}
function trend() {
  const rows = [];
  for (let i = 19; i >= 0; i--) {
    const d = new Date('2026-09-08T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    rows.push({
      bizdate: d.toISOString().slice(0, 10).replace(/-/g, ''), tradeVolume: '100000',
      organPureBuyQuant: '100', foreignerPureBuyQuant: '50',
    });
  }
  return rows;
}

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });
  if (u.includes('sise_market_sum')) {
    const mPage = u.match(/page=(\d+)/); const page = mPage ? Number(mPage[1]) : 1;
    if (page > 1) return html('<html><body></body></html>');
    return html('<html><body><table><tr><td><a href="/item/main.naver?code=100001">A</a></td></tr></table></body></html>');
  }
  if (u.includes('SVD_Main.asp')) return html(fnHtml(SPEC['100001']));
  if (u.includes('item/main.naver')) return html(nvHtml(SPEC['100001']));
  if (u.includes('stock.naver.com/api/domestic/detail')) return { ok: true, status: 200, text: async () => JSON.stringify(trend()) };
  // Upstash로 향하는 요청이 혹시라도 나가면(hasRedis()가 걸러내지 못했다는 뜻) 바로 실패시켜서 잡아낸다.
  if (u.includes('upstash.io') || u.includes('gQAAAAAAUZo')) throw new Error('Upstash로 요청이 나가면 안 됩니다: ' + u);
  throw new Error('예상치 못한 URL: ' + u);
};

const { runScreen, hasRedis } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  check('URL/TOKEN이 뒤바뀐 값이면 hasRedis()=false', hasRedis() === false);

  let scanError = null, result = null;
  try {
    result = await runScreen({
      universeN: 10, market: 'KOSPI', regime: 'flat', kbasePct: 4.64,
      minGapPct: 0, minFlowStrength: -1, minVolumeRatio: 0, flowDays: 5,
      weightGap: 0.5, weightFlow: 0.3, weightVolume: 0.2,
    });
  } catch (e) { scanError = e; }

  check('Redis 설정이 잘못돼도 스캔 자체는 성공함(크래시 안 함)', scanError === null, scanError && scanError.message);
  check('결과도 정상적으로 나옴', !!result && result.passedCount === 1, result);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
