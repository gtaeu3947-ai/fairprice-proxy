/**
 * screenOne의 marginPct/thinMargin 경계값 로직을 직접 검증한다.
 * 유니버스 스캔 전체를 안 돌리고, screenOne 하나만 호출해서 확인한다.
 */
process.env.PORT = '39986';

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
function trendJson() {
  const rows = [];
  for (let i = 19; i >= 0; i--) {
    const d = new Date('2026-09-08T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    rows.push({
      itemCode: '000000', bizdate: d.toISOString().slice(0, 10).replace(/-/g, ''),
      closePrice: '10000', tradeVolume: '100000',
      organPureBuyQuant: '100', foreignerPureBuyQuant: '50', individualPureBuyQuant: '-150',
    });
  }
  return rows;
}

// kbasePct=4.64, regime='flat'(kAdj=0) → k=4.64%.
// roe=6% → margin=6-4.64=1.36%p (3%p 미만 → thinMargin=true)
// roe=15% → margin=15-4.64=10.36%p (thinMargin=false)
const SPEC = {
  '100001': { name: '얇은마진', equityEok: 10000, roe: 6, shares: 100000000, treasury: 0, price: 5000 },
  '100002': { name: '넉넉한마진', equityEok: 10000, roe: 15, shares: 100000000, treasury: 0, price: 5000 },
  // 경계값 바로 위/아래 확인: k+3.00%p, k+2.99%p
  '100003': { name: '경계값바로위', equityEok: 10000, roe: 4.64 + 3.01, shares: 100000000, treasury: 0, price: 5000 },
  '100004': { name: '경계값바로아래', equityEok: 10000, roe: 4.64 + 2.99, shares: 100000000, treasury: 0, price: 5000 },
};

global.fetch = async (url) => {
  const u = String(url);
  const html = (h) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(h, 'utf8') });
  const mCode = u.match(/code=A?(\d{6})/) || u.match(/\/detail\/(\d{6})\//);
  const code = mCode ? mCode[1] : null;
  const spec = code && SPEC[code];
  if (!spec) throw new Error('알 수 없는 코드: ' + u);
  if (u.includes('SVD_Main.asp')) return html(fnHtml(spec));
  if (u.includes('item/main.naver')) return html(nvHtml(spec));
  if (u.includes('stock.naver.com/api/domestic/detail')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(trendJson()) };
  }
  throw new Error('예상치 못한 URL: ' + u);
};

const { screenOne } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 0.02); }

(async () => {
  const opt = { kbasePct: 4.64, regime: 'flat', flowDays: 5 };

  const r1 = await screenOne({ code: '100001', name: '얇은마진' }, opt);
  check('얇은마진: marginPct ≈ 1.36', near(r1.marginPct, 1.36, 0.02), r1.marginPct);
  check('얇은마진: thinMargin=true', r1.thinMargin === true, r1);

  const r2 = await screenOne({ code: '100002', name: '넉넉한마진' }, opt);
  check('넉넉한마진: marginPct ≈ 10.36', near(r2.marginPct, 10.36, 0.02), r2.marginPct);
  check('넉넉한마진: thinMargin=false', r2.thinMargin === false, r2);

  const r3 = await screenOne({ code: '100003', name: '경계값바로위' }, opt);
  check('경계값(3.01%p): thinMargin=false', r3.thinMargin === false, r3.marginPct);

  const r4 = await screenOne({ code: '100004', name: '경계값바로아래' }, opt);
  check('경계값(2.99%p): thinMargin=true', r4.thinMargin === true, r4.marginPct);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
