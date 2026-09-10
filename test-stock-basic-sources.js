/**
 * 종목 기본정보(현재가·종목명·상장주식수) 수집 검증.
 *
 * 겪은 문제(2026-09): 네이버가 종목 페이지를 Next.js로 재구축하면서 HTML에서
 * #_nowVal / p.no_today 가 사라졌다. 현재가를 못 읽으니 저평가 스크리너가
 * 100종목 전부를 "데이터 부족"으로 버렸고, 적정주가 계산기도 멈췄다.
 *
 * 이제 JSON API를 먼저 쓰고 HTML은 예비로 둔다. 여기서 확인하는 것:
 *   1) API 응답이 어떤 모양으로 감싸여 있든 값을 찾아낸다
 *   2) 앞 API가 죽으면 뒤 API로 넘어가고, 수급 API의 closePrice까지 쓴다
 *   3) HTML이 개편돼 현재가가 없어도 최종 결과에는 현재가가 들어간다
 */
process.env.PORT = '39991';

let alive = { basic: true, integration: true, trend: true, html: true, fnguide: true };
let calls = [];

/** 개편 전 HTML(현재가 있음) / 개편 후 HTML(현재가 없음) */
function itemHtml(withPrice) {
  const head = '<html><head><meta charset="utf-8"></head><body>';
  const company = '<div class="wrap_company"><h2><a href="#">삼성전자</a></h2></div>';
  const price = withPrice ? '<p class="no_today"><em id="_nowVal">72,500</em></p>' : '<div id="__next"></div>';
  const table = '<table class="tb_type1_ifrs"><thead><tr><th>2023</th><th>2024</th><th>2025</th></tr></thead>'
    + '<tbody><tr><th>ROE</th><td>8.1</td><td>9.4</td><td>11.2</td></tr>'
    + '<tr><th>BPS</th><td>52,000</td><td>55,000</td><td>58,000</td></tr>'
    + '<tr><th>상장주식수</th><td>5,969,782,550</td></tr></tbody></table>';
  return head + company + price + table + '</body></html>';
}

global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const bad = { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0), text: async () => '' };
  const json = (o) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(o), 'utf8'), text: async () => JSON.stringify(o) });
  const html = (t) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(t, 'utf8'), text: async () => t });

  if (u.includes('/api/stock/') && u.endsWith('/basic')) {
    // 값이 두 겹 안에 들어 있고 문자열에 쉼표가 섞인 형태
    return alive.basic ? json({ stockName: '삼성전자', dealTrendInfos: [], closePrice: '72,500' }) : bad;
  }
  if (u.includes('/api/stock/') && u.endsWith('/integration')) {
    // 목록형 { key, value } 구조 — 라벨로 찾아야 하는 경우
    return alive.integration ? json({
      stockName: '삼성전자',
      totalInfos: [
        { key: '시가총액', value: '432조' },
        { key: '상장주식수', value: '5,969,782,550' },
        { key: 'BPS', value: '58,000' },
      ],
    }) : bad;
  }
  if (u.includes('/trend')) {
    return alive.trend ? json([{ bizdate: '20260910', closePrice: '71,900', accumulatedTradingVolume: '12,345,678' }]) : bad;
  }
  if (u.includes('item/main.naver')) {
    return alive.html ? html(itemHtml(false)) : bad;   // 개편 후 = 현재가 없음
  }
  if (u.includes('comp.fnguide.com')) return bad;      // FnGuide는 이 테스트 범위 밖
  throw new Error('예상치 못한 URL: ' + u);
};

const S = require('./server.js');

let fail = 0;
function check(name, cond, detail) {
  if (!cond) { fail++; console.log('  FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  else console.log('  OK    ' + name);
}

(async () => {
  console.log('\n[1] 값 찾기 — 감싸는 구조에 안 흔들리는가');
  check('중첩된 객체에서 현재가를 찾음',
    S.findValueByKey({ a: { b: { closePrice: '72,500' } } }, /closePrice/i, 0) === 72500);
  check('{key, value} 목록형에서도 찾음',
    S.findValueByKey({ infos: [{ key: '상장주식수', value: '5,969,782,550' }] }, /상장주식수/, 0) === 5969782550);
  check('종목명은 숫자 문자열을 집지 않음',
    S.findStringByKey({ stockName: '삼성전자', code: '005930' }, /^(stock|item)?name$/i, 0) === '삼성전자');

  console.log('\n[2] API 경로');
  alive = { basic: true, integration: true, trend: true, html: true, fnguide: true };
  let r = await S.fromNaverApi('005930');
  check('기본 API에서 현재가를 읽음', r.price === 72500, r.price);
  check('종목명도 읽음', r.name === '삼성전자', r.name);

  console.log('\n[3] 기본 API가 죽으면 통합 API로 넘어간다');
  S.__clearCaches(true); calls = [];
  alive.basic = false;
  r = await S.fromNaverApi('005930');
  check('상장주식수를 통합 API에서 확보', r.shares === 5969782550, r.shares);
  check('현재가는 수급 API의 closePrice로 메움', r.price === 71900, r.price);

  console.log('\n[4] 둘 다 죽어도 수급 API 하나로 현재가는 살린다');
  S.__clearCaches(true);
  alive.basic = false; alive.integration = false; alive.trend = true;
  r = await S.fromNaverApi('005930');
  check('현재가 확보', r.price === 71900, r.price);

  console.log('\n[5] 모든 API가 죽으면 이유를 담아 던진다');
  S.__clearCaches(true);
  alive.basic = false; alive.integration = false; alive.trend = false;
  let msg = null;
  try { await S.fromNaverApi('005930'); } catch (e) { msg = e.message; }
  check('에러 메시지에 세 경로가 다 남음',
    /basic/.test(msg || '') && /integration/.test(msg || '') && /trend/.test(msg || ''), msg);

  console.log('\n[6] 개편된 HTML은 현재가를 못 읽는다 (문제 재현)');
  S.__clearCaches(true);
  alive = { basic: true, integration: true, trend: true, html: true, fnguide: true };
  const htmlOnly = await S.fromNaver('005930');
  check('HTML 파서의 현재가는 null', htmlOnly.price == null, htmlOnly.price);
  check('그래도 종목명·주식수는 HTML에서 읽힘',
    htmlOnly.name === '삼성전자' && htmlOnly.shares === 5969782550, { n: htmlOnly.name, s: htmlOnly.shares });

  console.log('\n[7] 최종 결과 — HTML이 깨져 있어도 현재가가 채워지는가');
  S.__clearCaches(true);
  const fund = await S.getFundamentals('005930');
  check('현재가가 채워짐', fund.price === 72500, fund.price);
  check('종목명이 채워짐', fund.name === '삼성전자', fund.name);
  check('상장주식수가 채워짐', fund.shares === 5969782550, fund.shares);
  check('FnGuide 실패는 경고로만 남고 결과는 나온다',
    fund.warnings.some(w => /FnGuide/.test(w)), fund.warnings);
  check('BPS × 주식수로 자본을 추정함', fund.equityEok > 0, fund.equityEok);

  console.log('\n[8] 네이버가 전부 죽으면 그때는 실패한다');
  S.__clearCaches(true);
  alive = { basic: false, integration: false, trend: false, html: false, fnguide: false };
  let err = null;
  try { await S.getFundamentals('005930'); } catch (e) { err = e; }
  check('에러가 던져짐', err != null, err && err.message);

  console.log('\n' + (fail ? fail + '개 실패' : '전부 통과'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
