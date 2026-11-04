// 화면 요소
const statusBox = document.getElementById('status-box');
const statusText = document.getElementById('status-text');
const statusMessage = document.getElementById('status-message');
const roomInput = document.getElementById('room-input');
const roleButtons = document.querySelectorAll('.role-button');
const startButton = document.getElementById('start-button');
const endButton = document.getElementById('end-button');
const remoteAudio = document.getElementById('remote-audio');
const captionBox = document.getElementById('caption-box');
const captionText = document.getElementById('caption-text');
const riskBox = document.getElementById('risk-box');
const riskLevel = document.getElementById('risk-level');
const riskReason = document.getElementById('risk-reason');
const riskType = document.getElementById('risk-type');
const riskAction = document.getElementById('risk-action');

// 상대방과 연결할 때 사용할 STUN 서버
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// 상태별 큰 글씨 문구
const STATUS_LABELS = { idle: '시작 전', waiting: '대기중', connected: '연결됨' };

const ELDER_ROLE = '어르신'; // 자막과 위험 표시를 보는 역할
const CALLER_ROLE = '상대방'; // 자기 말을 브라우저 음성 인식으로 글자로 바꿔 보내는 역할
const FATAL_SPEECH_ERRORS = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'network'];
const MAX_QUICK_SPEECH_ENDS = 5; // 음성 인식이 곧바로 끝나기를 이만큼 반복하면 포기
const QUICK_SPEECH_END_MS = 1000; // 이보다 빨리 끝나면 정상 동작이 아닌 것으로 봄
const SPEECH_RESTART_MS = 250; // 음성 인식이 끝났을 때 다시 시작하기까지 기다리는 시간
const CHUNK_MS = 5000; // Gemini로 받아쓸 때의 오디오 조각 길이 (5초)
const RECORD_OPTIONS = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 };
const CAPTION_PLACEHOLDER = '상대방의 말이 여기에 글자로 나옵니다.';
const RISK_LABELS = { safe: '안전', caution: '주의', danger: '위험' }; // 위험 단계별 큰 글씨 문구

let selectedRole = null; // 선택한 역할 (어르신 / 상대방)
let ws = null; // 시그널링 서버 연결
let pc = null; // 상대방과의 WebRTC 연결
let localStream = null; // 내 마이크 음성
let pendingCandidates = []; // 상대 정보를 받기 전에 먼저 도착한 ICE 후보
let recorder = null; // 현재 조각을 녹음 중인 MediaRecorder
let chunkTimer = null; // 조각 길이를 재는 타이머
let alertContext = null; // 위험 경고음을 내는 오디오 (버튼을 누를 때 만들어야 소리가 남)
let recognition = null; // 브라우저 음성 인식 (상대방 쪽)
let speechFallbackSent = false; // 음성 인식을 포기하고 Gemini 받아쓰기를 요청했는지
let geminiSttWanted = false; // 상대방이 Gemini 받아쓰기를 요청했는지 (어르신 쪽)

// 연결 상태를 화면에 표시
function setStatus(state, message) {
  statusBox.dataset.state = state;
  statusText.textContent = STATUS_LABELS[state];
  statusMessage.textContent = message;
}

// 통화 중에는 방 코드와 역할을 바꾸지 못하게 잠금
function setControlsLocked(locked) {
  roomInput.disabled = locked;
  startButton.disabled = locked;
  // 통화 중 위험 표시를 놓치지 않도록 다른 모드로 넘어가지 못하게 함
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.disabled = locked;
  });
  roleButtons.forEach((button) => {
    button.disabled = locked;
  });
}

// 시그널링 서버로 메시지 보내기
function sendSignal(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// 자막과 위험도 표시 비우기
function resetCaption() {
  captionText.textContent = CAPTION_PLACEHOLDER;
  riskBox.hidden = true;
}

// 화면을 보지 않고 통화 중이어도 알 수 있게 경고음과 진동으로 알림
function playDangerAlert() {
  if (navigator.vibrate) {
    navigator.vibrate([500, 200, 500, 200, 500]);
  }
  if (!alertContext) return;

  alertContext.resume();
  const startTime = alertContext.currentTime;
  for (let i = 0; i < 3; i++) {
    const oscillator = alertContext.createOscillator();
    oscillator.type = 'square';
    oscillator.frequency.value = 880;
    oscillator.connect(alertContext.destination);
    oscillator.start(startTime + i * 0.6);
    oscillator.stop(startTime + i * 0.6 + 0.4);
  }
}

// 위험도 판별 결과 표시
function showRisk(message) {
  // 위험으로 처음 바뀔 때 한 번만 경고
  if (message.level === 'danger' && (riskBox.hidden || riskBox.dataset.level !== 'danger')) {
    playDangerAlert();
  }
  riskAction.textContent = message.level === 'danger'
    ? '전화를 끊으세요. 돈을 보내거나 개인정보를 알려 주지 마세요. 의심되면 112에 전화하세요.'
    : '';

  riskBox.dataset.level = message.level;
  riskLevel.textContent = RISK_LABELS[message.level];
  riskReason.textContent = message.reason;
  // 사기 유형은 안전 단계가 아닐 때만 표시
  riskType.textContent = message.level === 'safe' ? '' : `유형: ${message.riskType}`;
  riskBox.hidden = false;
}

// 음성 인식을 쓸 수 없으면 어르신 쪽에 Gemini 받아쓰기를 요청
function requestGeminiFallback(reason) {
  console.warn(`브라우저 음성 인식 사용 불가, Gemini 받아쓰기로 전환: ${reason}`);
  stopSpeech();
  speechFallbackSent = true;
  sendSignal({ type: 'speech-fallback' });
}

// 내 말을 브라우저 음성 인식으로 글자로 바꿔 보내기 (상대방만)
function startSpeech() {
  if (selectedRole !== CALLER_ROLE || recognition || speechFallbackSent) return;

  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionClass) {
    requestGeminiFallback('지원하지 않는 브라우저');
    return;
  }

  const current = new SpeechRecognitionClass();
  current.lang = 'ko-KR';
  current.continuous = true;
  current.interimResults = true; // 말하는 도중의 글자도 받음
  recognition = current;

  let startedAt = 0;
  let quickEnds = 0;

  const begin = () => {
    startedAt = Date.now();
    try {
      current.start();
    } catch (error) {
      requestGeminiFallback(error.message);
    }
  };

  current.onresult = (event) => {
    quickEnds = 0;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        sendSignal({ type: 'speech', text, final: true });
      } else {
        interim += text;
      }
    }
    if (interim) {
      sendSignal({ type: 'speech', text: interim, final: false });
    }
  };

  current.onerror = (event) => {
    // 말이 없는 경우(no-speech) 등은 무시하고 다시 시작함
    if (recognition === current && FATAL_SPEECH_ERRORS.includes(event.error)) {
      requestGeminiFallback(event.error);
    }
  };

  // 음성 인식은 조용하면 저절로 끝나므로 통화 중에는 계속 다시 시작
  current.onend = () => {
    if (recognition !== current) return;
    quickEnds = Date.now() - startedAt < QUICK_SPEECH_END_MS ? quickEnds + 1 : 0;
    if (quickEnds >= MAX_QUICK_SPEECH_ENDS) {
      requestGeminiFallback('음성 인식이 계속 바로 끝남');
      return;
    }
    setTimeout(() => {
      if (recognition === current) begin();
    }, SPEECH_RESTART_MS);
  };

  begin();
}

// 음성 인식 중단
function stopSpeech() {
  const current = recognition;
  recognition = null;
  if (current) {
    current.abort();
  }
}

// 상대 음성을 5초 조각으로 녹음해 서버로 보내기 (어르신만, Gemini 받아쓰기를 쓸 때)
function startRecording() {
  if (selectedRole !== ELDER_ROLE || recorder) return;

  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(RECORD_OPTIONS.mimeType)) {
    captionText.textContent = '이 브라우저에서는 자막을 쓸 수 없습니다. Chrome이나 Edge를 사용해 주세요.';
    return;
  }
  recordChunk();
}

// 조각 하나를 녹음. 조각마다 녹음을 새로 시작해야 각 조각이 온전한 webm 파일이 됨
function recordChunk() {
  const current = new MediaRecorder(remoteAudio.srcObject, RECORD_OPTIONS);
  const parts = [];
  recorder = current;

  current.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };

  current.onstop = () => {
    // 녹음을 일부러 멈춘 경우에는 보내지 않음
    if (recorder !== current) return;
    if (parts.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new Blob(parts, { type: 'audio/webm' }));
    }
    recordChunk();
  };

  current.start();
  chunkTimer = setTimeout(() => current.stop(), CHUNK_MS);
}

// 녹음 중단
function stopRecording() {
  clearTimeout(chunkTimer);
  const current = recorder;
  recorder = null;
  if (current && current.state !== 'inactive') {
    current.stop();
  }
}

// WebRTC 연결 만들기
function createPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection(RTC_CONFIG);

  // 내 마이크 음성을 상대에게 보내기
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // 상대 음성이 도착하면 재생
  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
  };

  // 내 ICE 후보를 상대에게 전달
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice-candidate', data: event.candidate });
    }
  };

  // 실제 연결 상태를 화면에 반영
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('connected', `${selectedRole} 역할로 통화 중입니다.`);
      startSpeech();
      if (geminiSttWanted) {
        startRecording();
      }
    } else if (pc.connectionState === 'disconnected') {
      setStatus('waiting', '연결이 불안정합니다. 다시 연결하는 중입니다.');
    } else if (pc.connectionState === 'failed') {
      setStatus('waiting', '연결에 실패했습니다. 통화를 종료하고 다시 시도해 주세요.');
    }
  };
}

// WebRTC 연결 닫기 (마이크와 서버 연결은 유지)
function closePeerConnection() {
  stopRecording();
  stopSpeech();
  speechFallbackSent = false;
  geminiSttWanted = false;
  if (pc) {
    pc.close();
    pc = null;
  }
  pendingCandidates = [];
  remoteAudio.srcObject = null;
}

// 상대 연결 정보를 저장하고, 기다리던 ICE 후보를 적용
async function applyRemoteDescription(description) {
  await pc.setRemoteDescription(description);
  for (const candidate of pendingCandidates) {
    await pc.addIceCandidate(candidate);
  }
  pendingCandidates = [];
}

// 시그널링 서버에서 온 메시지 처리
async function handleSignal(message) {
  switch (message.type) {
    case 'joined':
      setStatus('waiting', message.peerPresent ? '상대방과 연결하는 중입니다.' : '상대방을 기다리고 있습니다.');
      break;

    // 먼저 들어와 있던 쪽이 offer를 만들어 보냄
    case 'peer-joined': {
      setStatus('waiting', '상대방과 연결하는 중입니다.');
      createPeerConnection();
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ type: 'offer', data: pc.localDescription });
      break;
    }

    // 나중에 들어온 쪽은 offer를 받아 answer로 응답
    case 'offer': {
      createPeerConnection();
      await applyRemoteDescription(message.data);
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ type: 'answer', data: pc.localDescription });
      break;
    }

    case 'answer':
      if (pc) {
        await applyRemoteDescription(message.data);
      }
      break;

    case 'ice-candidate':
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(message.data);
      } else if (pc) {
        pendingCandidates.push(message.data);
      }
      break;

    // 상대가 나가면 마이크는 유지한 채 다음 상대를 기다림
    case 'peer-left':
      closePeerConnection();
      resetCaption();
      setStatus('waiting', '상대방이 나갔습니다. 다시 들어오기를 기다리고 있습니다.');
      break;

    // 상대방 브라우저에서 음성 인식을 못 쓰면 Gemini 받아쓰기로 전환
    case 'speech-fallback':
      geminiSttWanted = true;
      if (pc && pc.connectionState === 'connected') {
        startRecording();
      }
      break;

    // 최근 30초 텍스트와 인식 중인 글자를 자막으로 표시
    case 'transcript':
      captionText.textContent = message.text;
      captionText.scrollTop = captionText.scrollHeight;
      break;

    case 'risk':
      showRisk(message);
      break;

    case 'room-full':
      endCall('방이 가득 찼습니다. 다른 방 코드를 입력해 주세요.');
      break;

    case 'error':
      endCall(message.message);
      break;
  }
}

// 시그널링 서버에 접속해서 방에 입장
function connectSignaling(roomCode) {
  // https로 접속했다면 wss, 아니면 ws 사용
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => sendSignal({ type: 'join', roomCode, role: selectedRole });

  ws.onmessage = (event) => {
    handleSignal(JSON.parse(event.data)).catch((error) => {
      console.error(error);
      // 이미 연결을 닫은 뒤에 난 오류는 무시
      if (pc) {
        setStatus('waiting', '연결 중 오류가 났습니다. 통화를 종료하고 다시 시도해 주세요.');
      }
    });
  };

  ws.onclose = () => endCall('서버와 연결이 끊겼습니다. 다시 시도해 주세요.');
}

// 경고음 오디오 정리
function closeAlertContext() {
  if (alertContext) {
    alertContext.close();
    alertContext = null;
  }
}

// 통화 시작 버튼
async function startCall() {
  const roomCode = roomInput.value.trim();

  if (!roomCode) {
    setStatus('idle', '방 코드를 입력해 주세요.');
    roomInput.focus();
    return;
  }
  if (!selectedRole) {
    setStatus('idle', '역할을 선택해 주세요.');
    return;
  }
  // https나 localhost가 아니면 브라우저가 마이크를 제공하지 않음
  if (!navigator.mediaDevices) {
    setStatus('idle', '이 주소에서는 마이크를 쓸 수 없습니다. https 주소로 접속해 주세요.');
    return;
  }

  setControlsLocked(true);
  setStatus('waiting', '마이크 사용을 허용해 주세요.');

  if (selectedRole === ELDER_ROLE) {
    alertContext = new AudioContext();
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    console.error(error);
    closeAlertContext();
    setControlsLocked(false);
    setStatus('idle', '마이크를 사용할 수 없습니다. 브라우저에서 마이크를 허용해 주세요.');
    return;
  }

  endButton.disabled = false;
  resetCaption();
  captionBox.hidden = selectedRole !== ELDER_ROLE; // 자막은 어르신 화면에만 표시
  connectSignaling(roomCode);
}

// 통화 종료: 연결을 모두 닫고 처음 화면으로 되돌림
function endCall(message = '통화가 종료되었습니다.') {
  closePeerConnection();
  closeAlertContext();

  if (ws) {
    ws.onclose = null; // 직접 닫을 때는 끊김 안내를 띄우지 않음
    ws.close();
    ws = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  setControlsLocked(false);
  endButton.disabled = true;
  captionBox.hidden = true;
  riskBox.hidden = true;
  setStatus('idle', message);
}

// 역할 버튼: 누른 버튼만 선택 상태로 표시
roleButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedRole = button.dataset.role;
    roleButtons.forEach((other) => {
      other.setAttribute('aria-pressed', String(other === button));
    });
  });
});

startButton.addEventListener('click', startCall);
endButton.addEventListener('click', () => endCall());
