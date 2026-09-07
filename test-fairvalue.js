const { fairValue, gapPct } = require('./public/fairvalue-core.js');

let fail = 0;
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 0.5); }
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

// 이전 턴에서 검증된 예시값과 동일한 입력으로, 같은 결과가 나오는지 확인한다.
// (자기자본 20000억, ROE 12/14/15%, 기준요구수익률 10.80%, 발행주식 1억-자사주500만=9500만주)
const shares = 95000000;

const up = fairValue(20000, 12, 14, 15, 10.80, 'up', shares);
const flat = fairValue(20000, 12, 14, 15, 10.80, 'flat', shares);
const down = fairValue(20000, 12, 14, 15, 10.80, 'down', shares);

check('상승장 적정주가 ≈ 30,433원', close(up.fairPrice, 30433, 1), up.fairPrice);
check('횡보장 적정주가 ≈ 22,894원', close(flat.fairPrice, 22894, 1), flat.fairPrice);
check('하락장 적정주가 ≈ 21,380원', close(down.fairPrice, 21380, 1), down.fairPrice);

check('가중평균 ROE = (12+28+45)/6 = 14.1667', close(flat.roeW, 14.16666667, 1e-6), flat.roeW);
check('횡보 k = 10.80%', close(flat.k * 100, 10.80), flat.k * 100);
check('상승 k = 9.80% (10.80-1.0)', close(up.k * 100, 9.80), up.k * 100);
check('하락 k = 12.80% (10.80+2.0)', close(down.k * 100, 12.80), down.k * 100);

// 괴리율: 현재가가 적정주가보다 낮으면 음수(저평가)
check('현재가<적정가 → 음수(저평가)', gapPct(20000, flat.fairPrice) < 0, gapPct(20000, flat.fairPrice));
check('현재가>적정가 → 양수(고평가)', gapPct(30000, flat.fairPrice) > 0, gapPct(30000, flat.fairPrice));
check('가격/적정가 0 이하면 null', gapPct(0, 100) === null && gapPct(100, 0) === null);

// ROE < k 인 경우: 초과이익 음수, fairPrice가 자기자본보다 낮게 나옴 (계산은 되지만 경고 대상)
const lowRoe = fairValue(20000, 3, 3, 3, 12.80, 'flat', shares);
check('ROE<k: fairPrice는 계산되지만 값이 낮음', lowRoe.fairPrice != null && lowRoe.fairPrice < 20000 * 1e8 / shares);

console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
process.exit(fail ? 1 : 0);
