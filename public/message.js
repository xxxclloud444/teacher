// 통화 모드 / 문자 모드 전환과 문자 판별 화면
// 위험 단계 문구(RISK_LABELS)는 먼저 불러온 call.js의 것을 함께 사용

const modeTabs = document.querySelectorAll('.mode-tab');
const callPanel = document.getElementById('call-panel');
const messagePanel = document.getElementById('message-panel');

const msgInput = document.getElementById('msg-input');
const msgImageInput = document.getElementById('msg-image');
const msgPreview = document.getElementById('msg-preview');
const msgPreviewImage = document.getElementById('msg-preview-image');
const msgRemoveImage = document.getElementById('msg-remove-image');
const msgCheckButton = document.getElementById('msg-check');
const msgNotice = document.getElementById('msg-notice');
const msgResult = document.getElementById('msg-result');
const msgLevel = document.getElementById('msg-level');
const msgReason = document.getElementById('msg-reason');
const msgType = document.getElementById('msg-type');
const msgLimited = document.getElementById('msg-limited');
const msgHighlightBox = document.getElementById('msg-highlight-box');
const msgHighlightTitle = document.getElementById('msg-highlight-title');
const msgHighlightText = document.getElementById('msg-highlight-text');
const msgAdvice = document.getElementById('msg-advice');

const MAX_IMAGE_SIDE = 2400; // 이미지 긴 변의 최대 길이 (글자를 읽을 수 있을 정도로 유지)
const JPEG_QUALITY = 0.85;

let msgImage = null; // 보낼 이미지 { mimeType, data }
let imageLoading = false; // 이미지를 준비하는 중인지
let checking = false; // 판별 요청 중인지

// 판별 버튼 상태 갱신
function updateCheckButton() {
  msgCheckButton.disabled = imageLoading || checking;
  msgCheckButton.textContent = checking ? '확인하는 중입니다' : '위험한 문자인지 확인';
}

// 안내 문구 표시 (비우면 숨김)
function showNotice(text) {
  msgNotice.textContent = text;
  msgNotice.hidden = !text;
}

// 탭 전환
function showMode(mode) {
  callPanel.hidden = mode !== 'call';
  messagePanel.hidden = mode !== 'message';
  modeTabs.forEach((tab) => {
    tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
  });
}

// 사진을 줄이고 JPEG로 바꿈 (큰 사진도 전송할 수 있게 함)
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const context = canvas.getContext('2d');
  // JPEG에는 투명이 없으므로 글자가 묻히지 않게 흰 배경을 먼저 칠함
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// 선택한 사진 지우기
function clearImage() {
  msgImage = null;
  msgImageInput.value = '';
  msgPreviewImage.removeAttribute('src');
  msgPreview.hidden = true;
}

// 사진 선택 처리
async function handleImageSelected() {
  const file = msgImageInput.files[0];
  if (!file) return;

  showNotice('');
  imageLoading = true;
  updateCheckButton();

  try {
    const dataUrl = await prepareImage(file);
    msgImage = { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
    msgPreviewImage.src = dataUrl;
    msgPreview.hidden = false;
  } catch (error) {
    console.error(error);
    clearImage();
    showNotice('이 사진은 열 수 없습니다. 다른 사진을 올려 주세요.');
  }

  imageLoading = false;
  updateCheckButton();
}

// 원문을 표시하면서 의심 부분을 강조 (붙여 넣은 글이 코드로 실행되지 않게 글자로만 넣음)
function renderHighlights(text, highlights) {
  msgHighlightText.textContent = '';
  let position = 0;

  highlights.forEach((range) => {
    msgHighlightText.append(document.createTextNode(text.slice(position, range.start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(range.start, range.end);
    msgHighlightText.append(mark);
    position = range.end;
  });

  msgHighlightText.append(document.createTextNode(text.slice(position)));
}

// 판별 결과 표시
function showResult(result) {
  msgResult.dataset.level = result.level;
  msgLevel.textContent = RISK_LABELS[result.level];
  msgReason.textContent = result.reason;
  msgType.textContent = result.level === 'safe' ? '' : `유형: ${result.type}`;

  // Gemini 없이 판별했다면 결과의 한계를 알림
  if (result.imageUnread) {
    msgLimited.textContent = '사진은 읽지 못해 붙여 넣은 글자의 키워드만 확인했습니다.';
  } else if (result.limited) {
    msgLimited.textContent = '지금은 정밀 판별을 할 수 없어 키워드만 확인했습니다.';
  } else {
    msgLimited.textContent = '';
  }

  msgHighlightTitle.textContent = result.highlights.length > 0 ? '의심 부분 (노란색)' : '확인한 내용';
  renderHighlights(result.text, result.highlights);

  msgAdvice.textContent = '';
  result.advice.forEach((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    msgAdvice.append(item);
  });

  msgResult.hidden = false;
  msgHighlightBox.hidden = false;
  msgAdvice.parentElement.hidden = false;
  msgResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 이전 결과 숨기기
function hideResult() {
  msgResult.hidden = true;
  msgHighlightBox.hidden = true;
  msgAdvice.parentElement.hidden = true;
}

// 위험한 문자인지 확인 버튼
async function checkMessage() {
  const text = msgInput.value.trim();

  hideResult();
  if (!text && !msgImage) {
    showNotice('문자 내용을 붙여 넣거나 사진을 올려 주세요.');
    msgInput.focus();
    return;
  }

  showNotice('');
  checking = true;
  updateCheckButton();

  try {
    const response = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, image: msgImage }),
    });
    const result = await response.json();

    if (response.ok) {
      showResult(result);
    } else {
      showNotice(result.error);
    }
  } catch (error) {
    console.error(error);
    showNotice('서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.');
  }

  checking = false;
  updateCheckButton();
}

modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => showMode(tab.dataset.mode));
});
msgImageInput.addEventListener('change', handleImageSelected);
msgRemoveImage.addEventListener('click', clearImage);
msgCheckButton.addEventListener('click', checkMessage);
