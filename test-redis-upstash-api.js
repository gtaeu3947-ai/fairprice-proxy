/**
 * 실제로 겪은 사고: 추천 기록(JSON 문자열)을 redisCmd('SET', key, value)로
 * URL 경로에 실어 보냈더니, 저장은 됐는데 불러오면 URL 인코딩된 문자열
 * 그대로 나와서 JSON.parse가 깨졌다. SET은 값을 요청 본문에 싣는
 * redisSetBody로 바꿨는데, 그게 실제로 왕복이 되는지 가짜 Upstash 서버로 확인한다.
 */
process.env.PORT = '39980';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

// 진짜 Upstash REST 서버처럼 동작하는 가짜 저장소.
// - GET  {url}/GET/{key}                 → 저장된 값을 그대로 반환 (path 방식)
// - POST {url}/SET/{key}  body=값         → 본문 그대로를 저장 (redisSetBody가 쓰는 방식)
// - GET  {url}/SADD/{key}/{member}        → path 방식 (짧은 값이라 문제 없음)
// - GET  {url}/SMEMBERS/{key}             → path 방식
const store = new Map();
const sets = new Map();

global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (!u.href.startsWith('https://fake-upstash.example.com')) throw new Error('알 수 없는 호스트: ' + u.href);
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const cmd = parts[0];

  if (opts && opts.method === 'POST' && cmd === 'SET') {
    const key = parts[1];
    // redisSetBody: 값은 경로가 아니라 요청 본문에 그대로 실려 온다.
    store.set(key, opts.body);
    return { ok: true, json: async () => ({ result: 'OK' }) };
  }
  if (cmd === 'GET') {
    const key = parts[1];
    return { ok: true, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
  }
  if (cmd === 'SADD') {
    const key = parts[1], member = parts[2];
    if (!sets.has(key)) sets.set(key, new Set());
    sets.get(key).add(member);
    return { ok: true, json: async () => ({ result: 1 }) };
  }
  if (cmd === 'SMEMBERS') {
    const key = parts[1];
    return { ok: true, json: async () => ({ result: sets.has(key) ? [...sets.get(key)] : [] }) };
  }
  throw new Error('예상치 못한 명령: ' + u.href);
};

const { recordRecommendation, getRecommendation, listRecommendationDates, hasRedis } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  check('정상적인 URL/TOKEN이면 hasRedis()=true', hasRedis() === true);

  // 실제로 문제가 됐던 것과 같은 모양: 중괄호·따옴표·콜론·한글이 섞인 JSON
  const candidates = [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 78900, fairPrice: 105000, gapPct: -24.9, score: 0.87 },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 250000, fairPrice: 300000, gapPct: -16.7, score: 0.65 },
  ];
  await recordRecommendation('2026-09-08', { regime: 'up', weightGap: 0.5 }, candidates);

  console.log('가짜 Upstash에 실제로 저장된 값(그대로 있어야 함, URL 인코딩되면 안 됨):');
  console.log(' ', store.get('reco:2026-09-08').slice(0, 60) + '...');
  check('저장된 값이 순수 JSON으로 시작함(%로 시작하면 안 됨)',
    store.get('reco:2026-09-08').startsWith('{'), store.get('reco:2026-09-08').slice(0, 20));

  const fetched = await getRecommendation('2026-09-08');
  check('불러온 값이 정상적으로 파싱됨(JSON.parse 성공)', fetched !== null && typeof fetched === 'object');
  check('종목 2개 다 정상적으로 돌아옴', fetched.candidates.length === 2, fetched.candidates);
  check('한글 이름도 안 깨짐', fetched.candidates[0].name === '삼성전자', fetched.candidates[0].name);
  check('두 번째 종목 이름도 안 깨짐', fetched.candidates[1].name === 'SK하이닉스', fetched.candidates[1].name);

  const dates = await listRecommendationDates();
  check('날짜 목록에도 정상 등록됨', dates.includes('2026-09-08'), dates);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
