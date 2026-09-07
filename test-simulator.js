const { simulateStrategy } = require('./public/sim-core.js');

let fail = 0;
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
  else console.log('  OK    ' + name);
}

/* ── 1. 평탄한 가격, 전략 없음 → 손익 0 ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 100 },
    { date: '2026-01-06', close: 100 },
  ];
  const r = simulateStrategy(series, { initialAmount: 1000, down: {}, up: {} });
  check('평탄가격: 매수 1건만', r.buys.length === 1);
  check('평탄가격: 총투입 1000', close(r.totalInvested, 1000));
  check('평탄가격: 수익률 0%', close(r.returnPct, 0));
})();

/* ── 2. 하락 후 회복 — 물타기가 손실을 줄이거나 이득으로 바꾸는지 ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 89 },   // -11% → 10% 트리거 충족
    { date: '2026-01-06', close: 100 },
  ];
  const params = {
    initialAmount: 1000,
    baseRef: 'last',
    down: { enabled: true, triggerPct: 10, amount: 500, mult: 1, maxRounds: 3 },
    up: { enabled: false },
  };
  const r = simulateStrategy(series, params);
  check('물타기: 2건 매수 (최초+물타기1회)', r.buys.length === 2, JSON.stringify(r.buys));
  check('물타기: 총투입 1500', close(r.totalInvested, 1500));
  const expectedShares = 1000 / 100 + 500 / 89;
  check('물타기: 총수량', close(r.totalShares, expectedShares, 1e-4));
  check('물타기: 최종가치 = 수량×100', close(r.finalValue, expectedShares * 100, 1e-2));
  check('물타기: 수익률 > 0 (같은 가격에 끝나도 저가매수분 이득)', r.returnPct > 0, r.returnPct);
  check('물타기: lump 수익률은 0%에 가까움 (시작가=종료가)', close(r.lump.returnPct, 0, 1e-6), r.lump.returnPct);
})();

/* ── 3. 상승 후 하락 — 불타기 매수분이 손실에 노출되는지 ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 111 },  // +11% → 10% 트리거 충족
    { date: '2026-01-06', close: 90 },
  ];
  const params = {
    initialAmount: 1000,
    baseRef: 'last',
    down: { enabled: false },
    up: { enabled: true, triggerPct: 10, amount: 500, mult: 1, maxRounds: 3 },
  };
  const r = simulateStrategy(series, params);
  check('불타기: 2건 매수', r.buys.length === 2, JSON.stringify(r.buys));
  check('불타기: 두번째 매수가 111', close(r.buys[1].price, 111));
  const shares = 1000 / 100 + 500 / 111;
  check('불타기: 최종가치', close(r.finalValue, shares * 90, 1e-2));
  check('불타기: 손실(수익률<0)', r.returnPct < 0, r.returnPct);
})();

/* ── 4. 최초매수가 기준(grid) 모드 — 회차마다 임계값이 계단식으로 벌어지는지 ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 91 },   // -9%  → -10% 미달, 매수 안 함
    { date: '2026-01-06', close: 89 },   // -11% → 1회차(-10%) 충족
    { date: '2026-01-07', close: 82 },   // -18% → 2회차(-20%) 미달, 매수 안 함
    { date: '2026-01-08', close: 79 },   // -21% → 2회차(-20%) 충족
  ];
  const params = {
    initialAmount: 1000,
    baseRef: 'first',
    down: { enabled: true, triggerPct: 10, amount: 300, mult: 1, maxRounds: 5 },
    up: { enabled: false },
  };
  const r = simulateStrategy(series, params);
  check('그리드모드: 매수 3건 (최초+2회)', r.buys.length === 3, JSON.stringify(r.buys.map(b => b.price)));
  check('그리드모드: 91원에서는 매수 안함', !r.buys.some(b => b.price === 91));
  check('그리드모드: 82원에서는 매수 안함', !r.buys.some(b => b.price === 82));
  check('그리드모드: 89원 매수', r.buys.some(b => b.price === 89));
  check('그리드모드: 79원 매수', r.buys.some(b => b.price === 79));
})();

/* ── 5. 최대 회차 제한 ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 89 },
    { date: '2026-01-06', close: 79 },
    { date: '2026-01-07', close: 69 },
  ];
  const params = {
    initialAmount: 1000,
    baseRef: 'last',
    down: { enabled: true, triggerPct: 10, amount: 300, mult: 1, maxRounds: 1 },
    up: { enabled: false },
  };
  const r = simulateStrategy(series, params);
  check('최대회차: 물타기 1회로 제한 (총 2건)', r.buys.length === 2, JSON.stringify(r.buys.map(b => b.price)));
})();

/* ── 6. 증액 배수(mult) ── */
(function () {
  const series = [
    { date: '2026-01-02', close: 100 },
    { date: '2026-01-05', close: 89 },
    { date: '2026-01-06', close: 79 },
  ];
  const params = {
    initialAmount: 1000,
    baseRef: 'last',
    down: { enabled: true, triggerPct: 10, amount: 300, mult: 2, maxRounds: 3 },
    up: { enabled: false },
  };
  const r = simulateStrategy(series, params);
  check('증액배수: 1회차 300', close(r.buys[1].amount, 300));
  check('증액배수: 2회차 600 (300×2)', close(r.buys[2].amount, 600), r.buys[2].amount);
})();

/* ── 7. 예외: 빈 배열 ── */
(function () {
  let threw = false;
  try { simulateStrategy([], { initialAmount: 1000 }); } catch (e) { threw = true; }
  check('빈 시리즈는 예외를 던짐', threw);
})();

console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
process.exit(fail ? 1 : 0);
