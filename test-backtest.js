/**
 * 백테스트 엔진 검증.
 *
 * 이 도구는 조건식을 고르는 근거가 되므로, 계산이 틀리면 잘못된 조건을 고르게 된다.
 * 그래서 손으로 확인할 수 있는 작은 입력으로 매매 규칙 하나하나를 확인한다.
 *
 * 특히 조심한 지점:
 *   - 진입가는 신호 봉의 종가가 아니라 다음 봉 시가여야 한다(그 종가로는 살 수 없다).
 *   - 목표·손절이 같은 날 둘 다 닿으면 일봉만으로는 순서를 알 수 없다 → 손절로 센다.
 *   - 미래 봉을 미리 보지 않아야 한다(마지막 hold개 봉에서는 신호를 내면 안 된다).
 */
const assert = require('assert');
const BT = require('./backtest.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

/** 종가 배열로 일봉을 만든다. 고가·저가를 직접 지정할 수도 있다. */
function mkBars(closes, opts) {
  opts = opts || {};
  return closes.map((c, i) => ({
    date: '2026-' + String(Math.floor(i / 28) + 1).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0'),
    open: opts.open ? opts.open(i, c) : c,
    high: opts.high ? opts.high(i, c) : c * 1.005,
    low: opts.low ? opts.low(i, c) : c * 0.995,
    close: c,
    volume: opts.volume ? opts.volume(i) : 1000,
  }));
}

/** 항상 참인 조건 — 매매 규칙 자체를 시험할 때 쓴다. */
const ALWAYS = { label: 't', conditions: [{ key: 'T', indicator: 'close', type: 'above', level: 0 }] };

const OPT = { holdDays: 5, targetPct: 7, stopPct: 5, minPassCount: 1, warmupBars: 3 };

console.log('\n[1] 진입가는 다음 봉 시가');
{
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, { open: (i) => 101 });   // 종가 100, 시가 101
  const trades = BT.simulateOne(bars, ALWAYS, OPT);
  check('신호가 잡힘', trades.length > 0, trades.length);
  check('진입가가 다음 봉 시가(101)', trades[0].entry === 101, trades[0]);
  check('신호일과 진입일이 다르다', trades[0].date !== trades[0].entryDate, trades[0]);
}

console.log('\n[2] 목표가 도달');
{
  // 진입 후 셋째 날 고가가 +8% → 목표 7%에 닿는다
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, {
    open: () => 100,
    high: (i) => (i === 6 ? 108 : 100.5),
    low: () => 99.5,
  });
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4 });
  const t = trades.find(x => x.entryDate === bars[5].date);
  check('목표가로 청산', t && t.exitReason === 'target', t);
  check('수익률이 정확히 목표치', t && Math.abs(t.returnPct - 7) < 0.01, t);
  check('청산까지 걸린 봉 수가 기록됨', t && t.exitBars === 2, t);
}

console.log('\n[3] 손절 도달');
{
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, {
    open: () => 100,
    high: () => 100.5,
    low: (i) => (i === 6 ? 92 : 99.5),
  });
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4 });
  const t = trades.find(x => x.entryDate === bars[5].date);
  check('손절로 청산', t && t.exitReason === 'stop', t);
  check('손실이 정확히 손절폭', t && Math.abs(t.returnPct + 5) < 0.01, t);
}

console.log('\n[4] 같은 날 목표·손절 둘 다 닿으면 손절로 센다');
{
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, {
    open: () => 100,
    high: (i) => (i === 6 ? 110 : 100.5),
    low: (i) => (i === 6 ? 90 : 99.5),
  });
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4 });
  const t = trades.find(x => x.entryDate === bars[5].date);
  check('보수적으로 손절 처리', t && t.exitReason === 'stop', t);
}

console.log('\n[5] 아무 데도 안 닿으면 기간 만료로 종가 청산');
{
  const closes = Array(20).fill(100).map((v, i) => 100 + i * 0.2);
  const bars = mkBars(closes);
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4 });
  const t = trades[0];
  check('timeout으로 청산', t.exitReason === 'timeout', t);
  check('보유 봉 수가 지정한 기간과 같다', t.exitBars === OPT.holdDays, t);
}

console.log('\n[6] 미래를 미리 보지 않는다');
{
  const bars = mkBars(Array(20).fill(100));
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 3 });
  const lastIdx = bars.length - 1;
  const maxEntryIdx = bars.findIndex(b => b.date === trades[trades.length - 1].entryDate);
  check('마지막 보유기간만큼은 신호를 내지 않는다',
    maxEntryIdx <= lastIdx - OPT.holdDays, { maxEntryIdx, lastIdx, hold: OPT.holdDays });
  check('워밍업 구간에서는 신호가 없다',
    bars.findIndex(b => b.date === trades[0].date) >= 3, trades[0]);
}

console.log('\n[7] 보유 중 최대 상승·하락폭');
{
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, {
    open: () => 100,
    high: (i) => (i === 6 ? 104 : 100.5),
    low: (i) => (i === 7 ? 97 : 99.5),
  });
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4 });
  const t = trades.find(x => x.entryDate === bars[5].date);
  check('최대 상승폭 +4%', t && Math.abs(t.mfePct - 4) < 0.01, t);
  check('최대 하락폭 -3%', t && Math.abs(t.maePct + 3) < 0.01, t);
}

console.log('\n[8] 조건이 실제로 신호를 걸러낸다');
{
  // 거래량이 20일 평균의 3배인 날에만 신호
  const closes = Array(60).fill(100);
  const spikeDays = [40, 50];
  const bars = mkBars(closes, { volume: (i) => (spikeDays.includes(i) ? 3000 : 1000) });
  const cfg = { conditions: [{ key: 'V', indicator: 'volumeRatio', params: { n: 20 }, type: 'above', level: 2.5 }] };
  const trades = BT.simulateOne(bars, cfg, { ...OPT, warmupBars: 25 });
  check('거래량 급증한 날에만 신호', trades.length === 2, trades.map(t => t.date));
  check('신호일이 실제 급증일과 일치',
    trades.every(t => spikeDays.some(d => bars[d].date === t.date)), trades.map(t => t.date));
}

console.log('\n[9] 요약 통계');
{
  const trades = [
    { returnPct: 7, buyHoldPct: 6, exitReason: 'target', exitBars: 3, mfePct: 8, maePct: -1, passCount: 3 },
    { returnPct: -5, buyHoldPct: -6, exitReason: 'stop', exitBars: 2, mfePct: 1, maePct: -6, passCount: 3 },
    { returnPct: 2, buyHoldPct: 2, exitReason: 'timeout', exitBars: 5, mfePct: 4, maePct: -2, passCount: 2 },
    { returnPct: 7, buyHoldPct: 9, exitReason: 'target', exitBars: 4, mfePct: 9, maePct: 0, passCount: 3 },
  ];
  const sum = BT.summarize(trades, [1, 1, 1, 1]);
  check('건수', sum.trades === 4, sum);
  check('승률 75%', sum.winRatePct === 75, sum.winRatePct);
  check('목표 도달률 50%', sum.targetHitRatePct === 50, sum.targetHitRatePct);
  check('손절률 25%', sum.stopHitRatePct === 25, sum.stopHitRatePct);
  check('평균 수익률', Math.abs(sum.avgReturnPct - 2.75) < 0.01, sum.avgReturnPct);
  check('벤치마크 대비 우위 계산',
    Math.abs(sum.edgeVsBenchmarkPct - (2.75 - 1)) < 0.01, sum.edgeVsBenchmarkPct);
  check('표본 30건 미만이면 경고', /표본 부족/.test(sum.reliability), sum.reliability);
}

console.log('\n[10] 학습 구간 / 검증 구간 분리');
{
  const trades = [
    { date: '2026-01-10', returnPct: 5 }, { date: '2026-02-10', returnPct: 5 },
    { date: '2026-07-10', returnPct: -3 }, { date: '2026-08-10', returnPct: -3 },
  ];
  const { train, test } = BT.splitByDate(trades, '2026-06-01');
  check('앞 구간 2건', train.length === 2, train);
  check('뒤 구간 2건', test.length === 2, test);
  check('경계일은 검증 구간에 포함', BT.splitByDate([{ date: '2026-06-01' }], '2026-06-01').test.length === 1);
}

console.log('\n[11] 벤치마크는 신호와 무관하게 전 구간에서 뽑는다');
{
  const bars = mkBars(Array(30).fill(100).map((v, i) => 100 + i));
  const bench = BT.benchmarkReturns(bars, { holdDays: 5, warmupBars: 3 });
  check('신호 수와 무관하게 표본이 많다', bench.length > 15, bench.length);
  check('상승 구간이므로 평균이 양수', BT.mean(bench) > 0, BT.mean(bench));
}

console.log('\n[12] 종목별 집계');
{
  const perStock = [
    { code: 'A', name: '가', trades: [
      { date: '2026-01-05', returnPct: 7, buyHoldPct: 7, exitReason: 'target', exitBars: 2, mfePct: 8, maePct: -1, passCount: 3 },
      { date: '2026-01-06', returnPct: 5, buyHoldPct: 5, exitReason: 'target', exitBars: 3, mfePct: 6, maePct: 0, passCount: 3 },
      { date: '2026-08-06', returnPct: 3, buyHoldPct: 3, exitReason: 'timeout', exitBars: 5, mfePct: 4, maePct: -1, passCount: 2 },
    ], benchmark: [1, 1, 1] },
    { code: 'B', name: '나', trades: [
      { date: '2026-01-07', returnPct: -5, buyHoldPct: -5, exitReason: 'stop', exitBars: 1, mfePct: 0, maePct: -6, passCount: 3 },
    ], benchmark: [1, 1] },
  ];
  const agg = BT.aggregate(perStock, { splitDate: '2026-06-01', holdDays: 5 });
  check('전체 4건', agg.overall.trades === 4, agg.overall);
  check('학습 구간 3건', agg.train.trades === 3, agg.train);
  check('검증 구간 1건', agg.test.trades === 1, agg.test);
  check('표본 3건 미만 종목은 종목별 표에서 제외',
    agg.bestStocks.every(s => s.code !== 'B'), agg.bestStocks);
  check('조건 충족 개수별 성적이 갈린다', agg.byPassCount.length === 2, agg.byPassCount);
  check('첫 매매일·마지막 매매일 기록',
    agg.firstTradeDate === '2026-01-05' && agg.lastTradeDate === '2026-08-06', agg);
}

console.log('\n[13] 신호가 없으면 빈 결과를 낸다');
{
  const bars = mkBars(Array(30).fill(100));
  const cfg = { conditions: [{ key: 'X', indicator: 'close', type: 'above', level: 999999 }] };
  const trades = BT.simulateOne(bars, cfg, OPT);
  check('매매 0건', trades.length === 0, trades.length);
  check('요약이 터지지 않는다', BT.summarize([], []).trades === 0);
}


console.log('\n[14] 눌림목 진입');
{
  // 신호일 종가 100. 다음날 저가 96까지 밀린 뒤 반등하는 모양.
  const closes = Array(20).fill(100);
  const bars = mkBars(closes, {
    open: () => 100,
    high: () => 101,
    low: (i) => (i % 2 === 1 ? 96 : 99.5),
  });
  const t = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4, pullbackPct: 3, pullbackWaitBars: 3 })[0];
  check('지정가(97)에 체결', Math.abs(t.entry - 97) < 0.01, t);
  check('시가(100)가 아니다', t.entry !== 100, t);
  check('진입이 며칠 지연됐는지 기록', t.entryOffset >= 1, t);
}

console.log('\n[15] 눌림을 안 주면 진입하지 않는다');
{
  // 계속 오르기만 해서 -3%를 한 번도 안 찍는 경우
  const bars = mkBars(Array(20).fill(0).map((v, i) => 100 + i * 2), {
    low: (i, c) => c * 0.995,
  });
  const trades = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4, pullbackPct: 3, pullbackWaitBars: 3 });
  check('매매 0건', trades.length === 0, trades.length);
  check('못 산 신호 수가 기록됨', trades.missedEntries > 0, trades.missedEntries);
}

console.log('\n[16] 시가가 지정가보다 낮게 열리면 그 시가에 산다');
{
  const bars = mkBars(Array(20).fill(100), {
    open: (i) => (i % 2 === 1 ? 94 : 100),
    high: () => 101,
    low: (i) => (i % 2 === 1 ? 93 : 99.5),
  });
  const t = BT.simulateOne(bars, ALWAYS, { ...OPT, warmupBars: 4, pullbackPct: 3, pullbackWaitBars: 3 })[0];
  check('지정가 97이 아니라 시가 94에 체결', Math.abs(t.entry - 94) < 0.01, t);
}

console.log('\n[17] 진입률이 집계에 나온다');
{
  const perStock = [{
    code: 'A', name: '가',
    trades: Object.assign([
      { date: '2026-01-05', returnPct: 6, buyHoldPct: 6, exitReason: 'target', exitBars: 2, mfePct: 7, maePct: -1, passCount: 3, entryOffset: 2 },
      { date: '2026-01-06', returnPct: -3, buyHoldPct: -3, exitReason: 'stop', exitBars: 1, mfePct: 0, maePct: -4, passCount: 3, entryOffset: 1 },
    ], { missedEntries: 6 }),
    benchmark: [1, 1],
  }];
  const agg = BT.aggregate(perStock, { splitDate: '2026-06-01', holdDays: 5 });
  check('신호 총 8건', agg.signalTotal === 8, agg);
  check('못 산 신호 6건', agg.missedEntries === 6, agg);
  check('진입률 25%', agg.entryRatePct === 25, agg.entryRatePct);
  check('평균 진입 지연이 계산됨', agg.overall.avgEntryDelayBars === 1.5, agg.overall);
}

console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
process.exit(fail ? 1 : 0);
