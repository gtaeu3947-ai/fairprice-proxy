/**
 * searchByNaverPage 검증.
 * '삼성전자' 픽스처는 실제 API 응답을 화면 캡처로 직접 확인한 것을 그대로 옮겼다
 * (2026-09 기준). ETF들이 6자리 순수 숫자 코드를 갖고 있어 코드 형식만으로는
 * 못 걸러낸다는 것, isEtf 필드로 걸러야 한다는 것까지 실제 데이터로 확인했다.
 */
process.env.PORT = '39993';

const DB = {
  '삼성전자': {
    isSuccess: true, detailCode: '', message: '',
    result: {
      query: '삼성전자',
      items: [
        { code: '005930', name: '삼성전자', typeCode: 'KOSPI', typeName: '코스피', isEtf: false },
        { code: '0162Z0', name: 'RISE 삼성전자SK하이닉스채권혼합50', typeCode: 'KOSPI', typeName: '코스피', isEtf: true },
        { code: '0193W0', name: 'KODEX 삼성전자단일종목레버리지', typeCode: 'KOSPI', typeName: '코스피', isEtf: true },
        { code: '0177N0', name: 'KODEX 삼성전자SK하이닉스채권혼합50', typeCode: 'KOSPI', typeName: '코스피', isEtf: true },
        // 448330은 ETF인데도 종목코드가 순수 6자리 숫자다 — isEtf로 걸러야 하는 이유.
        { code: '448330', name: 'KODEX 삼성전자채권혼합', typeCode: 'KOSPI', typeName: '코스피', isEtf: true },
        { code: '0195R0', name: 'TIGER 삼성전자단일종목레버리지', typeCode: 'KOSPI', typeName: '코스피', isEtf: true },
      ],
    },
  },
  '삼성전재': { result: { items: [] } },
  '카카오': {
    result: { items: [{ code: '035720', name: '카카오', typeName: '코스피', isEtf: false }] },
  },
};

global.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/query=([^&]+)/);
  const q = m ? decodeURIComponent(m[1]) : '';
  const body = DB[q] || { result: { items: [] } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const { searchByNaverPage } = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  const r1 = await searchByNaverPage('삼성전자');
  check('실제 종목 1건만 남음 (ETF 6건 전부 제외)', r1.length === 1, r1);
  check('005930 삼성전자만 남음', r1[0] && r1[0].code === '005930' && r1[0].name === '삼성전자', r1);
  check('순수 6자리 숫자 ETF(448330)도 제외됨', !r1.some(x => x.code === '448330'), r1);

  const r2 = await searchByNaverPage('삼성전재');
  check('오타 검색 → 빈 배열', Array.isArray(r2) && r2.length === 0, r2);

  const r3 = await searchByNaverPage('카카오');
  check('카카오 검색 → 1건', r3.length === 1 && r3[0].code === '035720', r3);

  console.log('\n' + (fail ? fail + '건 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})();
