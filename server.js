// 환경 변수(.env) 불러오기
require('dotenv').config({ quiet: true });

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { isSttReady, transcribe } = require('./stt');
const { detect, detectMessage } = require('./detect');
const { errorSummary } = require('./gemini');

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 2; // 한 방에 들어올 수 있는 최대 인원
const MAX_MESSAGE_BYTES = 256 * 1024; // 메시지 최대 크기 (오디오 조각 포함, 256KB)
const RELAY_TYPES = ['offer', 'answer', 'ice-candidate', 'speech-fallback']; // 상대에게 그대로 전달할 메시지 종류
const ROLES = ['어르신', '상대방']; // 방에 들어올 수 있는 역할
const ELDER_ROLE = '어르신'; // 자막을 받는 역할
const CALLER_ROLE = '상대방'; // 브라우저 음성 인식 결과를 보내는 역할
const MAX_SPEECH_TEXT = 500; // 음성 인식 결과 한 번의 최대 글자 수
const DETECT_MIN_GAP_MS = 5000; // Gemini 요청 한도를 넘지 않기 위한 판별 최소 간격
const TRANSCRIPT_KEEP_MS = 30 * 1000; // 방별 텍스트 보관 시간 (최근 30초)
const MAX_IN_FLIGHT_CHUNKS = 3; // 동시에 받아쓰는 오디오 조각 수 (넘으면 새 조각을 버림)
const MAX_MESSAGE_TEXT = 5000; // 문자 판별 글자 수 제한
const MAX_BODY_SIZE = '8mb'; // 문자 판별 요청 크기 제한 (이미지 포함)
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']; // 받을 수 있는 이미지 형식
const MESSAGE_LIMIT_PER_MINUTE = Number(process.env.MESSAGE_LIMIT_PER_MINUTE) || 10; // 한 IP의 분당 문자 판별 횟수

const app = express();

// public 폴더의 파일을 정적으로 제공
app.use(express.static(path.join(__dirname, 'public')));

// 호스팅 서비스의 프록시 뒤에서도 실제 접속자 IP를 알 수 있게 함
app.set('trust proxy', 1);

// IP별 분당 요청 수 (공개 주소에서 Gemini 사용량을 다 써 버리지 않게 함)
const messageRequestCounts = new Map();
setInterval(() => messageRequestCounts.clear(), 60 * 1000).unref();

function limitMessageRequests(req, res, next) {
  const count = (messageRequestCounts.get(req.ip) || 0) + 1;
  messageRequestCounts.set(req.ip, count);
  if (count > MESSAGE_LIMIT_PER_MINUTE) {
    res.status(429).json({ error: '요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.' });
    return;
  }
  next();
}

// 문자 모드: 글자나 이미지를 받아 위험도 판별 (내용은 저장하거나 로그에 남기지 않음)
app.post('/api/message', limitMessageRequests, express.json({ limit: MAX_BODY_SIZE }), async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const image = body.image || null;

  if (!text && !image) {
    res.status(400).json({ error: '문자 내용을 붙여 넣거나 사진을 올려 주세요.' });
    return;
  }
  if (text.length > MAX_MESSAGE_TEXT) {
    res.status(400).json({ error: `글자가 너무 많습니다. ${MAX_MESSAGE_TEXT}자 이내로 넣어 주세요.` });
    return;
  }
  if (image && (!IMAGE_TYPES.includes(image.mimeType) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(image.data))) {
    res.status(400).json({ error: '이 사진 형식은 사용할 수 없습니다.' });
    return;
  }

  const result = await detectMessage({ text, image });
  if (result.error) {
    res.status(502).json({ error: result.error });
    return;
  }
  console.log(`[문자 판별] ${result.level}${result.limited ? ' (규칙만 사용)' : ''}`);
  res.json(result);
});

// 요청 크기 초과나 잘못된 JSON도 한국어 안내로 응답
app.use((err, req, res, next) => {
  const tooLarge = err.status === 413;
  res.status(err.status || 500).json({ error: tooLarge ? '사진이 너무 큽니다. 더 작은 사진을 올려 주세요.' : '요청을 처리하지 못했습니다.' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// 방 목록: 방 코드 -> 접속자(WebSocket) 집합
const rooms = new Map();

// 방별 받아쓰기 상태: 방 코드 -> { texts: [{ text, time }], inFlight, lastJob, detecting, detectAgain, lastDetectAt, dangerResult }
const sttRooms = new Map();

// JSON 메시지를 한 명에게 보내기
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// 같은 방의 상대방 찾기
function findPeer(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  for (const member of room) {
    if (member !== ws) return member;
  }
  return null;
}

// 방 입장 처리
function joinRoom(ws, roomCode, role) {
  if (ws.roomCode) {
    send(ws, { type: 'error', message: '이미 방에 들어와 있습니다.' });
    return;
  }

  const code = typeof roomCode === 'string' ? roomCode.trim() : '';
  if (!code) {
    send(ws, { type: 'error', message: '방 코드를 입력해 주세요.' });
    return;
  }

  if (!ROLES.includes(role)) {
    send(ws, { type: 'error', message: '역할을 선택해 주세요.' });
    return;
  }

  const room = rooms.get(code) || new Set();
  if (room.size >= MAX_ROOM_SIZE) {
    send(ws, { type: 'room-full', message: '방이 가득 찼습니다.' });
    return;
  }

  // 자막이 어르신 한 명에게만 가도록 같은 역할의 중복 입장을 막음
  for (const member of room) {
    if (member.role === role) {
      send(ws, { type: 'error', message: `이 방에는 이미 ${role} 역할이 있습니다. 다른 역할을 골라 주세요.` });
      return;
    }
  }

  room.add(ws);
  rooms.set(code, room);
  ws.roomCode = code;
  ws.role = role;

  // 두 번째 입장자가 들어오면 먼저 온 사람에게 알림
  const peer = findPeer(ws);
  send(ws, { type: 'joined', roomCode: code, peerPresent: Boolean(peer) });
  if (peer) {
    send(peer, { type: 'peer-joined' });
  }
}

// 방 퇴장 처리 (연결이 끊겼을 때)
function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  const peer = findPeer(ws);
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(ws.roomCode);
  }
  // 통화 상대가 바뀌므로 지금까지의 받아쓰기 내용은 버림
  clearStt(ws.roomCode);
  ws.roomCode = null;
  ws.role = null;

  if (peer) {
    send(peer, { type: 'peer-left' });
  }
}

// 방의 받아쓰기 상태 삭제 (처리 중인 조각의 결과도 무시됨)
function clearStt(roomCode) {
  sttRooms.delete(roomCode);
}

// 받아쓴 텍스트를 방에 저장하고 어르신 화면으로 전달
function addTranscript(roomCode, state, text) {
  const now = Date.now();
  state.texts.push({ text, time: now });
  // 30초가 지난 텍스트는 삭제
  state.texts = state.texts.filter((item) => now - item.time <= TRANSCRIPT_KEEP_MS);

  console.log(`[방 ${roomCode}] 받아쓰기: ${text}`);

  sendToElder(roomCode, { type: 'transcript', text: joinTexts(state) });
  runDetection(roomCode, state);
}

// 저장된 텍스트를 하나로 합치기
function joinTexts(state) {
  return state.texts.map((item) => item.text).join(' ');
}

// 방의 어르신에게만 메시지 보내기
function sendToElder(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const member of room) {
    if (member.role === ELDER_ROLE) {
      send(member, message);
    }
  }
}

// 위험도 판별 후 어르신 화면으로 전송
// 판별 중에 새 텍스트가 오면 끝난 뒤 최신 텍스트로 한 번 더 실행 (받아쓰기는 멈추지 않음)
async function runDetection(roomCode, state) {
  if (state.detecting) {
    state.detectAgain = true;
    return;
  }

  state.detecting = true;
  do {
    state.detectAgain = false;

    // 최소 간격을 기다리는 동안 들어온 텍스트는 다음 판별에 함께 들어감
    const wait = state.lastDetectAt + DETECT_MIN_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (sttRooms.get(roomCode) !== state) return;
      state.detectAgain = false;
    }
    state.lastDetectAt = Date.now();

    const result = await detect(joinTexts(state));
    // 기다리는 사이 통화가 끝났으면 결과를 버림
    if (sttRooms.get(roomCode) !== state) return;

    console.log(`[방 ${roomCode}] 판별: ${result.level} (규칙 ${result.ruleLevel} ${result.score}점, Gemini ${result.geminiLevel || '없음'})`);

    // 한 번 위험이 나오면 통화가 끝날 때까지 위험 표시를 유지 (안심 신호로 오해하지 않게 함)
    if (result.level === 'danger') {
      state.dangerResult = result;
    }
    const shown = state.dangerResult || result;
    sendToElder(roomCode, { type: 'risk', level: shown.level, reason: shown.reason, riskType: shown.type });
  } while (state.detectAgain);
  state.detecting = false;
}

// 오디오 조각 하나 받아쓰기. 실패해도 로그만 남기고 빈 문자열을 돌려줌
async function transcribeChunk(roomCode, audio) {
  try {
    return await transcribe(audio);
  } catch (err) {
    const label = err.status === 429 ? '요청 제한(429)' : '실패';
    console.error(`[방 ${roomCode}] 받아쓰기 ${label}: ${errorSummary(err)}`);
    return '';
  }
}

// 방의 받아쓰기 상태 가져오기 (없으면 새로 만듦)
function getSttState(roomCode) {
  let state = sttRooms.get(roomCode);
  if (!state) {
    state = { texts: [], inFlight: 0, lastJob: Promise.resolve(), detecting: false, detectAgain: false, lastDetectAt: 0, dangerResult: null };
    sttRooms.set(roomCode, state);
  }
  return state;
}

// 상대방 브라우저의 음성 인식 결과 받기
// 인식 중인 글자는 자막에만 바로 보여 주고, 확정된 문장만 저장하고 판별함
function handleSpeech(ws, message) {
  if (ws.role !== CALLER_ROLE || !findPeer(ws) || typeof message.text !== 'string') return;

  const text = message.text.trim();
  if (!text || text.length > MAX_SPEECH_TEXT) return;

  const state = getSttState(ws.roomCode);
  if (message.final) {
    addTranscript(ws.roomCode, state, text);
  } else {
    sendToElder(ws.roomCode, { type: 'transcript', text: [joinTexts(state), text].filter(Boolean).join(' ') });
  }
}

// 어르신 브라우저에서 보낸 오디오 조각 받기 (브라우저 음성 인식을 못 쓸 때 사용)
function handleAudioChunk(ws, audio) {
  // 상대방과 통화 중인 어르신의 오디오만 처리
  if (ws.role !== ELDER_ROLE || !findPeer(ws) || !isSttReady()) return;

  const state = getSttState(ws.roomCode);

  // 응답이 늦는 요청이 뒤 조각을 막지 않도록 동시에 처리하되, 개수는 제한
  if (state.inFlight >= MAX_IN_FLIGHT_CHUNKS) {
    console.error(`[방 ${ws.roomCode}] 처리가 밀려 오디오 조각을 버렸습니다.`);
    return;
  }
  state.inFlight++;

  // 요청은 바로 보내고, 결과는 들어온 순서대로 반영
  const roomCode = ws.roomCode;
  const job = transcribeChunk(roomCode, audio);
  state.lastJob = state.lastJob.then(async () => {
    const text = await job;
    state.inFlight--;
    // 기다리는 사이 통화가 끝났으면 결과를 버림
    if (text && sttRooms.get(roomCode) === state) {
      addTranscript(roomCode, state, text);
    }
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    // 바이너리 메시지는 오디오 조각
    if (isBinary) {
      handleAudioChunk(ws, data);
      return;
    }

    // 잘못된 형식의 메시지가 와도 서버가 죽지 않도록 처리
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: '잘못된 메시지 형식입니다.' });
      return;
    }
    if (!message || typeof message !== 'object') {
      send(ws, { type: 'error', message: '잘못된 메시지 형식입니다.' });
      return;
    }

    if (message.type === 'join') {
      joinRoom(ws, message.roomCode, message.role);
    } else if (message.type === 'speech') {
      handleSpeech(ws, message);
    } else if (RELAY_TYPES.includes(message.type)) {
      // offer / answer / ice-candidate는 같은 방의 상대에게만 전달
      const peer = findPeer(ws);
      if (peer) {
        send(peer, { type: message.type, data: message.data });
      }
    } else {
      send(ws, { type: 'error', message: '알 수 없는 메시지 종류입니다.' });
    }
  });

  ws.on('close', () => leaveRoom(ws));

  // 크기 초과 등 소켓 오류가 나도 서버가 죽지 않도록 기록만 남김
  ws.on('error', (err) => console.error('WebSocket 오류:', err.message));
});

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (!isSttReady()) {
    console.warn('GEMINI_API_KEY 또는 GEMINI_MODEL이 .env에 없어 받아쓰기를 건너뜁니다.');
  }
});
