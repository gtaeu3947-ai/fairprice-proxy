/**
 * 물타기·불타기 시뮬레이터 — 핵심 계산 로직.
 *
 * 브라우저(<script src="sim-core.js">)와 Node 테스트(require) 양쪽에서
 * 그대로 쓰기 위해 UMD 형태로 감싼다. DOM에 의존하는 코드는 없다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.SimCore = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /**
   * series: [{date:'YYYY-MM-DD', close:Number}, ...]  날짜 오름차순, 최소 1개.
   *
   * params:
   *   initialAmount   최초 매수금액 (원)
   *   baseRef         'last'  = 직전 매수가 대비 매번 재계산 (기본)
   *                   'first' = 최초 매수가 대비 누적 단계 (-10%, -20%, -30%… 그리드)
   *   down  { enabled, triggerPct, amount, mult, maxRounds }   하락 시 물타기
   *   up    { enabled, triggerPct, amount, mult, maxRounds }   상승 시 불타기
   *
   *   trigger는 %로 준다 (10 → 10%). amount는 1회 기준 매수금액이고,
   *   mult은 회차가 늘 때마다 곱해지는 배수다(1.0 = 매번 동일 금액,
   *   1.2 = 회차마다 20%씩 증액).
   */
  function simulateStrategy(series, params) {
    if (!Array.isArray(series) || series.length === 0) {
      throw new Error('가격 데이터가 없습니다.');
    }
    const p = normalize(params);
    const first = series[0];
    if (!(first.close > 0)) throw new Error('첫 거래일 종가가 올바르지 않습니다.');

    const buys = [{
      date: first.date, price: first.close, amount: p.initialAmount,
      shares: p.initialAmount / first.close, kind: '최초매수',
    }];

    let lastBuyPrice = first.close;
    const firstPrice = first.close;
    let downCount = 0, upCount = 0;

    for (let i = 1; i < series.length; i++) {
      const { date, close } = series[i];
      if (!(close > 0)) continue;

      let bought = false;

      if (p.down.enabled && downCount < p.down.maxRounds) {
        const trig = p.baseRef === 'first'
          ? firstPrice * (1 - p.down.triggerPct / 100 * (downCount + 1))
          : lastBuyPrice * (1 - p.down.triggerPct / 100);
        if (close <= trig) {
          const amount = p.down.amount * Math.pow(p.down.mult, downCount);
          buys.push({ date, price: close, amount, shares: amount / close, kind: '물타기' });
          lastBuyPrice = close;
          downCount++;
          bought = true;
        }
      }

      if (!bought && p.up.enabled && upCount < p.up.maxRounds) {
        const trig = p.baseRef === 'first'
          ? firstPrice * (1 + p.up.triggerPct / 100 * (upCount + 1))
          : lastBuyPrice * (1 + p.up.triggerPct / 100);
        if (close >= trig) {
          const amount = p.up.amount * Math.pow(p.up.mult, upCount);
          buys.push({ date, price: close, amount, shares: amount / close, kind: '불타기' });
          lastBuyPrice = close;
          upCount++;
        }
      }
    }

    const totalInvested = sum(buys.map(b => b.amount));
    const totalShares = sum(buys.map(b => b.shares));
    const avgCost = totalInvested / totalShares;
    const last = series[series.length - 1];
    const finalValue = totalShares * last.close;
    const profit = finalValue - totalInvested;
    const returnPct = (finalValue / totalInvested - 1) * 100;

    const lumpShares = totalInvested / firstPrice;
    const lumpValue = lumpShares * last.close;
    const lumpReturnPct = (lumpValue / totalInvested - 1) * 100;

    return {
      buys,
      totalInvested,
      totalShares,
      avgCost,
      finalDate: last.date,
      finalPrice: last.close,
      finalValue,
      profit,
      returnPct,
      lump: { value: lumpValue, returnPct: lumpReturnPct },
    };
  }

  function normalize(params) {
    const d = (params && params.down) || {};
    const u = (params && params.up) || {};
    return {
      initialAmount: Math.max(0, num(params && params.initialAmount)),
      baseRef: (params && params.baseRef === 'first') ? 'first' : 'last',
      down: {
        enabled: !!d.enabled,
        triggerPct: Math.max(0.01, num(d.triggerPct, 10)),
        amount: Math.max(0, num(d.amount)),
        mult: Math.max(0.01, num(d.mult, 1)),
        maxRounds: Math.max(0, Math.round(num(d.maxRounds, 0))),
      },
      up: {
        enabled: !!u.enabled,
        triggerPct: Math.max(0.01, num(u.triggerPct, 10)),
        amount: Math.max(0, num(u.amount)),
        mult: Math.max(0.01, num(u.mult, 1)),
        maxRounds: Math.max(0, Math.round(num(u.maxRounds, 0))),
      },
    };
  }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
  function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

  return { simulateStrategy };
});
