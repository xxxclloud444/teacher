// 받아쓰기(stt.js)와 판별(detect.js)이 함께 쓰는 Gemini 클라이언트
const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL; // 받아쓰기 모델
// 요청 한도가 모델별로 계산되므로 판별은 다른 모델을 쓸 수 있게 함 (없으면 같은 모델 사용)
const detectModel = process.env.GEMINI_DETECT_MODEL || model;

// 키와 모델이 모두 있을 때만 클라이언트를 만듦 (없으면 null)
const ai = apiKey && model ? new GoogleGenAI({ apiKey }) : null;

// 로그가 너무 길어지지 않게 오류 내용을 줄임
function errorSummary(err) {
  return String(err.message).slice(0, 200);
}

module.exports = { ai, model, detectModel, errorSummary };
