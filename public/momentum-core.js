/**
 * momentum-core.js — 일봉 기술적 지표 엔진.
 *
 * 이 파일에는 어떤 조건식도 들어 있지 않다. 지표를 계산하는 함수와,
 * "조건 정의(JSON)를 받아서 참/거짓을 판정하는" 범용 평가기만 있다.
 * 실제로 쓰는 조건 정의는 코드가 아니라 서버 환경변수(MOMENTUM_CONDITIONS)
 * 또는 gitignore된 conditions.local.json에서 읽는다 — 저장소가 공개돼도
 * 조건식 자체는 노출되지 않게 하려는 것이다.
 *
 * 조건 정의 형식:
 *   {
 *     "label": "표시할 이름",
 *     "conditions": [
 *       { "key":"A", "indicator":"<지표>", "params":{...}, "type":"<판정>", "level":<숫자>, "desc":"설명" },
 *       ...
 *     ]
 *   }
 *   전체 조건식은 나열된 조건의 AND로 본다(모두 참이면 strict=true).
 *
 * 지표(indicator): cci, macdOsc, macdLine, macdSignal, obv, obvRatio, wr,
 *                  close, volume, volumeRatio, ma, rsi
 * 판정(type):      crossUp, crossDown, above, below, rising, falling
 *                  (rising/falling은 bars로 연속 봉 수를 지정, 기본 1)
 *
 * UMD로 감싸 Node(server.js)·테스트·브라우저 어디서나 그대로 쓴다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.MomentumCore = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /* ───────────────────────── 기본 통계 ───────────────────────── */

  /** 단순이동평균. 창 안에 결측이 있거나 값이 모자라면 그 자리는 null. */
  function sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    if (!(n > 0)) return out;
    for (let i = n - 1; i < arr.length; i++) {
      let sum = 0, bad = false;
      for (let j = i - n + 1; j <= i; j++) {
        const v = arr[j];
        if (v == null || !isFinite(v)) { bad = true; break; }
        sum += v;
      }
      if (!bad) out[i] = sum / n;
    }
    return out;
  }

  /** 지수이동평균. 첫 n개의 단순평균으로 시드를 잡는 표준 방식. */
  function ema(arr, n) {
    const out = new Array(arr.length).fill(null);
    if (!(n > 0) || arr.length < n) return out;
    const k = 2 / (n + 1);
    let seed = 0;
    for (let i = 0; i < n; i++) seed += arr[i];
    out[n - 1] = seed / n;
    for (let i = n; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
    return out;
  }

  /* ───────────────────────── 지표 ───────────────────────── */

  /** CCI(n) = (TP − SMA(TP,n)) / (0.015 × 평균절대편차), TP=(고+저+종)/3 */
  function cci(highs, lows, closes, n) {
    n = n || 20;
    const len = closes.length;
    const tp = new Array(len);
    for (let i = 0; i < len; i++) tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
    const mid = sma(tp, n);
    const out = new Array(len).fill(null);
    for (let i = n - 1; i < len; i++) {
      if (mid[i] == null) continue;
      let mad = 0;
      for (let j = i - n + 1; j <= i; j++) mad += Math.abs(tp[j] - mid[i]);
      mad /= n;
      out[i] = mad === 0 ? 0 : (tp[i] - mid[i]) / (0.015 * mad);
    }
    return out;
  }

  /** MACD. osc(오실레이터) = MACD − Signal. */
  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);

    // 시그널은 MACD가 생긴 시점부터의 EMA — 앞의 null을 잘라내고 계산한 뒤 되돌린다.
    const start = line.findIndex(v => v != null);
    const sig = new Array(closes.length).fill(null);
    if (start >= 0) {
      const tail = line.slice(start);
      const se = ema(tail, signal);
      for (let i = 0; i < se.length; i++) sig[start + i] = se[i];
    }
    const osc = line.map((v, i) => (v == null || sig[i] == null) ? null : v - sig[i]);
    return { line, signal: sig, osc };
  }

  /** OBV: 종가가 오르면 거래량을 더하고, 내리면 뺀다(보합은 유지). */
  function obv(closes, volumes) {
    const out = new Array(closes.length).fill(null);
    if (!closes.length) return out;
    let acc = 0;
    out[0] = 0;
    for (let i = 1; i < closes.length; i++) {
      const v = volumes[i] || 0;
      if (closes[i] > closes[i - 1]) acc += v;
      else if (closes[i] < closes[i - 1]) acc -= v;
      out[i] = acc;
    }
    return out;
  }

  /**
   * OBV를 자기 n일 이동평균 대비 %로 정규화한다 (이동평균 = 100).
   * OBV는 거래량 누적값이라 절대 크기가 종목마다 제각각이어서, 그대로는
   * 종목 간 비교나 고정 임계값 비교가 불가능하다.
   * 이동평균이 0 이하인 구간(누적 매도 우위)에서는 비율의 부호가 뒤집히므로,
   * 이동평균과의 차이를 그 크기로 나눠 같은 방향성(위 = 100 초과)을 유지한다.
   */
  function obvRatio(closes, volumes, n) {
    const o = obv(closes, volumes);
    const m = sma(o, n || 9);
    return o.map((v, i) => {
      if (v == null || m[i] == null) return null;
      if (m[i] > 0) return (v / m[i]) * 100;
      return 100 * (1 + (v - m[i]) / Math.max(1, Math.abs(m[i])));
    });
  }

  /** Williams %R(n). 범위 −100(바닥) ~ 0(천장). */
  function williamsR(highs, lows, closes, n) {
    n = n || 14;
    const out = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      out[i] = (hh === ll) ? 0 : ((hh - closes[i]) / (hh - ll)) * -100;
    }
    return out;
  }

  /** RSI(n), Wilder 평활. */
  function rsi(closes, n) {
    n = n || 14;
    const out = new Array(closes.length).fill(null);
    if (closes.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + Math.max(0, d)) / n;
      loss = (loss * (n - 1) + Math.max(0, -d)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /** 기간 최고가 / 최저가 시계열. */
  function rollingHigh(highs, n) {
    const out = new Array(highs.length).fill(null);
    for (let i = n - 1; i < highs.length; i++) {
      let hh = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (highs[j] > hh) hh = highs[j];
      out[i] = hh;
    }
    return out;
  }
  function rollingLow(lows, n) {
    const out = new Array(lows.length).fill(null);
    for (let i = n - 1; i < lows.length; i++) {
      let ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) if (lows[j] < ll) ll = lows[j];
      out[i] = ll;
    }
    return out;
  }

  /**
   * 종가가 n일 이동평균의 몇 %인가. 100이면 이동평균과 같은 자리.
   * "지지선 위에 있는가"를 고정 숫자로 판정할 수 있게 하려고 비율로 만든다
   * (조건 정의는 level이 숫자 하나라서 지표끼리 직접 비교할 수 없다).
   */
  function closeVsMa(closes, n) {
    const m = sma(closes, n);
    return closes.map((c, i) => (m[i] == null || m[i] <= 0) ? null : (c / m[i]) * 100);
  }

  /** 종가가 최근 n일 최고가의 몇 %인가. 100 이상이면 그 구간 고점을 넘어섰다는 뜻. */
  function closeVsHigh(highs, closes, n) {
    const hh = rollingHigh(highs, n);
    return closes.map((c, i) => (hh[i] == null || hh[i] <= 0) ? null : (c / hh[i]) * 100);
  }

  /** 최근 n일 최고가 대비 낙폭(%). 음수. -20이면 고점에서 20% 빠진 자리. */
  function drawdownFromHigh(highs, closes, n) {
    const hh = rollingHigh(highs, n);
    return closes.map((c, i) => (hh[i] == null || hh[i] <= 0) ? null : (c / hh[i] - 1) * 100);
  }

  /** 전일 종가 대비 당일 등락률(%). 과열 배제용. */
  function dayChange(closes) {
    return closes.map((c, i) => (i === 0 || !(closes[i - 1] > 0)) ? null : (c / closes[i - 1] - 1) * 100);
  }

  /** ATR(n)을 종가 대비 %로. 손절폭 감각과 변동성 필터에 쓴다. */
  function atrPct(highs, lows, closes, n) {
    n = n || 14;
    const tr = closes.map((c, i) => {
      if (i === 0) return highs[i] - lows[i];
      const pc = closes[i - 1];
      return Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc));
    });
    const a = sma(tr, n);
    return closes.map((c, i) => (a[i] == null || !(c > 0)) ? null : (a[i] / c) * 100);
  }

  /**
   * 일목균형표(9, 26, 52).
   *   전환선 = 최근 9봉 (최고가+최저가)/2
   *   기준선 = 최근 26봉 (최고가+최저가)/2
   *   선행스팬1 = (전환선+기준선)/2 를 26봉 앞으로
   *   선행스팬2 = 최근 52봉 (최고가+최저가)/2 를 26봉 앞으로
   *
   * 여기서 내는 선행스팬은 "현재 봉 자리에 그려지는 구름"이다.
   * 즉 26봉 전에 계산된 값을 현재 인덱스에 놓는다 — 차트에서 눈으로 보는 그 구름과 같다.
   */
  function ichimoku(highs, lows, opt) {
    opt = opt || {};
    const p1 = opt.tenkan || 9, p2 = opt.kijun || 26, p3 = opt.span || 52;
    const shift = opt.shift || 26;
    const n = highs.length;
    const mid = (len) => {
      const out = new Array(n).fill(null);
      for (let i = len - 1; i < n; i++) {
        let hh = -Infinity, ll = Infinity;
        for (let j = i - len + 1; j <= i; j++) {
          if (highs[j] > hh) hh = highs[j];
          if (lows[j] < ll) ll = lows[j];
        }
        out[i] = (hh + ll) / 2;
      }
      return out;
    };
    const tenkan = mid(p1);
    const kijun = mid(p2);
    const base52 = mid(p3);

    const spanA = new Array(n).fill(null);
    const spanB = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const src = i - shift;
      if (src < 0) continue;
      if (tenkan[src] != null && kijun[src] != null) spanA[i] = (tenkan[src] + kijun[src]) / 2;
      if (base52[src] != null) spanB[i] = base52[src];
    }
    return { tenkan, kijun, spanA, spanB };
  }

  /** a ÷ b × 100. 100이면 같은 자리. 비율로 만들어야 고정 숫자와 비교할 수 있다. */
  function ratioTo(a, b) {
    return a.map((v, i) => (v == null || b[i] == null || b[i] <= 0) ? null : (v / b[i]) * 100);
  }

  /**
   * n봉 최고가가 몇 봉 전에 만들어졌는가. 0이면 오늘이 신고가.
   * "20봉 이내에 120봉 신고가 발생"은 이 값이 20 이하인지로 본다.
   */
  function newHighAge(highs, n) {
    const out = new Array(highs.length).fill(null);
    for (let i = n - 1; i < highs.length; i++) {
      let hh = -Infinity, at = i;
      for (let j = i - n + 1; j <= i; j++) {
        if (highs[j] >= hh) { hh = highs[j]; at = j; }
      }
      out[i] = i - at;
    }
    return out;
  }

  /** 최근 n봉 중 최대 거래대금(백만 단위). "20봉 이내 거래대금 500억 이상 1회"용. */
  function maxTurnoverInM(closes, volumes, n) {
    const t = closes.map((c, i) => (c || 0) * (volumes[i] || 0) / 1e6);
    const out = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let mx = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (t[j] > mx) mx = t[j];
      out[i] = mx;
    }
    return out;
  }

  /** 최근 n봉 중 전봉 대비 거래량 최대 비율(%). "전봉거래량대비 500% 이상 1회"용. */
  function maxVolumeSurgeIn(volumes, n) {
    const r = volumes.map((v, i) => (i === 0 || !(volumes[i - 1] > 0)) ? null : (v / volumes[i - 1]) * 100);
    const out = new Array(volumes.length).fill(null);
    for (let i = n; i < volumes.length; i++) {
      let mx = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (r[j] != null && r[j] > mx) mx = r[j];
      out[i] = mx === -Infinity ? null : mx;
    }
    return out;
  }

  /** 당일 거래량 ÷ 직전 n일 평균 거래량. */
  function volumeRatioSeries(volumes, n) {
    n = n || 20;
    const out = new Array(volumes.length).fill(null);
    for (let i = n; i < volumes.length; i++) {
      let sum = 0;
      for (let j = i - n; j < i; j++) sum += volumes[j] || 0;
      const avg = sum / n;
      out[i] = avg > 0 ? volumes[i] / avg : null;
    }
    return out;
  }

  /* ───────────────────────── 지표 레지스트리 ───────────────────────── */

  const INDICATORS = {
    cci:         (b, p) => cci(b.high, b.low, b.close, p.n),
    macdOsc:     (b, p) => macd(b.close, p.fast, p.slow, p.signal).osc,
    macdLine:    (b, p) => macd(b.close, p.fast, p.slow, p.signal).line,
    macdSignal:  (b, p) => macd(b.close, p.fast, p.slow, p.signal).signal,
    obv:         (b) => obv(b.close, b.volume),
    obvRatio:    (b, p) => obvRatio(b.close, b.volume, p.n),
    wr:          (b, p) => williamsR(b.high, b.low, b.close, p.n),
    rsi:         (b, p) => rsi(b.close, p.n),
    ma:          (b, p) => sma(b.close, p.n),
    close:       (b) => b.close.slice(),
    volume:      (b) => b.volume.slice(),
    volumeRatio: (b, p) => volumeRatioSeries(b.volume, p.n),
    closeVsMa:   (b, p) => closeVsMa(b.close, p.n || 20),
    closeVsHigh: (b, p) => closeVsHigh(b.high, b.close, p.n || 20),
    drawdown:    (b, p) => drawdownFromHigh(b.high, b.close, p.n || 60),
    dayChange:   (b) => dayChange(b.close),
    atrPct:      (b, p) => atrPct(b.high, b.low, b.close, p.n || 14),

    // ── 일목균형표 계열. 전부 "종가(또는 저가·시가) ÷ 선 × 100" 비율로 낸다.
    tenkan:      (b, p) => ichimoku(b.high, b.low, p).tenkan,
    kijun:       (b, p) => ichimoku(b.high, b.low, p).kijun,
    spanA:       (b, p) => ichimoku(b.high, b.low, p).spanA,
    spanB:       (b, p) => ichimoku(b.high, b.low, p).spanB,
    closeVsTenkan: (b, p) => ratioTo(b.close, ichimoku(b.high, b.low, p).tenkan),
    closeVsKijun:  (b, p) => ratioTo(b.close, ichimoku(b.high, b.low, p).kijun),
    lowVsKijun:    (b, p) => ratioTo(b.low, ichimoku(b.high, b.low, p).kijun),
    openVsKijun:   (b, p) => ratioTo(b.open || b.close, ichimoku(b.high, b.low, p).kijun),
    closeVsSpanA:  (b, p) => ratioTo(b.close, ichimoku(b.high, b.low, p).spanA),
    closeVsSpanB:  (b, p) => ratioTo(b.close, ichimoku(b.high, b.low, p).spanB),

    // ── 그 밖
    candleBody:    (b) => b.close.map((c, i) => (!(b.open[i] > 0)) ? null : (c / b.open[i]) * 100),
    newHighAge:    (b, p) => newHighAge(b.high, p.n || 120),
    maxTurnoverM:  (b, p) => maxTurnoverInM(b.close, b.volume, p.n || 20),
    maxVolumeSurge:(b, p) => maxVolumeSurgeIn(b.volume, p.n || 20),
  };

  /* ───────────────────────── 판정 ───────────────────────── */

  /**
   * 조건 하나를 판정한다.
   *
   * cond.offset  — "2봉전" 같은 과거 시점 판정. i에서 그만큼 뒤로 가서 본다.
   * cond.tol     — within 판정의 허용폭. "기준선 근접률 1% 이내"는 level:100, tol:1.
   */
  function testCondition(series, i0, cond) {
    const i = i0 - (cond.offset || 0);
    if (i < 0) return false;
    const now = series[i];
    if (now == null || !isFinite(now)) return false;
    const type = cond.type || 'above';
    const level = cond.level;
    const bars = Math.max(1, cond.bars || 1);

    if (type === 'above') return now >= level;
    if (type === 'below') return now <= level;
    // 근접: 목표값에서 tol 이내에 들어와 있는가 (기준선 근접률 1% 이내 등)
    if (type === 'within') return Math.abs(now - level) <= (cond.tol == null ? 1 : cond.tol);

    if (type === 'crossUp' || type === 'crossDown') {
      if (i < 1) return false;
      const prev = series[i - 1];
      if (prev == null || !isFinite(prev)) return false;
      return type === 'crossUp' ? (prev <= level && now > level)
                                : (prev >= level && now < level);
    }

    if (type === 'rising' || type === 'falling') {
      if (i < bars) return false;
      for (let k = 0; k < bars; k++) {
        const a = series[i - k], b = series[i - k - 1];
        if (a == null || b == null || !isFinite(a) || !isFinite(b)) return false;
        if (type === 'rising' ? !(a > b) : !(a < b)) return false;
      }
      return true;
    }
    return false;
  }

  /** 최근 n개의 평균 (idx 포함, 뒤로 n개). 데이터가 모자라면 있는 만큼. */
  function trailingMean(arr, idx, n) {
    const from = Math.max(0, idx - n + 1);
    let sum = 0, cnt = 0;
    for (let i = from; i <= idx; i++) {
      const v = arr[i];
      if (v == null || !isFinite(v)) continue;
      sum += v; cnt++;
    }
    return cnt ? sum / cnt : null;
  }

  /**
   * 일봉 배열과 조건 정의를 받아 각 조건의 참/거짓을 판정한다.
   *
   * @param bars   [{date, open, high, low, close, volume}] — 날짜 오름차순
   * @param config { conditions: [...] } — 비어 있으면 조건 판정 없이 참고지표만 낸다
   * @param opt    { barsAgo=0, minBars=60 }
   */
  function evaluate(bars, config, opt) {
    opt = opt || {};
    const barsAgo = opt.barsAgo || 0;
    const minBars = opt.minBars || 60;
    const conditions = (config && Array.isArray(config.conditions)) ? config.conditions : [];

    if (!Array.isArray(bars) || bars.length < minBars) {
      return { ok: false, reason: '일봉 데이터 부족 (' + (bars ? bars.length : 0) + '개)' };
    }
    const i = bars.length - 1 - barsAgo;
    if (i < 1) return { ok: false, reason: 'barsAgo가 데이터 범위를 벗어남' };

    const cols = {
      high: bars.map(b => b.high),
      low: bars.map(b => b.low),
      close: bars.map(b => b.close),
      volume: bars.map(b => b.volume || 0),
    };

    // 같은 지표·같은 파라미터는 한 번만 계산한다.
    const cacheMap = new Map();
    const seriesFor = (name, params) => {
      const key = name + ':' + JSON.stringify(params || {});
      if (cacheMap.has(key)) return cacheMap.get(key);
      const fn = INDICATORS[name];
      const s = fn ? fn(cols, params || {}) : null;
      cacheMap.set(key, s);
      return s;
    };

    const conds = {};
    const values = {};
    let unknown = null;

    /** 조건 하나 또는 any(OR) 묶음을 판정한다. */
    const run = (c) => {
      if (Array.isArray(c.any) && c.any.length) {
        // (B or C or D) 처럼 여럿 중 하나만 맞으면 되는 묶음
        return c.any.some(sub => {
          const s = seriesFor(sub.indicator, sub.params);
          if (!s) { unknown = unknown || sub.indicator; return false; }
          return testCondition(s, i, sub);
        });
      }
      const s = seriesFor(c.indicator, c.params);
      if (!s) { unknown = unknown || c.indicator; return false; }
      const at = i - (c.offset || 0);
      values[c.key] = {
        now: (s[at] == null) ? null : Math.round(s[at] * 100) / 100,
        prev: (at > 0 && s[at - 1] != null) ? Math.round(s[at - 1] * 100) / 100 : null,
      };
      return testCondition(s, i, c);
    };

    conditions.forEach(c => { conds[c.key] = run(c); });
    const keys = conditions.map(c => c.key);
    const passCount = keys.filter(k => conds[k]).length;

    // 참고 지표 (조건 정의와 무관하게 항상 계산)
    const vols = cols.volume, closes = cols.close;
    const avgVol20 = trailingMean(vols, i - 1, 20);
    const volumeRatio = (avgVol20 > 0) ? vols[i] / avgVol20 : null;
    const turnovers = bars.map(b => (b.close || 0) * (b.volume || 0));
    const avgTurnover20 = trailingMean(turnovers, i, 20);
    const ret = (k) => (i - k >= 0 && closes[i - k] > 0) ? (closes[i] / closes[i - k] - 1) * 100 : null;

    return {
      ok: true,
      date: bars[i].date,
      close: closes[i],
      conds, values,
      condKeys: keys,
      passCount,
      condCount: keys.length,
      strict: keys.length > 0 && passCount === keys.length,
      unknownIndicator: unknown,
      volumeRatio,
      avgTurnoverEok: avgTurnover20 == null ? null : avgTurnover20 / 1e8,
      ret1: ret(1), ret5: ret(5), ret20: ret(20),
      ma20: trailingMean(closes, i, 20),
      ma60: trailingMean(closes, i, 60),
    };
  }

  /** 값 배열 → 0~1 백분위. */
  function percentileRanks(values) {
    const n = values.length;
    if (n <= 1) return values.map(() => 1);
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const ranks = new Array(n);
    order.forEach((origIdx, pos) => { ranks[origIdx] = pos / (n - 1); });
    return ranks;
  }

  /**
   * 모든 봉에 대해 한 번에 조건을 판정한다.
   *
   * evaluate()를 봉마다 부르면 지표를 매번 다시 계산해서 O(n²)가 된다.
   * 백테스트는 봉 하나하나를 다 훑어야 하므로, 지표는 한 번만 만들고
   * 판정만 인덱스별로 돌린다.
   *
   * @returns { keys, pass: [bool[]], passCount: number[], strict: boolean[] }
   */
  function evaluateSeries(bars, config) {
    const conditions = (config && Array.isArray(config.conditions)) ? config.conditions : [];
    const n = bars.length;
    const cols = {
      high: bars.map(b => b.high), low: bars.map(b => b.low),
      close: bars.map(b => b.close), volume: bars.map(b => b.volume || 0),
    };
    const cache = new Map();
    const seriesFor = (name, params) => {
      const key = name + ':' + JSON.stringify(params || {});
      if (cache.has(key)) return cache.get(key);
      const fn = INDICATORS[name];
      const s = fn ? fn(cols, params || {}) : null;
      cache.set(key, s);
      return s;
    };

    const keys = conditions.map(c => c.key);
    // any(OR) 묶음은 하위 조건마다 시계열이 필요하다.
    const prepared = conditions.map(c => Array.isArray(c.any) && c.any.length
      ? { any: c.any.map(sub => ({ cond: sub, series: seriesFor(sub.indicator, sub.params) })) }
      : { cond: c, series: seriesFor(c.indicator, c.params) });

    const passCount = new Array(n).fill(0);
    const strict = new Array(n).fill(false);
    const perCond = {};
    keys.forEach(k => { perCond[k] = new Array(n).fill(false); });

    for (let i = 0; i < n; i++) {
      let cnt = 0;
      conditions.forEach((c, ci) => {
        const p = prepared[ci];
        const ok = p.any
          ? p.any.some(x => x.series ? testCondition(x.series, i, x.cond) : false)
          : (p.series ? testCondition(p.series, i, p.cond) : false);
        perCond[c.key][i] = ok;
        if (ok) cnt++;
      });
      passCount[i] = cnt;
      strict[i] = keys.length > 0 && cnt === keys.length;
    }
    return { keys, perCond, passCount, strict, seriesFor };
  }

  return {
    sma, ema, cci, macd, obv, obvRatio, williamsR, rsi, volumeRatioSeries,
    rollingHigh, rollingLow, closeVsMa, closeVsHigh, drawdownFromHigh, dayChange, atrPct,
    ichimoku, ratioTo, newHighAge, maxTurnoverInM, maxVolumeSurgeIn,
    INDICATORS, testCondition, evaluate, evaluateSeries, percentileRanks, trailingMean,
  };
});
