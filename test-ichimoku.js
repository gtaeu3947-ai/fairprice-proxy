/**
 * 일목균형표 지표와 확장된 조건 판정 검증.
 *
 * 널리 참고되는 조건검색식을 그대로 옮기려면 세 가지가 더 필요했다.
 *   1) 일목균형표 네 선 (전환선·기준선·선행스팬1·2)
 *   2) "기준선 근접률 1% 이내" 같은 근접 판정
 *   3) "(주가 or 저가 or 시가)" 처럼 여럿 중 하나만 맞으면 되는 묶음, 그리고 "2봉전" 판정
 *
 * 지표가 틀리면 백테스트 결론이 통째로 틀리므로, 손으로 계산할 수 있는 입력으로 확인한다.
 */
const assert = require('assert');
const M = require('./public/momentum-core.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

console.log('\n[1] 일목균형표 — 손으로 계산되는 값');
{
  // 모든 봉의 고가 110, 저가 90 → 네 선 모두 중앙값 100이어야 한다.
  // 선행스팬2는 52봉 중앙값을 26봉 앞으로 미루므로 최소 77봉이 필요하다.
  const n = 90;
  const highs = Array(n).fill(110), lows = Array(n).fill(90);
  const ich = M.ichimoku(highs, lows, {});
  check('전환선 = (최고+최저)/2 = 100', near(ich.tenkan[89], 100), ich.tenkan[89]);
  check('기준선도 100', near(ich.kijun[89], 100), ich.kijun[89]);
  check('선행스팬1 = (전환+기준)/2 = 100', near(ich.spanA[89], 100), ich.spanA[89]);
  check('선행스팬2 = 52봉 중앙값 = 100', near(ich.spanB[89], 100), ich.spanB[89]);
  check('9봉 미만 구간의 전환선은 null', ich.tenkan[7] === null, ich.tenkan[7]);
  check('26봉 미만 구간의 기준선은 null', ich.kijun[24] === null, ich.kijun[24]);
  check('선행스팬2는 77봉 전에는 아직 없다', ich.spanB[70] === null, ich.spanB[70]);
}

console.log('\n[2] 전환선은 기준선보다 최근 움직임에 빠르게 반응한다');
{
  // 앞 40봉은 100 근처, 최근 9봉만 크게 올린다
  const n = 60;
  const highs = [], lows = [];
  for (let i = 0; i < n; i++) {
    const up = i >= n - 9;
    highs.push(up ? 150 : 110);
    lows.push(up ? 130 : 90);
  }
  const ich = M.ichimoku(highs, lows, {});
  check('전환선(140)이 기준선(120)보다 높다',
    ich.tenkan[59] > ich.kijun[59], { t: ich.tenkan[59], k: ich.kijun[59] });
  check('전환선 = (150+130)/2 = 140', near(ich.tenkan[59], 140), ich.tenkan[59]);
  check('기준선 = (150+90)/2 = 120', near(ich.kijun[59], 120), ich.kijun[59]);
}

console.log('\n[3] 선행스팬은 26봉 전 값이 현재 자리에 온다');
{
  // 앞 30봉 저가 50, 뒤 60봉 저가 90 → 현재 구름은 26봉 전 계산값이라 낮게 남아 있어야 한다
  const n = 90;
  const highs = Array(n).fill(110);
  const lows = highs.map((_, i) => (i < 30 ? 50 : 90));
  const ich = M.ichimoku(highs, lows, {});
  check('현재 선행스팬2가 현재 52봉 중앙값(100)보다 낮다',
    ich.spanB[89] < 100, ich.spanB[89]);
  check('26봉 전 자리의 값과 같다',
    near(ich.spanB[89], ((() => {
      let hh = -Infinity, ll = Infinity;
      for (let j = 63 - 52 + 1; j <= 63; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
      return (hh + ll) / 2;
    })())), ich.spanB[89]);
}

console.log('\n[4] 비율 지표 — 고정 숫자와 비교할 수 있게');
{
  const n = 60;
  const highs = Array(n).fill(110), lows = Array(n).fill(90);
  const closes = Array(n).fill(100);
  const cols = { high: highs, low: lows, close: closes, open: closes, volume: Array(n).fill(1000) };
  const r = M.INDICATORS.closeVsKijun(cols, {});
  check('종가가 기준선과 같으면 100', near(r[59], 100), r[59]);

  const closes2 = closes.slice(); closes2[59] = 101;
  const r2 = M.INDICATORS.closeVsKijun({ ...cols, close: closes2 }, {});
  check('종가가 기준선보다 1% 위면 101', near(r2[59], 101), r2[59]);
}

console.log('\n[5] within — "근접률 1% 이내"');
{
  const s = [100.5];
  check('0.5% 차이는 1% 이내', M.testCondition(s, 0, { type: 'within', level: 100, tol: 1 }) === true);
  check('1.5% 차이는 벗어남', M.testCondition([101.5], 0, { type: 'within', level: 100, tol: 1 }) === false);
  check('아래쪽으로 벗어나도 잡는다', M.testCondition([99.5], 0, { type: 'within', level: 100, tol: 1 }) === true);
  check('tol 미지정 시 기본 1', M.testCondition([100.9], 0, { type: 'within', level: 100 }) === true);
}

console.log('\n[6] offset — "2봉전" 판정');
{
  const s = [90, 95, 105, 110];
  check('2봉전(값 95)은 100 미만', M.testCondition(s, 3, { type: 'above', level: 100, offset: 2 }) === false);
  check('1봉전(값 105)은 100 이상', M.testCondition(s, 3, { type: 'above', level: 100, offset: 1 }) === true);
  check('범위를 벗어나면 false', M.testCondition(s, 1, { type: 'above', level: 0, offset: 5 }) === false);
}

console.log('\n[7] any — "(주가 or 저가 or 시가)" 묶음');
{
  const n = 60;
  const highs = Array(n).fill(110), lows = Array(n).fill(90);
  const closes = Array(n).fill(105);   // 종가는 기준선(100)에서 5% 위 → 단독으로는 근접 아님
  const lows2 = lows.slice(); lows2[59] = 100.5;  // 저가만 기준선 근처

  const bars = closes.map((c, i) => ({
    date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
    open: c, high: highs[i], low: lows2[i], close: c, volume: 1000,
  }));

  const cfgSingle = { conditions: [
    { key: 'K', indicator: 'closeVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
  ] };
  const cfgAny = { conditions: [
    { key: 'K', any: [
      { indicator: 'closeVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
      { indicator: 'lowVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
      { indicator: 'openVsKijun', params: {}, type: 'within', level: 100, tol: 1 },
    ] },
  ] };

  const a = M.evaluate(bars, cfgSingle, {});
  const b = M.evaluate(bars, cfgAny, {});
  check('종가만 보면 근접 아님', a.conds.K === false, a.conds);
  check('저가를 포함하면 근접으로 잡힘', b.conds.K === true, b.conds);

  // 전 구간 판정에서도 같아야 한다 (백테스트가 이 경로를 쓴다)
  const es = M.evaluateSeries(bars, cfgAny);
  check('evaluateSeries도 any를 처리', es.perCond.K[59] === true, es.perCond.K[59]);
  check('저가가 멀던 날은 false', es.perCond.K[58] === false, es.perCond.K[58]);
}

console.log('\n[8] 신고가 경과 봉수');
{
  const highs = Array(150).fill(100);
  highs[140] = 200;   // 140번 봉이 최고가
  const age = M.newHighAge(highs, 120);
  check('최고가로부터 9봉 지남', age[149] === 9, age[149]);
  check('그날 당일이면 0', age[140] === 0, age[140]);
  check('120봉 미만 구간은 null', age[100] === null, age[100]);
}

console.log('\n[9] 거래대금·거래량 급증 (20봉 이내 1회 이상)');
{
  const closes = Array(40).fill(10000);
  const vols = Array(40).fill(1000);
  vols[30] = 600000;                       // 이 날 거래대금 60억, 전봉 대비 60,000%
  const cols = { close: closes, volume: vols, high: closes, low: closes, open: closes };

  const t = M.INDICATORS.maxTurnoverM(cols, { n: 20 });
  check('20봉 내 최대 거래대금(백만) = 6000', near(t[39], 10000 * 600000 / 1e6), t[39]);
  check('그 봉이 창을 벗어나면 값이 떨어진다', t[39] > t[39 - 0] - 1 && M.INDICATORS.maxTurnoverM(cols, { n: 5 })[39] < 200, M.INDICATORS.maxTurnoverM(cols, { n: 5 })[39]);

  const v = M.INDICATORS.maxVolumeSurge(cols, { n: 20 });
  check('전봉 대비 최대 급증률이 500% 넘음', v[39] > 500, v[39]);
  check('급증이 없는 구간은 100 근처', near(M.INDICATORS.maxVolumeSurge(cols, { n: 5 })[25], 100, 1), M.INDICATORS.maxVolumeSurge(cols, { n: 5 })[25]);
}

console.log('\n[10] 양봉 판정');
{
  const bars = [
    { date: '2026-01-01', open: 100, high: 105, low: 99, close: 103, volume: 1 },
    { date: '2026-01-02', open: 103, high: 104, low: 98, close: 99, volume: 1 },
  ];
  const cols = {
    open: bars.map(b => b.open), high: bars.map(b => b.high),
    low: bars.map(b => b.low), close: bars.map(b => b.close), volume: bars.map(b => b.volume),
  };
  const body = M.INDICATORS.candleBody(cols, {});
  check('양봉은 100 초과', body[0] > 100, body[0]);
  check('음봉은 100 미만', body[1] < 100, body[1]);
}

console.log('\n[11] 원식 전체를 조합했을 때 동작하는가');
{
  // 구름 위 상승추세에서 기준선까지 눌린 모양을 만든다.
  const n = 300;
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = 100 * Math.pow(1.004, i);          // 꾸준한 상승 → 120·240선 상승
    if (i === n - 1) c = c * 0.93;             // 마지막 봉만 눌림
    const vol = (i === n - 12) ? 900000 : 1000;  // 20봉 이내 대량거래 1회
    bars.push({
      date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
      open: c, high: c * 1.01, low: c * 0.99, close: c, volume: vol,
    });
  }
  const cfg = { conditions: [
    { key: 'A', indicator: 'closeVsTenkan', params: {}, type: 'above', level: 100, offset: 2 },
    { key: 'S1', indicator: 'closeVsSpanA', params: {}, type: 'above', level: 100 },
    { key: 'S2', indicator: 'closeVsSpanB', params: {}, type: 'above', level: 100 },
    { key: 'L', indicator: 'ma', params: { n: 120 }, type: 'rising', bars: 2 },
    { key: 'Q', indicator: 'newHighAge', params: { n: 120 }, type: 'below', level: 20 },
    { key: 'W', indicator: 'maxVolumeSurge', params: { n: 20 }, type: 'above', level: 500 },
  ] };
  const r = M.evaluate(bars, cfg, {});
  check('평가가 성립한다', r.ok === true, r.reason);
  check('2봉전 전환선 위 (상승 중이므로)', r.conds.A === true, r.conds);
  check('구름 위 (선행스팬은 26봉 전 값이라 낮다)', r.conds.S1 && r.conds.S2, r.conds);
  check('120일선 상승', r.conds.L === true, r.conds);
  check('20봉 이내 120봉 신고가', r.conds.Q === true, r.conds);
  check('20봉 이내 거래량 급증', r.conds.W === true, r.conds);
  check('조건별 값이 기록된다', r.values.A && typeof r.values.A.now === 'number', r.values.A);
}

console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
process.exit(fail ? 1 : 0);
