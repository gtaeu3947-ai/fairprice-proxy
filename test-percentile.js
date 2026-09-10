const { percentileRanks } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

console.log('percentileRanks 기본 동작');
check('오름차순 정렬된 값 -> 0~1 균등 분포', (() => {
  const r = percentileRanks([10, 20, 30, 40, 50]);
  return r[0] === 0 && r[4] === 1 && r[2] === 0.5;
})(), percentileRanks([10, 20, 30, 40, 50]));

check('입력 순서 뒤섞여도 원래 위치에 맞는 순위 반환', (() => {
  const r = percentileRanks([50, 10, 30]); // 50=최대(1), 10=최소(0), 30=중간(0.5)
  return r[0] === 1 && r[1] === 0 && r[2] === 0.5;
})(), percentileRanks([50, 10, 30]));

check('값이 1개면 1 반환 (비교 대상 없음)', percentileRanks([42])[0] === 1);
check('빈 배열 -> 빈 배열', percentileRanks([]).length === 0);

check('음수 포함해도 정상 동작', (() => {
  const r = percentileRanks([-5, 0, 5]);
  return r[0] === 0 && r[1] === 0.5 && r[2] === 1;
})(), percentileRanks([-5, 0, 5]));

check('동점 처리(순서상 하나가 우선되지만 0~1 범위는 유지)', (() => {
  const r = percentileRanks([10, 10, 20]);
  return r.every(x => x >= 0 && x <= 1);
})());

console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
process.exit(fail ? 1 : 0);
