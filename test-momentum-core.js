/**
 * 지표 계산과 조건 판정 엔진 검증.
 * 사이트에 나가지 않고, 손으로 계산할 수 있는 작은 입력으로 확인한다.
 *
 * 여기 쓰는 조건 정의는 이 테스트용으로 지어낸 것이다 — 실제로 쓰는 조건식은
 * 저장소에 없고 서버 환경변수(MOMENTUM_CONDITIONS)에서만 읽는다.
 */
const assert = require('assert');
const M = require('./public/momentum-core.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= (tol == null ? 1e-6 : tol), `${a} ≠ ${b}`);

console.log('\n[1] 이동평균');
t('SMA(3)은 앞 2칸이 null이고 세 번째부터 평균', () => {
  const r = M.sma([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(r.slice(0, 2), [null, null]);
  near(r[2], 2); near(r[3], 3); near(r[4], 4);
});
t('EMA(3)은 첫 3개의 단순평균으로 시드를 잡는다', () => {
  const r = M.ema([1, 2, 3, 4], 3);
  near(r[2], 2);                     // (1+2+3)/3
  near(r[3], 4 * 0.5 + 2 * 0.5);     // k = 2/(3+1) = 0.5
});
t('창 안에 null이 있으면 SMA는 null', () => {
  assert.strictEqual(M.sma([1, null, 3, 4], 3)[2], null);
});

console.log('\n[2] CCI(20)');
t('완전 평탄한 시세는 편차가 0이라 CCI도 0', () => {
  const n = 30;
  const h = Array(n).fill(100), l = Array(n).fill(100), c = Array(n).fill(100);
  near(M.cci(h, l, c, 20)[29], 0);
});
t('직선 상승 구간에서는 CCI가 양수', () => {
  const n = 30;
  const c = Array.from({ length: n }, (_, i) => 100 + i);
  assert.ok(M.cci(c, c, c, 20)[29] > 0);
});
t('CCI 값이 손계산과 일치 (마지막 봉만 튀는 경우)', () => {
  // 20개 중 19개가 100, 마지막만 120.
  const c = [...Array(19).fill(100), 120];
  const v = M.cci(c, c, c, 20)[19];
  // SMA = (19*100 + 120)/20 = 101, MAD = (19*1 + 19)/20 = 1.9
  near(v, (120 - 101) / (0.015 * 1.9), 1e-6);
});

console.log('\n[3] MACD Osc(12,26,9)');
t('오실레이터 = MACD − 시그널', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = M.macd(c, 12, 26, 9);
  const i = 79;
  near(m.osc[i], m.line[i] - m.signal[i]);
});
t('26봉 미만 구간에서는 MACD가 null', () => {
  const c = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.strictEqual(M.macd(c, 12, 26, 9).line[20], null);
});
t('꾸준히 오르는 시세에서는 osc가 상승(1봉 연속상승 조건 충족)', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i));
  const m = M.macd(c, 12, 26, 9);
  assert.ok(m.osc[79] > m.osc[78]);
});

console.log('\n[4] OBV');
t('오른 날 거래량은 더하고 내린 날은 뺀다', () => {
  const c = [10, 11, 10, 10, 12];
  const v = [0, 100, 50, 70, 30];
  assert.deepStrictEqual(M.obv(c, v), [0, 100, 50, 50, 80]);
});
t('obvRatio는 9일 이동평균을 100으로 정규화한다', () => {
  // 계속 오르는 시세 → OBV가 단조증가 → 항상 자기 이동평균 위(=100 초과)
  const c = Array.from({ length: 40 }, (_, i) => 100 + i);
  const v = Array(40).fill(1000);
  const r = M.obvRatio(c, v, 9);
  assert.ok(r[39] > 100, String(r[39]));
});
t('이동평균이 음수인 구간에서도 방향성이 유지된다', () => {
  const c = Array.from({ length: 40 }, (_, i) => 100 - i); // 계속 하락 → OBV 음수
  const v = Array(40).fill(1000);
  const r = M.obvRatio(c, v, 9);
  assert.ok(r[39] < 100, String(r[39]));
});

console.log('\n[5] Williams %R(14)');
t('기간 최고가에서 마감하면 0, 최저가에서 마감하면 -100', () => {
  const h = [...Array(13).fill(110), 110];
  const l = [...Array(13).fill(90), 90];
  const cHigh = [...Array(13).fill(100), 110];
  const cLow = [...Array(13).fill(100), 90];
  near(M.williamsR(h, l, cHigh, 14)[13], 0);
  near(M.williamsR(h, l, cLow, 14)[13], -100);
});
t('중간값이면 -50', () => {
  const h = Array(14).fill(110), l = Array(14).fill(90), c = Array(14).fill(100);
  near(M.williamsR(h, l, c, 14)[13], -50);
});

console.log('\n[6] 조건 판정 타입');
const up = { type: 'crossUp', level: 100 };
t('crossUp은 아래에서 위로 뚫을 때만 true', () => {
  assert.strictEqual(M.testCondition([90, 110], 1, up), true);
  assert.strictEqual(M.testCondition([110, 120], 1, up), false); // 이미 위에 있었음
  assert.strictEqual(M.testCondition([110, 90], 1, up), false);  // 하향
  assert.strictEqual(M.testCondition([100, 110], 1, up), true);  // 걸쳐 있다가 돌파
});
t('above / below', () => {
  assert.strictEqual(M.testCondition([100], 0, { type: 'above', level: 100 }), true);
  assert.strictEqual(M.testCondition([99], 0, { type: 'above', level: 100 }), false);
  assert.strictEqual(M.testCondition([99], 0, { type: 'below', level: 100 }), true);
});
t('rising은 지정한 봉 수만큼 연속 상승해야 true', () => {
  assert.strictEqual(M.testCondition([1, 2, 3], 2, { type: 'rising' }), true);
  assert.strictEqual(M.testCondition([1, 3, 2], 2, { type: 'rising' }), false);
  assert.strictEqual(M.testCondition([3, 1, 2], 2, { type: 'rising', bars: 2 }), false);
  assert.strictEqual(M.testCondition([1, 2, 3], 2, { type: 'rising', bars: 2 }), true);
});
t('crossDown / falling', () => {
  assert.strictEqual(M.testCondition([110, 90], 1, { type: 'crossDown', level: 100 }), true);
  assert.strictEqual(M.testCondition([3, 2, 1], 2, { type: 'falling', bars: 2 }), true);
});

console.log('\n[7] 조건 정의 기반 평가');

/** 합성 일봉 생성기. closeFn(i)로 종가를 만들고 고가·저가는 ±1%로 둔다. */
function mkBars(n, closeFn, vol) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    bars.push({
      date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
      open: c, high: c * 1.01, low: c * 0.99, close: c,
      volume: typeof vol === 'function' ? vol(i) : vol,
    });
  }
  return bars;
}

// 테스트용으로 지어낸 조건 정의 (실제 조건식 아님)
const CFG = {
  label: '테스트 조건',
  conditions: [
    { key: 'X', indicator: 'cci', params: { n: 20 }, type: 'crossUp', level: 100 },
    { key: 'Y', indicator: 'macdOsc', params: { fast: 12, slow: 26, signal: 9 }, type: 'rising', bars: 1 },
    { key: 'Z', indicator: 'volumeRatio', params: { n: 20 }, type: 'above', level: 2 },
  ],
};

t('데이터가 모자라면 ok:false', () => {
  const r = M.evaluate(mkBars(10, i => 100 + i, 1000), CFG, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/부족/.test(r.reason));
});

t('조건 정의가 비어 있으면 판정 없이 참고지표만 낸다', () => {
  const r = M.evaluate(mkBars(80, i => 100 + i, 1000), null, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.condCount, 0);
  assert.strictEqual(r.strict, false);
  assert.ok(r.ret5 != null && r.volumeRatio != null);
});

t('오래 눌렸다가 마지막 봉에 급등하면 X(CCI 돌파)가 켜진다', () => {
  const bars = mkBars(80, i => (i < 79 ? 100 - i * 0.3 : 100), 1000);
  const r = M.evaluate(bars, CFG, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conds.X, true, JSON.stringify(r.conds));
});

t('평탄한 시세에서는 돌파 조건이 안 켜진다', () => {
  const r = M.evaluate(mkBars(80, () => 100, 1000), CFG, {});
  assert.strictEqual(r.conds.X, false);
  assert.strictEqual(r.strict, false);
});

t('조건을 전부 만족하면 strict=true, passCount=조건 개수', () => {
  const bars = mkBars(80, i => (i < 79 ? 100 - i * 0.3 : 100), i => (i === 79 ? 5000 : 1000));
  const r = M.evaluate(bars, CFG, {});
  assert.strictEqual(r.passCount, 3, JSON.stringify(r.conds));
  assert.strictEqual(r.strict, true);
  assert.strictEqual(r.condCount, 3);
});

t('조건별 현재값·직전값이 함께 나온다', () => {
  const r = M.evaluate(mkBars(80, i => 100 + i, 1000), CFG, {});
  assert.ok(r.values.X && typeof r.values.X.now === 'number');
  assert.ok(typeof r.values.X.prev === 'number');
});

t('모르는 지표를 쓰면 그 조건은 false이고 unknownIndicator로 알려준다', () => {
  const bad = { conditions: [{ key: 'Q', indicator: '없는지표', type: 'above', level: 1 }] };
  const r = M.evaluate(mkBars(80, () => 100, 1000), bad, {});
  assert.strictEqual(r.conds.Q, false);
  assert.strictEqual(r.unknownIndicator, '없는지표');
});

t('barsAgo=1이면 전일 봉 기준으로 평가한다', () => {
  const bars = mkBars(80, i => (i < 78 ? 100 - i * 0.3 : 100), 1000);
  const now = M.evaluate(bars, CFG, { barsAgo: 0 });
  const prev = M.evaluate(bars, CFG, { barsAgo: 1 });
  assert.strictEqual(prev.date, bars[78].date);
  assert.strictEqual(now.date, bars[79].date);
  assert.strictEqual(prev.conds.X, true);   // 급등이 일어난 봉
  assert.strictEqual(now.conds.X, false);   // 그 다음 봉은 이미 위에 있으므로 돌파 아님
});

t('거래량비율은 당일 ÷ 직전 20일 평균', () => {
  const bars = mkBars(80, i => 100 + i, i => (i === 79 ? 3000 : 1000));
  const r = M.evaluate(bars, CFG, {});
  near(r.volumeRatio, 3, 1e-9);
});

t('평균거래대금(억원)이 계산된다', () => {
  const bars = mkBars(80, () => 10000, 1000000); // 1만원 × 100만주 = 100억
  near(M.evaluate(bars, CFG, {}).avgTurnoverEok, 100, 1e-6);
});

t('5일·20일 수익률이 계산된다', () => {
  const bars = mkBars(80, i => 100 * Math.pow(1.01, i), 1000);
  const r = M.evaluate(bars, CFG, {});
  near(r.ret5, (Math.pow(1.01, 5) - 1) * 100, 1e-6);
  near(r.ret20, (Math.pow(1.01, 20) - 1) * 100, 1e-6);
});

console.log('\n[8] 백분위');
t('가장 작은 값은 0, 가장 큰 값은 1', () => {
  const p = M.percentileRanks([5, 1, 3]);
  near(p[1], 0); near(p[0], 1); near(p[2], 0.5);
});

console.log('\n' + pass + '개 통과' + (process.exitCode ? ' (실패 있음)' : ''));
