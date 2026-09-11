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

/** 하위 p% 값. 최악 쪽 꼬리를 보려는 것. */
function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * a.length)));
  return a[idx];
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

  // 눌림목 진입: 신호 다음 봉 시가에 바로 사지 않고, 신호일 종가 대비 -pullbackPct를
  // 터치할 때까지 기다렸다가 그 가격에 산다. 기다리는 동안 안 밀리면 진입하지 않는다.
  // (실제 매매는 30분봉 일목 기준선까지 눌림을 기다렸다 사는 방식인데, 일봉으로는
  //  그 선을 그릴 수 없으므로 "종가 대비 몇 % 밀림"으로 근사한다.)
  const pullbackPct = opt.pullbackPct || 0;
  const pullbackWait = Math.max(1, opt.pullbackWaitBars || 3);
  let missedEntries = 0;   // 눌림을 안 줘서 못 산 신호 수

  // 진입은 i+1봉 시가, 청산은 최대 i+hold봉. 그래서 i는 끝에서 hold만큼 남겨둔다.
  const tailRoom = hold + 1 + (pullbackPct > 0 ? pullbackWait : 0);
  for (let i = warmup; i < bars.length - tailRoom; i++) {
    if (condCount === 0 || ev.passCount[i] < minPass) continue;

    let entryBar, entry, entryOffset;
    if (pullbackPct > 0) {
      // 신호일 종가에서 목표 눌림가를 잡고, 이후 pullbackWait봉 안에 저가가 닿는지 본다.
      const limit = bars[i].close * (1 - pullbackPct / 100);
      let found = -1;
      for (let k = 1; k <= pullbackWait; k++) {
        const b = bars[i + k];
        if (!b) break;
        if (b.low <= limit) { found = k; break; }
      }
      if (found < 0) { missedEntries++; continue; }
      entryOffset = found;
      entryBar = bars[i + found];
      // 시가가 이미 지정가보다 낮게 열렸으면 그 시가에 체결된다.
      entry = Math.min(limit, entryBar.open);
    } else {
      entryOffset = 1;
      entryBar = bars[i + 1];
      entry = entryBar.open;
    }
    if (!(entry > 0)) continue;

    /* ── 분할매수(물타기)
     *
     * 1차로 weight1만큼 사고, 진입가 대비 addDropPct만큼 더 빠지면 나머지를 더 산다.
     * 목표와 손절은 그때마다 "새 평단" 기준으로 다시 잡는다.
     *
     * 주의해서 볼 것: 이 방식은 백테스트에서 거의 항상 좋게 나온다. 손실을 확정하지
     * 않고 미루면 상승장에서는 대부분 회복되기 때문이다. 진짜 위험은 회복하지 못한
     * 소수 거래에 몰려 있으므로, 아래에서 최악의 거래와 "추가매수했는데 끝내 못 살아난"
     * 비율을 따로 기록한다. 평균만 보면 반드시 잘못 판단하게 된다.
     *
     * 수익률은 실제로 투입한 자금 기준이다. 2차까지 들어가면 자금이 두 배 들어가므로,
     * 1차만 들어간 거래와 같은 잣대로 비교하려면 가중평균이어야 한다.
     */
    const addOn = opt.addOnDropPct > 0;
    const w1 = addOn ? Math.min(0.95, Math.max(0.05, opt.firstWeight ?? 0.5)) : 1;
    const w2 = 1 - w1;
    const addPrice = addOn ? entry * (1 - opt.addOnDropPct / 100) : null;

    let avg = entry;          // 평단
    let invested = w1;        // 투입 비중 (1차만이면 w1, 추가매수 후 1)
    let addedAt = null;       // 추가매수한 봉 번호
    let target = avg * (1 + opt.targetPct / 100);
    let stop = avg * (1 - opt.stopPct / 100);

    let exit = null, exitReason = null, exitBars = null;
    let mfe = 0, mae = 0;   // 1차 진입가 대비 최대 상승·하락폭 (%)

    for (let k = 0; k < hold; k++) {
      const b = bars[i + entryOffset + k];
      if (!b) break;
      mfe = Math.max(mfe, (b.high / entry - 1) * 100);
      mae = Math.min(mae, (b.low / entry - 1) * 100);

      // 추가매수가 손절보다 먼저다. 손절선을 추가매수가보다 아래에 두는 게 전제.
      if (addOn && addedAt == null && b.low <= addPrice) {
        const fill = Math.min(addPrice, b.open);
        avg = (entry * w1 + fill * w2) / (w1 + w2);
        invested = 1;
        addedAt = k + 1;
        target = avg * (1 + opt.targetPct / 100);
        stop = avg * (1 - opt.stopPct / 100);
      }

      const hitStop = b.low <= stop;
      const hitTarget = b.high >= target;
      if (hitStop) { exit = stop; exitReason = 'stop'; exitBars = k + 1; break; }   // 같은 날 둘 다면 손절로
      if (hitTarget) { exit = target; exitReason = 'target'; exitBars = k + 1; break; }
      if (k === hold - 1) { exit = b.close; exitReason = 'timeout'; exitBars = k + 1; }
    }
    if (exit == null) continue;

    // 투입 자금 기준 수익률. 1차만 들어간 거래는 절반만 넣었으므로 그만큼만 반영된다.
    const priceReturn = (exit / avg - 1) * 100;
    const capitalReturn = priceReturn * invested;
    const endBar = bars[i + entryOffset + hold - 1] || bars[bars.length - 1];

    trades.push({
      date: bars[i].date,
      entryDate: entryBar.date,
      entry: r2(entry),
      avgPrice: r2(avg),
      exit: r2(exit),
      returnPct: r2(capitalReturn),
      priceReturnPct: r2(priceReturn),
      investedWeight: r2(invested),
      addedAt,                                  // null이면 추가매수 안 함
      addedButLost: addedAt != null && capitalReturn < 0,
      buyHoldPct: r2((endBar.close / entry - 1) * 100),
      entryOffset,
      exitReason, exitBars,
      mfePct: r2(mfe), maePct: r2(mae),
      passCount: ev.passCount[i],
      strict: ev.strict[i],
    });
  }
  trades.missedEntries = missedEntries;
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
    avgEntryDelayBars: r2(mean(trades.map(t => t.entryOffset).filter(v => v != null))),
    // 목표·손절 없이 기간을 다 채웠다면
    avgBuyHoldPct: r2(mean(bh)),
    // 보유 중 최대 상승·하락폭 — "5~10% 먹을 자리가 있었나"를 본다
    avgMfePct: r2(mean(trades.map(t => t.mfePct))),
    avgMaePct: r2(mean(trades.map(t => t.maePct))),
    worstTradePct: r2(Math.min(...rets)),
    bestTradePct: r2(Math.max(...rets)),
    // 평균만 보면 물타기를 과대평가하게 된다. 꼬리 쪽을 따로 본다.
    p10ReturnPct: r2(percentile(rets, 10)),
    lossOver10Pct: r2((rets.filter(v => v <= -10).length / trades.length) * 100),
    // 추가매수 통계
    addedRatePct: r2((trades.filter(t => t.addedAt != null).length / trades.length) * 100),
    addedLostRatePct: (() => {
      const added = trades.filter(t => t.addedAt != null);
      return added.length ? r2((added.filter(t => t.addedButLost).length / added.length) * 100) : null;
    })(),
    addedAvgReturnPct: (() => {
      const added = trades.filter(t => t.addedAt != null);
      return added.length ? r2(mean(added.map(t => t.returnPct))) : null;
    })(),
    noAddAvgReturnPct: (() => {
      const plain = trades.filter(t => t.addedAt == null);
      return plain.length ? r2(mean(plain.map(t => t.returnPct))) : null;
    })(),
    avgInvestedWeight: r2(mean(trades.map(t => t.investedWeight ?? 1))),
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
  let missedEntries = 0;
  perStock.forEach(s => {
    s.trades.forEach(t => allTrades.push({ ...t, code: s.code, name: s.name }));
    (s.benchmark || []).forEach(v => allBench.push(v));
    missedEntries += (s.trades.missedEntries || 0);
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
    // 눌림을 안 줘서 못 산 신호 수. "자주는 안 걸린다"가 여기서 숫자로 나온다.
    missedEntries,
    signalTotal: allTrades.length + missedEntries,
    entryRatePct: (allTrades.length + missedEntries) > 0
      ? r2((allTrades.length / (allTrades.length + missedEntries)) * 100) : null,
    firstTradeDate: allTrades.length ? allTrades[0].date : null,
    lastTradeDate: allTrades.length ? allTrades[allTrades.length - 1].date : null,
  };
}

module.exports = { simulateOne, benchmarkReturns, summarize, splitByDate, aggregate, median, mean, percentile };
