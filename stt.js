// Gemini API로 오디오 조각을 한국어 텍스트로 받아쓰기
const { ai, model, detectModel, errorSummary } = require('./gemini');

const PROMPT = '이 오디오를 한국어로 그대로 받아쓰기만 해. 설명 없이 텍스트만 출력. 말이 없으면 빈 문자열.';
const REQUEST_TIMEOUT_MS = 10000; // 오래 기다리지 않고 포기하는 시간 (Gemini가 허용하는 최솟값이 10초)

// 받아쓰기를 사용할 수 있는지 확인
function isSttReady() {
  return ai !== null;
}

// 지정한 모델로 받아쓰기 요청
async function requestTranscript(audio, modelName) {
  const response = await ai.models.generateContent({
    model: modelName,
    contents: [
      {
        role: 'user',
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType: 'audio/webm', data: audio.toString('base64') } },
        ],
      },
    ],
    config: { httpOptions: { timeout: REQUEST_TIMEOUT_MS } },
  });

  const text = (response.text || '').trim();

  // "빈 문자열"을 따옴표 그대로 답하는 경우도 말이 없는 것으로 처리
  return text === '""' || text === "''" ? '' : text;
}

// webm 오디오(Buffer)를 받아 텍스트로 돌려줌. 말이 없으면 빈 문자열.
// 모델 하나가 혼잡하거나 한도에 걸리면 다른 모델로 한 번 더 시도
async function transcribe(audio) {
  try {
    return await requestTranscript(audio, model);
  } catch (err) {
    if (detectModel === model) throw err;
    console.error(`받아쓰기 모델 ${model} 실패, ${detectModel}로 재시도: ${errorSummary(err)}`);
    return requestTranscript(audio, detectModel);
  }
}

module.exports = { isSttReady, transcribe };
