// 판별 테스트: 보이스피싱 예시 5개 + 일반 통화 예시 3개
// 실행: npm run test:detect (.env에 Gemini 키가 없으면 규칙 점수만으로 판별)
require('dotenv').config({ quiet: true });

const { detect } = require('./detect');
const { ai } = require('./gemini');

const CASES = [
  {
    name: '검찰 사칭',
    expected: 'danger',
    text: '안녕하세요 서울중앙지검 김철수 수사관입니다. 고객님 명의로 대포통장이 개설되어 범죄에 연루되셨습니다. 구속 영장이 발부될 수 있으니 아무에게도 말하지 마세요.',
  },
  {
    name: '금감원 안전계좌',
    expected: 'danger',
    text: '금융감독원입니다. 고객님 계좌가 해킹 위험에 노출되었습니다. 지금 당장 예금을 저희가 알려 드리는 안전 계좌로 옮기셔야 합니다.',
  },
  {
    name: '앱 설치·원격제어',
    expected: 'danger',
    text: '은행 보안 점검팀입니다. 문자로 보내 드린 링크를 눌러 앱을 설치해 주시면 저희가 원격으로 처리해 드립니다. 화면에 나오는 인증번호도 불러 주세요.',
  },
  {
    name: '대출 빙자',
    expected: 'danger',
    text: '저금리 대환대출 대상자로 선정되셨습니다. 기존 대출을 먼저 갚으셔야 하니 저희 직원을 보내 드리면 현금으로 전달해 주세요. 오늘 안에 하셔야 합니다.',
  },
  {
    name: '가족 사칭',
    expected: 'danger',
    text: '엄마 나야. 휴대폰 액정이 깨져서 친구 폰으로 연락했어. 급하게 돈이 필요한데 이 계좌로 200만 원만 보내줘. 아빠한테는 말하지 마.',
  },
  {
    name: '일반: 가족 안부',
    expected: 'safe',
    text: '어머니 식사하셨어요? 이번 주말에 애들 데리고 찾아뵐게요. 날씨 추우니까 감기 조심하시고요.',
  },
  {
    name: '일반: 병원 안내',
    expected: 'safe',
    text: '네 행복내과입니다. 지난번 건강검진 검사 결과가 나와서 연락드렸어요. 내일 오전에 내원하실 수 있으세요?',
  },
  {
    name: '일반: 용돈 입금',
    expected: 'safe',
    text: '아버지 이번 달 용돈 통장으로 입금했어요. 확인해 보시고 더 필요한 거 있으면 말씀하세요.',
  },
];

async function main() {
  console.log(ai ? 'Gemini + 규칙으로 판별합니다.\n' : '.env에 Gemini 설정이 없어 규칙 점수만으로 판별합니다.\n');

  let passed = 0;
  let geminiAnswered = 0;
  for (const item of CASES) {
    const result = await detect(item.text);
    if (result.geminiLevel) geminiAnswered++;
    // Gemini가 답하지 않으면 최종 단계가 안전이 될 수 없으므로 규칙 단계로 비교
    const ok = (result.geminiLevel ? result.level : result.ruleLevel) === item.expected;
    if (ok) passed++;

    console.log(`${ok ? '성공' : '실패'} | ${item.name}`);
    console.log(`  기대: ${item.expected} / 최종: ${result.level}`);
    console.log(`  규칙: ${result.ruleLevel} (${result.score}점: ${result.labels.join(', ') || '없음'})`);
    console.log(`  Gemini: ${result.geminiLevel || '사용 안 함'}`);
    console.log(`  유형: ${result.type}`);
    console.log(`  이유: ${result.reason}\n`);
  }

  console.log(`결과: ${passed}/${CASES.length} 통과 (Gemini 응답 ${geminiAnswered}/${CASES.length}회)`);
  if (ai && geminiAnswered < CASES.length) {
    console.log('주의: Gemini가 답하지 않은 항목은 규칙 점수만 확인한 것입니다.');
  }
  process.exit(passed === CASES.length ? 0 : 1);
}

main();
