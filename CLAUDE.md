# CLAUDE.md

## 프로젝트
실시간 보이스피싱 탐지 웹앱 (고령층 보호). 학교 해커톤용.

## 기술 스택
- 서버: Node.js + Express + ws(WebSocket)
- 프론트: 순수 HTML/CSS/JS (프레임워크 없음)
- 통화: WebRTC (두 기기, 역할 "어르신" / "상대방")
- STT: 상대방 브라우저의 음성 인식(SpeechRecognition)이 기본. 쓸 수 없으면 Gemini API (`@google/genai`, 모델은 `.env`의 `GEMINI_MODEL`)로 자동 전환
- 판별: 규칙 점수 + Gemini API (`detect.js`, 모델은 `.env`의 `GEMINI_DETECT_MODEL`, 하나라도 danger면 danger, API 실패 시 규칙만 사용)
- 무료 등급은 모델별 분당 15회 제한이 있어 STT와 판별 모델을 나눈다.

## 보안
- API 키는 `.env`에서만 읽는다. 코드와 깃에 노출하지 않는다.
- `.env`는 반드시 `.gitignore`에 포함한다.

## UI
- 어르신용: 큰 글씨, 고대비, 한국어

## 코드 스타일
- 코드는 단순하게 작성한다.
- 주석은 한국어로 작성한다.

## 작업 방식
- 단계별로 진행한다.
- 한 단계가 끝나면 실행 방법을 알려준다.
