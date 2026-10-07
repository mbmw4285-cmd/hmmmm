const API = (window.VERDIX_API_URL || '').replace(/\/+$/, '');
const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), select = $('cameraSelect');
const startBtn = $('startBtn'), scanBtn = $('scanBtn'), sortBtn = $('sortBtn'), msg = $('msg');
let stream = null, current = null;

function say(text, type = '') { msg.textContent = text; msg.className = 'msg ' + type; }
const cap = m => m[0] + m.slice(1).toLowerCase();

async function loadStatus() {
  try {
    const s = await (await fetch(API + '/api/status')).json();
    const dot = $('statusDot');
    if (!s.ai) { dot.className = 'dot err'; $('statusText').textContent = 'AI key missing'; }
    else if (s.esp32 === 'simulation') { dot.className = 'dot warn'; $('statusText').textContent = 'Online · ESP32 simulation'; }
    else { dot.className = 'dot ok'; $('statusText').textContent = 'Online · ESP32 configured'; }
  } catch { $('statusDot').className = 'dot err'; $('statusText').textContent = 'Server offline'; }
}

async function listCameras() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const active = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  select.innerHTML = cams.length ? '' : '<option>No cameras detected</option>';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = c.label || `Camera ${i + 1}`;
    if (c.deviceId === active) o.selected = true;
    select.appendChild(o);
  });
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) return say('Camera needs HTTPS or localhost and a modern browser.', 'err');
  try {
    stream?.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false });
    video.srcObject = stream;
    $('camEmpty').classList.add('hide');
    scanBtn.disabled = false; startBtn.textContent = 'Restart Camera';
    await listCameras(); say('');
  } catch (e) {
    say(e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser address bar and retry.'
      : e.name === 'NotFoundError' ? 'No camera found. Connect a webcam and retry.' : 'Could not start camera: ' + e.message, 'err');
  }
}

function showResult(r) {
  current = r;
  $('resultCard').dataset.material = r.material;
  $('material').textContent = r.material;
  $('item').textContent = r.item;
  $('confText').textContent = r.confidence + '%';
  $('confBar').style.width = r.confidence + '%';
  document.querySelectorAll('.bin').forEach(b => b.classList.toggle('active', b.dataset.bin === r.material));
  if (r.material === 'UNKNOWN') {
    $('reason').textContent = 'Please place a clear waste item in the camera view.';
    sortBtn.disabled = true;
  } else { $('reason').textContent = r.reason; sortBtn.disabled = false; }
  sortBtn.textContent = r.material === 'UNKNOWN' ? 'Sort to Bin' : `Sort to ${cap(r.material)} Bin`;
}

async function scan() {
  if (!stream || !video.videoWidth) return say('Start the camera first.', 'err');
  const scale = Math.min(1, 1024 / video.videoWidth);
  canvas.width = video.videoWidth * scale; canvas.height = video.videoHeight * scale;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = canvas.toDataURL('image/jpeg', 0.85);
  scanBtn.disabled = sortBtn.disabled = true; scanBtn.textContent = 'Analyzing…';
  $('scanLine').classList.add('on'); say('Sending image to Groq AI…');
  try {
    const res = await fetch(API + '/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Classification failed');
    showResult(data); say('');
  } catch (e) { say(e.message, 'err'); }
  finally { scanBtn.disabled = false; scanBtn.textContent = 'Scan Object'; $('scanLine').classList.remove('on'); }
}

async function sort() {
  if (!current || current.material === 'UNKNOWN') return;
  const m = current.material;
  sortBtn.disabled = true; say(`Routing to ${m} bin...`);
  try {
    const res = await fetch(API + '/api/sort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material: m }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sorting failed');
    say('✓ ' + data.message, 'ok');
  } catch (e) { say(e.message, 'err'); sortBtn.disabled = false; }
}

startBtn.onclick = () => startCamera(select.value && select.value.length > 12 ? select.value : undefined);
select.onchange = () => stream && startCamera(select.value);
scanBtn.onclick = scan; sortBtn.onclick = sort;
loadStatus(); setInterval(loadStatus, 30000);
navigator.mediaDevices?.enumerateDevices && listCameras().catch(() => {});
