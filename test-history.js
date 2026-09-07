/**
 * fetchNaverHistoryPage / fetchNaverHistory 검증.
 * 실제 사이트에 나가지 않고, "일별 시세" 페이지 표 구조를 모사한 픽스처로 확인한다.
 */
process.env.PORT = '39997';

function page(rows) {
  const trs = rows.map(([d, c]) =>
    `<tr><td class="date">${d}</td><td class="num">${c}</td><td class="num">0</td>` +
    `<td class="num">${c}</td><td class="num">${c}</td><td class="num">${c}</td><td class="num">1000</td></tr>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <table class="type2"><tr><th>날짜</th><th>종가</th><th>전일비</th><th>시가</th><th>고가</th><th>저가</th><th>거래량</th></tr>
    ${trs}
    </table></body></html>`;
}

// 페이지 1(최신) ~ 페이지 3(오래됨), 페이지당 5행, 4페이지째부터는 빈 페이지(상장 초기 도달)
const PAGES = {
  1: page([['2026.09.04', 78900], ['2026.09.03', 78200], ['2026.09.02', 77500], ['2026.09.01', 77000], ['2026.08.29', 76500]]),
  2: page([['2026.08.28', 76000], ['2026.08.27', 75500], ['2026.08.26', 75000], ['2026.08.25', 74500], ['2026.08.24', 74000]]),
  3: page([['2026.08.21', 73500], ['2026.08.20', 73000], ['2026.08.19', 72500], ['2026.08.18', 72000], ['2026.08.17', 71500]]),
  4: page([]),
  5: page([]),
  6: page([]),
};

global.fetch = async (url) => {
  const m = String(url).match(/page=(\d+)/);
  const p = m ? Number(m[1]) : 1;
  const html = PAGES[p] || page([]);
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(html, 'utf8') };
};

const { fetchNaverHistoryPage, fetchNaverHistory } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('단일 페이지 파싱');
  const p1 = await fetchNaverHistoryPage('005930', 1);
  check('5행 파싱됨', p1.length === 5, p1.length);
  check('날짜 형식 변환 (2026.09.04 → 2026-09-04)', p1[0].date === '2026-09-04', p1[0]);
  check('종가 숫자 변환', p1[0].close === 78900, p1[0]);

  console.log('\n기간 지정 수집 (2026-08-20까지)');
  const series = await fetchNaverHistory('005930', '2026-08-20');
  check('중복 없이 날짜 오름차순', series.every((r, i) => i === 0 || r.date > series[i - 1].date), series.map(r => r.date));
  check('요청한 시작일 이전 데이터는 제외 (08-19, 08-17 없어야 함)',
    !series.some(r => r.date < '2026-08-20'), series.map(r => r.date));
  check('가장 이른 날짜가 08-20', series[0].date === '2026-08-20', series[0]);
  check('가장 최근 날짜가 09-04', series[series.length - 1].date === '2026-09-04', series[series.length - 1]);
  check('총 12개 거래일 (08-20 ~ 09-04)', series.length === 12, series.length);

  console.log('\n상장 초기(데이터 고갈) 처리 — 아주 이른 날짜를 요청해도 멈춰야 함');
  const early = await fetchNaverHistory('005930', '2000-01-01');
  check('있는 데이터만 반환 (15개)', early.length === 15, early.length);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
