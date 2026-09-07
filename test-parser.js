/**
 * 파서 동작 검증.
 * 실제 사이트에 나가지 않고, 표 구조만 모사한 픽스처로
 * "라벨로 행을 찾아 숫자를 뽑는" 로직이 맞는지 확인한다.
 */
process.env.PORT = '39999';

const FN_HTML = `<html><head><meta charset="utf-8"></head><body>
<h1 id="giName">삼성전자</h1>
<div>발행주식수 5,969,782,550 자기주식 1,247,509</div>
<table id="highlight_D_A">
<thead><tr><th>IFRS(연결)</th><th>2023/12</th><th>2024/12</th><th>2025/12</th><th>2026/12(E)</th></tr></thead>
<tbody>
<tr><th>매출액</th><td>2,589,355</td><td>3,008,709</td><td>3,204,410</td><td>3,510,000</td></tr>
<tr><th>자본총계</th><td>3,637,580</td><td>3,865,120</td><td>4,102,880</td><td>4,400,000</td></tr>
<tr><th>지배주주지분</th><td>3,456,290</td><td>3,672,410</td><td>3,901,550</td><td>4,180,000</td></tr>
<tr><th>ROE</th><td>4.14</td><td>9.87</td><td>12.35</td><td>14.20</td></tr>
<tr><th>BPS</th><td>52,002</td><td>55,241</td><td>58,690</td><td>62,800</td></tr>
</tbody></table></body></html>`;

const NV_HTML = `<html><head><meta charset="utf-8"></head><body>
<div class="wrap_company"><h2><a href="#">삼성전자</a></h2></div>
<p class="no_today"><em><span class="blind">78,900</span></em></p>
<table id="tab_con1"><tr><th>상장주식수</th><td>5,969,782,550</td></tr></table>
<table class="tb_type1_ifrs">
<thead><tr><th>주요재무정보</th><th>2023.12</th><th>2024.12</th><th>2025.12</th><th>2026.12(E)</th></tr></thead>
<tbody>
<tr><th>ROE(지배주주)</th><td>4.14</td><td>9.87</td><td>12.35</td><td>14.20</td></tr>
<tr><th>BPS(원)</th><td>52,002</td><td>55,241</td><td>58,690</td><td>62,800</td></tr>
</tbody></table></body></html>`;

global.fetch = async (url) => {
  const html = String(url).includes('fnguide') ? FN_HTML : NV_HTML;
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(html, 'utf8') };
};

const { fromNaver, fromFnGuide, toNum } = require('./server.js');

let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? '  OK  ' : '  FAIL') + '  ' + name + '  →  ' + JSON.stringify(got) + (ok ? '' : '   (기대: ' + JSON.stringify(want) + ')'));
}

(async () => {
  console.log('숫자 변환');
  eq('1,234', toNum('1,234'), 1234);
  eq('-5.6%', toNum('-5.6%'), -5.6);
  eq('(1,234)', toNum('(1,234)'), -1234);
  eq('빈값', toNum('-'), null);

  console.log('\nFnGuide 파싱');
  const f = await fromFnGuide('005930');
  eq('종목명', f.name, '삼성전자');
  eq('지배주주지분 (최근 연간, 억원)', f.equityEok, 3901550);
  eq('ROE 실적 3개 — (E) 제외', f.roeSeries, [4.14, 9.87, 12.35]);
  eq('발행주식수', f.shares, 5969782550);
  eq('자기주식', f.treasury, 1247509);

  console.log('\n네이버 파싱');
  const n = await fromNaver('005930');
  eq('종목명', n.name, '삼성전자');
  eq('현재가', n.price, 78900);
  eq('상장주식수', n.shares, 5969782550);
  eq('BPS', n.bps, 52002);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
