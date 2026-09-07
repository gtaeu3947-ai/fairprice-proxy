/**
 * 스크리너에서 쓰는 적정주가(초과이익모델 방식) 계산.
 * public/index.html의 계산기와 완전히 같은 공식이다 — 국면(상승/횡보/하락)에 따라
 * 요구수익률 가산과 지속계수 w가 달라지는 부분까지 동일하게 맞췄다.
 *
 * UMD로 감싸 Node(server.js)와 테스트(require) 양쪽에서 그대로 쓴다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.FairValueCore = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // public/index.html의 "국면 설정" 기본값과 동일
  const REGIME = {
    up: { kAdj: -1.0, w: 1.0 },
    flat: { kAdj: 0.0, w: 0.8 },
    down: { kAdj: 2.0, w: 0.6 },
  };

  /**
   * equityEok   지배주주지분 자기자본 (억원)
   * roe3,roe2,roe1  3년 전 / 2년 전 / 전년도 ROE (%)
   * kbasePct    기준 요구수익률 (%, 신용등급 5년물 등)
   * regime      'up' | 'flat' | 'down'
   *
   * 반환: { roeW, k, w, fairPrice(주당, sharesOut 필요), value(기업가치, 억원) }
   * sharesOut(유통주식수, 발행-자사주)이 있어야 주당 적정주가까지 나온다 — 없으면 value(기업가치)만 반환.
   */
  function fairValue(equityEok, roe3, roe2, roe1, kbasePct, regime, sharesOut) {
    const r = REGIME[regime] || REGIME.flat;
    const roeW = (roe3 * 1 + roe2 * 2 + roe1 * 3) / 6;
    const k = kbasePct / 100 + r.kAdj / 100;
    const w = r.w;
    if (k <= 0 || w <= 0 || (1 + k - w) === 0) return { roeW, k, w, value: null, fairPrice: null };

    const B0 = equityEok * 1e8;
    const excess = B0 * (roeW / 100 - k);
    const value = B0 + excess * (w / (1 + k - w));
    const fairPrice = (sharesOut && sharesOut > 0) ? value / sharesOut : null;
    return { roeW, k, w, value: value / 1e8, fairPrice };
  }

  /** 현재가 대비 적정주가 괴리율 (%). 음수 = 저평가(현재가가 더 쌈). */
  function gapPct(price, fair) {
    if (!(price > 0) || !(fair > 0)) return null;
    return (price / fair - 1) * 100;
  }

  return { fairValue, gapPct, REGIME };
});
