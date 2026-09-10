/**
 * 시가총액 순위 수집이 실패했을 때의 동작 검증.
 *
 * 실제로 겪은 문제: 낮에는 잘 되다가 저녁에 "시가총액 순위를 가져오지 못했습니다"로
 * 스캔 전체가 죽었다. 원인은 .catch(() => []) 가 실패 이유를 통째로 삼켜서
 * 무엇이 막혔는지 알 수 없었던 것 + 한 번 실패하면 대안이 없었던 것.
 *
 * 여기서 확인하는 것:
 *   1) 일시적 실패는 재시도로 넘어간다
 *   2) 완전히 실패하면 마지막 성공 목록으로 대체하고 stale 표시를 남긴다
 *   3) 대체할 것도 없으면 실패 사유(HTTP 상태 등)가 에러 메시지에 그대로 들어간다
 *   4) 코스피/코스닥 중 한쪽만 죽으면 다른 쪽으로 스캔은 계속된다
 */
process.env.PORT = '39993';

let mode = 'ok';          // ok | flaky | dead | kospiDead
let attempts = 0;

function sumHtml(codes) {
  return '<html><head><meta charset="utf-8"></head><body><table>'
    + codes.map(c => `<tr><td><a href="/item/main.naver?code=${c}">종목${c}</a></td></tr>`).join('')
    + '</table></body></html>';
}

global.fetch = async (url) => {
  const u = String(url);
  if (!u.includes('sise_market_sum')) throw new Error('이 테스트는 시가총액 페이지만 다룹니다: ' + u);
  const sosok = Number((u.match(/sosok=(\d)/) || [])[1] || 0);
  attempts++;

  if (mode === 'dead') return { ok: false, status: 503, arrayBuffer: async () => Buffer.alloc(0) };
  if (mode === 'kospiDead' && sosok === 0) {
    return { ok: false, status: 429, arrayBuffer: async () => Buffer.alloc(0) };
  }
  if (mode === 'flaky' && attempts <= 2) {
    return { ok: false, status: 502, arrayBuffer: async () => Buffer.alloc(0) };
  }
  const base = sosok === 1 ? 300000 : 100000;
  const codes = Array.from({ length: 5 }, (_, i) => String(base + i + 1));
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(sumHtml(codes), 'utf8') };
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('\n[1] 정상 수집');
  mode = 'ok';
  const good = await S.fetchMarketCapSingle(5, 0);
  check('코스피 5종목 수집', good.length === 5, good.length);
  check('stale 표시 없음', good.staleHours === undefined, good.staleHours);

  console.log('\n[2] 일시적 실패는 재시도로 회복');
  mode = 'flaky'; attempts = 0;
  const flaky = await S.fetchMarketCapSingle(5, 1);   // 캐시 키가 다르므로 실제로 요청이 나감
  check('두 번 실패한 뒤 세 번째에 성공', flaky.length === 5, { len: flaky.length, attempts });
  check('재시도가 실제로 일어남', attempts >= 3, attempts);

  console.log('\n[3] 완전 실패 → 마지막 성공 목록으로 대체');
  mode = 'dead';
  // 12시간 캐시를 우회하려고 같은 n으로 다시 부르되, 캐시가 살아 있으면 의미가 없으니
  // 캐시를 비우고 마지막 성공 목록만 남긴 상태를 만든다.
  S.__clearCaches();
  const stale = await S.fetchMarketCapSingle(5, 0);
  check('빈 결과 대신 예전 목록을 돌려줌', stale.length === 5, stale.length);
  check('stale 시간이 표시됨', typeof stale.staleHours === 'number', stale.staleHours);

  console.log('\n[4] 대체할 목록도 없으면 실패 사유가 에러에 남는다');
  S.__clearCaches(true);
  mode = 'dead';
  let msg = null;
  try { await S.fetchMarketCapSingle(5, 0); }
  catch (e) { msg = e.message; }
  check('에러가 던져짐', msg != null);
  check('HTTP 상태가 메시지에 포함됨', /503/.test(msg || ''), msg);
  check('어느 시장인지 메시지에 포함됨', /kospi/.test(msg || ''), msg);

  console.log('\n[5] 한쪽 시장만 죽으면 다른 쪽으로 계속');
  S.__clearCaches(true);
  mode = 'kospiDead';
  const mixed = await S.fetchMarketCapUniverse(10, 'ALL');
  check('코스닥 종목만으로 유니버스가 만들어짐', mixed.length === 5, mixed.length);
  check('전부 코스닥', mixed.every(x => x.market === 'KOSDAQ'), mixed.map(x => x.market));

  console.log('\n[6] 양쪽 다 죽으면 두 시장의 사유를 함께 알려준다');
  S.__clearCaches(true);
  mode = 'dead';
  let msg2 = null;
  try { await S.fetchMarketCapUniverse(10, 'ALL'); }
  catch (e) { msg2 = e.message; }
  check('코스피·코스닥 사유가 모두 들어감',
    /코스피/.test(msg2 || '') && /코스닥/.test(msg2 || ''), msg2);

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
