/**
 * backtest.js — 조건식을 과거 데이터로 되돌려 검증한다.
 *
 * 만든 이유: 조건을 바꿔도 좋아졌는지 나빠졌는지 알 방법이 없었다.
 * 성과 검증 탭은 오늘부터 하루씩 쌓아야 해서 표본 20개에 몇 달이 걸린다.
 * 일봉은 이미 받아오고 있으니, 과거 봉을 전부 훑어 신호를 찾고 그 뒤 며칠이
 * 어땠는지 세면 같은 질문에 몇 분 만에 답할 수 있다.
 *
 * 진입·청산 규칙 (실제로 살 수 있는 가격만 쓴다):
 *   신호는 i봉 종가 기준으로 뜬다 → 진입은 i+1봉 시가.
 *   보유 기간 안에 목표가에 닿으면 목표가에 판 것으로, 손절가에 닿으면 손절가에 판 것으로 본다.
 *   둘 다 같은 날 닿으면 일봉만으로는 순서를 알 수 없으므로 손절로 센다(보수적).
 *   아무 데도 안 닿으면 마지막 봉 종가에 판다.
 *
 * 반드시 같이 봐야 할 것:
 *   - 벤치마크(아무 날이나 진입했을 때의 평균 수익률). 상승장에서는 아무거나 사도 오른다.
 *   - 표본 수. 신호 5개로 나온 승률 80%는 아무 의미가 없다.
 *   - 검증 구간 성적. 조건을 고를 때 쓴 구간에서 잘 나오는 건 당연하다.
 */

const MC = require('./public/momentum-core.js');

/** 값 배열의 중앙값. */
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

const r2 = (v) => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;

/**
 * 한 종목의 일봉에서 신호를 모두 찾아 매매 결과를 만든다.
 *
 * @param bars  [{date,open,high,low,close,volume}] 오름차순
 * @param config 조건 정의
 * @param opt   { holdDays, targetPct, stopPct, minPassCount, warmupBars }
 */
function simulateOne(bars, config, opt) {
  const hold = opt.holdDays;
  const warmup = opt.warmupBars ?? 80;
  const condCount = (config?.conditions || []).length;
  const minPass = Math.min(opt.minPassCount ?? condCount, condCount);

  const ev = MC.evaluateSeries(bars, config);
  const trades = [];

  // 진입은 i+1봉 시가, 청산은 최대 i+hold봉. 그래서 i는 끝에서 hold만큼 남겨둔다.
  for (let i = warmup; i < bars.length - hold - 1; i++) {
    if (condCount === 0 || ev.passCount[i] < minPass) continue;

    const entryBar = bars[i + 1];
    const entry = entryBar.open;
    if (!(entry > 0)) continue;

    const target = entry * (1 + opt.targetPct / 100);
    const stop = entry * (1 - opt.stopPct / 100);

    let exit = null, exitReason = null, exitBars = null;
    let mfe = 0, mae = 0;   // 보유 중 최대 상승폭 / 최대 하락폭 (%)

    for (let k = 0; k < hold; k++) {
      const b = bars[i + 1 + k];
      if (!b) break;
      mfe = Math.max(mfe, (b.high / entry - 1) * 100);
      mae = Math.min(mae, (b.low / entry - 1) * 100);

      const hitStop = b.low <= stop;
      const hitTarget = b.high >= target;
      if (hitStop) { exit = stop; exitReason = 'stop'; exitBars = k + 1; break; }   // 같은 날 둘 다면 손절로
      if (hitTarget) { exit = target; exitReason = 'target'; exitBars = k + 1; break; }
      if (k === hold - 1) { exit = b.close; exitReason = 'timeout'; exitBars = k + 1; }
    }
    if (exit == null) continue;

    trades.push({
      date: bars[i].date,
      entryDate: entryBar.date,
      entry: r2(entry),
      exit: r2(exit),
      returnPct: r2((exit / entry - 1) * 100),
      buyHoldPct: r2((bars[i + hold].close / entry - 1) * 100),
      exitReason, exitBars,
      mfePct: r2(mfe), maePct: r2(mae),
      passCount: ev.passCount[i],
      strict: ev.strict[i],
    });
  }
  return trades;
}

/**
 * 벤치마크: 같은 종목·같은 기간에서 "아무 날이나 진입했다면" 평균 얼마였나.
 * 신호가 실제로 의미가 있는지는 이 값과 비교해야만 알 수 있다.
 */
function benchmarkReturns(bars, opt) {
  const hold = opt.holdDays;
  const warmup = opt.warmupBars ?? 80;
  const out = [];
  for (let i = warmup; i < bars.length - hold - 1; i++) {
    const entry = bars[i + 1].open;
    if (!(entry > 0)) continue;
    out.push((bars[i + hold].close / entry - 1) * 100);
  }
  return out;
}

/** 매매 목록 → 요약 통계 */
function summarize(trades, benchmark) {
  if (!trades.length) {
    return { trades: 0, note: '신호 없음' };
  }
  const rets = trades.map(t => t.returnPct);
  const bh = trades.map(t => t.buyHoldPct);
  const wins = trades.filter(t => t.returnPct > 0).length;
  const target = trades.filter(t => t.exitReason === 'target').length;
  const stop = trades.filter(t => t.exitReason === 'stop').length;

  const avg = mean(rets);
  const benchAvg = benchmark && benchmark.length ? mean(benchmark) : null;

  return {
    trades: trades.length,
    // 규칙대로 목표·손절을 걸고 매매했을 때
    avgReturnPct: r2(avg),
    medianReturnPct: r2(median(rets)),
    winRatePct: r2((wins / trades.length) * 100),
    targetHitRatePct: r2((target / trades.length) * 100),
    stopHitRatePct: r2((stop / trades.length) * 100),
    timeoutRatePct: r2(((trades.length - target - stop) / trades.length) * 100),
    avgHoldBars: r2(mean(trades.map(t => t.exitBars))),
    // 목표·손절 없이 기간을 다 채웠다면
    avgBuyHoldPct: r2(mean(bh)),
    // 보유 중 최대 상승·하락폭 — "5~10% 먹을 자리가 있었나"를 본다
    avgMfePct: r2(mean(trades.map(t => t.mfePct))),
    avgMaePct: r2(mean(trades.map(t => t.maePct))),
    worstTradePct: r2(Math.min(...rets)),
    bestTradePct: r2(Math.max(...rets)),
    // 아무 날이나 진입했을 때와의 차이 — 이게 양수여야 신호에 의미가 있다
    benchmarkAvgPct: r2(benchAvg),
    edgeVsBenchmarkPct: (benchAvg == null) ? null : r2(mean(bh) - benchAvg),
    reliability: trades.length >= 30 ? 'ok' : '표본 부족 (30건 미만)',
  };
}

/**
 * 여러 종목의 결과를 학습 구간 / 검증 구간으로 갈라 집계한다.
 *
 * 조건을 고를 때 쓴 구간에서 성적이 좋은 건 당연하다. 뒤쪽 구간은 손대지 말고
 * 마지막에 한 번만 확인해야 "과거에만 맞는 조합"을 걸러낼 수 있다.
 */
function splitByDate(trades, splitDate) {
  const train = trades.filter(t => t.date < splitDate);
  const test = trades.filter(t => t.date >= splitDate);
  return { train, test };
}

/** 종목별 결과에서 전체 요약과 상위/하위 종목을 만든다. */
function aggregate(perStock, opt) {
  const allTrades = [];
  const allBench = [];
  perStock.forEach(s => {
    s.trades.forEach(t => allTrades.push({ ...t, code: s.code, name: s.name }));
    (s.benchmark || []).forEach(v => allBench.push(v));
  });
  allTrades.sort((a, b) => a.date.localeCompare(b.date));

  const { train, test } = splitByDate(allTrades, opt.splitDate);
  const benchSplit = opt.splitDate ? allBench : allBench;   // 벤치마크는 구간 구분 없이 전체 평균

  // 종목별 성적 (표본이 3건 이상인 것만)
  const byStock = perStock
    .filter(s => s.trades.length >= 3)
    .map(s => ({
      code: s.code, name: s.name,
      trades: s.trades.length,
      avgReturnPct: r2(mean(s.trades.map(t => t.returnPct))),
      winRatePct: r2((s.trades.filter(t => t.returnPct > 0).length / s.trades.length) * 100),
    }))
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct);

  // 조건 충족 개수별 성적 — 조건을 더 빡빡하게 거는 게 실제로 나은지 본다
  const byPassCount = {};
  allTrades.forEach(t => {
    const k = String(t.passCount);
    if (!byPassCount[k]) byPassCount[k] = [];
    byPassCount[k].push(t.returnPct);
  });
  const passCountTable = Object.entries(byPassCount)
    .map(([k, arr]) => ({
      passCount: Number(k), trades: arr.length,
      avgReturnPct: r2(mean(arr)),
      winRatePct: r2((arr.filter(v => v > 0).length / arr.length) * 100),
    }))
    .sort((a, b) => a.passCount - b.passCount);

  return {
    overall: summarize(allTrades, benchSplit),
    train: summarize(train, benchSplit),
    test: summarize(test, benchSplit),
    byPassCount: passCountTable,
    bestStocks: byStock.slice(0, 8),
    worstStocks: byStock.slice(-8).reverse(),
    sampleTrades: allTrades.slice(-25).reverse(),
    firstTradeDate: allTrades.length ? allTrades[0].date : null,
    lastTradeDate: allTrades.length ? allTrades[allTrades.length - 1].date : null,
  };
}

module.exports = { simulateOne, benchmarkReturns, summarize, splitByDate, aggregate, median, mean };
