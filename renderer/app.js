'use strict';
const $ = id => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e };
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }], bundlePolicy: 'max-bundle' };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} }
};

const myId = Math.random().toString(36).slice(2, 10);
const peers = new Map();   // id -> participante conectado por WebRTC
const tiles = new Map();   // 'me' | id -> bloco de vídeo
let room = null, sig = null, stream = null, hb = null, recvH = 9999, pickType = 'screen', renderPick = () => {}, pickRes = () => {};

// ==== CODEC: SDP enxuto -> deflate -> embaralhado -> base62 ====
const SECRET = 'MAGDITO', B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', enc = new TextEncoder(), dec = new TextDecoder();
const fnv = b => { let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0 } return h >>> 0 };
const join = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o };
function keystream(n) { let s = fnv(enc.encode(SECRET)) || 1; const o = new Uint8Array(n); for (let i = 0; i < n; i++) { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; o[i] = (s >>> 11) & 255 } return o }
function toB62(b) { let n = 1n; for (const x of b) n = (n << 8n) | BigInt(x); const o = []; while (n > 0n) { o.push(B62[Number(n % 62n)]); n /= 62n } return o.reverse().join('') }
function fromB62(s) { let n = 0n; for (const c of s) { const i = B62.indexOf(c); if (i < 0) throw 0; n = n * 62n + BigInt(i) } const o = []; while (n > 1n) { o.push(Number(n & 255n)); n >>= 8n } return Uint8Array.from(o.reverse()) }
const pipe = async (b, t) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(t)).arrayBuffer());
function slim(sdp) {
  const seen = new Set();
  return sdp.split(/\r?\n/).filter(l => {
    if (!l) return false;
    if (l.startsWith('a=candidate:')) { const p = l.split(' '); if (p[2].toLowerCase() !== 'udp' || p[4].includes(':') || seen.has(l)) return false; seen.add(l); return true }
    if (['a=end-of-candidates', 'a=extmap-allow-mixed', 'a=ice-options:trickle'].includes(l)) return false;
    return !(l.startsWith('a=extmap:') && !/abs-send-time|transport-wide-cc|sdes:mid/.test(l));
  }).join('\r\n') + '\r\n';
}
async function pack(d) {
  const body = await pipe(enc.encode((d.type === 'offer' ? 'o' : 'a') + slim(d.sdp)), new CompressionStream('deflate-raw'));
  const c = fnv(join(enc.encode(SECRET), body)), buf = new Uint8Array(4 + body.length);
  buf.set([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]); buf.set(body, 4);
  const k = keystream(buf.length); for (let i = 0; i < buf.length; i++) buf[i] ^= k[i]; return toB62(buf);
}
async function unpack(code) {
  const buf = fromB62(code.replace(/[^0-9A-Za-z]/g, '')); if (buf.length < 8) throw 0;
  const k = keystream(buf.length); for (let i = 0; i < buf.length; i++) buf[i] ^= k[i];
  const c = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0, body = buf.slice(4);
  if (fnv(join(enc.encode(SECRET), body)) !== c) throw 0;
  const t = dec.decode(await pipe(body, new DecompressionStream('deflate-raw')));
  return { type: t[0] === 'o' ? 'offer' : 'answer', sdp: t.slice(1) };
}
// ==== FIM DO CODEC ====

// ---------- utilidades ----------
const setStatus = (t, k) => { $('st').textContent = t; $('dot').className = 'dot ' + (k || '') };
const lv = p => p == null ? 'wait' : p < 80 ? 'ok' : p < 200 ? 'mid' : 'bad';
const myName = () => $('me').value.trim().slice(0, 20) || 'Anônimo';
const uniq = (n, except) => { let x = n, i = 1; const taken = y => y === myName() || [...peers.values()].some(p => p !== except && p.name === y); while (taken(x)) x = n + ' ' + (++i); return x };
const ice = pc => new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 4000) });
const send = (p, o) => p.ch?.readyState === 'open' && p.ch.send(JSON.stringify(o));
const bcast = o => peers.forEach(p => send(p, o));
const hue = n => [...n].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360;
function av(n, e) { e = e || el('span', 'av'); e.textContent = [...n][0]?.toUpperCase() || '?'; e.style.background = `hsl(${hue(n)} 50% 45%)`; return e }
const stereo = x => x.replace('useinbandfec=1', 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000');
function restrict(pc) {
  for (const t of pc.getTransceivers()) {
    if (!t.setCodecPreferences) continue;
    const k = t.receiver.track.kind, cs = RTCRtpSender.getCapabilities(k)?.codecs; if (!cs) continue;
    const keep = k === 'audio' ? cs.filter(c => /opus/i.test(c.mimeType)) : [...cs.filter(c => /vp8/i.test(c.mimeType)).slice(0, 1), ...cs.filter(c => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || '')).slice(0, 1)];
    if (keep.length) try { t.setCodecPreferences(keep) } catch {}
  }
}
async function copyText(text, b) {
  try { await navigator.clipboard.writeText(text) } catch {}
  const o = b.textContent; b.textContent = 'Copiado ✔'; setTimeout(() => b.textContent = o, 1500);
}

// ---------- chat ----------
function say(n, m, sys) {
  const d = el('div', 'm' + (sys ? ' sys' : '')), box = $('msgs');
  if (sys) d.textContent = m;
  else {
    const h = el('div', 'mh'), b = el('b', '', n), t = el('div', 'mt'), w = el('div');
    b.style.color = `hsl(${hue(n)} 70% 72%)`;
    h.append(b, el('span', 'ms', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    t.append(m); w.append(h, t); d.append(av(n), w);
  }
  box.append(d); while (box.children.length > 200) box.firstChild.remove(); box.scrollTop = 1e9;
}
function chat() {
  const m = $('ci').value.trim(); if (!m || !room) return; $('ci').value = '';
  say(myName(), m); bcast({ t: 'c', m });
}

// ---------- estado da tela ----------
function refreshStatus() {
  if (!room) return setStatus('Fora de sala', '');
  const n = [...peers.values()].filter(p => p.st === 'connected').length;
  setStatus(n ? `Na sala · ${n + 1} pessoas` : 'Sala aberta · aguardando pessoas', n ? 'ok' : 'wait');
}
function renderEmpty() {
  const has = tiles.size > 0;
  $('tiles').classList.toggle('hidden', !has); $('empty').classList.toggle('hidden', has);
  $('bar').classList.toggle('hidden', !room);
  if (!has) {
    $('eIco').textContent = room ? '📺' : '🖥';
    $('eTxt').textContent = room
      ? `Sem imagem no momento. A sala continua aberta com o código ${room}. Qualquer pessoa pode compartilhar a tela.`
      : 'Entre em uma sala ou crie uma nova para começar.';
  }
}
function renderUsers() {
  if (!room) return $('users').replaceChildren();
  const row = (name, live, ping, cls, p) => {
    const r = el('div', 'u'); r.append(av(name), el('span', 'un', name));
    if (live) r.append(el('span', 'live', 'AO VIVO'));
    if (p && live) { const b = el('button', 'ic', p.hidden ? '🙈' : '👁'); b.title = p.hidden ? 'Voltar a assistir' : 'Parar de assistir'; b.onclick = () => toggleWatch(p); r.append(b) }
    r.append(el('span', 'ms', ping == null ? '' : ping + ' ms'), el('i', 'dot ' + cls));
    return r;
  };
  $('users').replaceChildren(
    row(myName() + ' (você)', !!stream, null, 'ok'),
    ...[...peers.values()].map(p => row(p.name, p.sharing, p.ping, p.st === 'connected' ? lv(p.ping) : p.st === 'failed' ? 'bad' : 'wait', p))
  );
}
function toggleWatch(p) { p.hidden = !p.hidden; send(p, { t: 'watch', on: !p.hidden }); renderTiles() }

function mkTile(k, w) {
  const box = el('div', 'tile'), video = el('video'), tag = el('div', 'tag'), nm = el('b'), inf = el('span', 'ms'), btns = el('div', 'tb'), fs = el('button', 'ic', '⛶');
  video.autoplay = true; video.playsInline = true; video.muted = !!w.self; video.volume = +$('vol').value;
  fs.title = 'Tela cheia'; fs.onclick = () => box.requestFullscreen?.(); video.ondblclick = fs.onclick;
  const t = { box, video, nm, inf, muted: !!w.self };
  if (!w.self) {
    const mu = el('button', 'ic', '🔊'); mu.title = 'Silenciar esta transmissão';
    mu.onclick = () => { t.muted = !t.muted; mu.textContent = t.muted ? '🔇' : '🔊'; echoGuard() };
    btns.append(mu);
  }
  btns.append(fs); tag.append(el('span', 'live', 'AO VIVO'), nm, inf); box.append(video, tag, btns);
  return t;
}
function renderTiles() {
  const want = new Map();
  if (stream) want.set('me', { name: myName() + ' (você)', v: stream, self: 1 });
  peers.forEach(p => { if (p.sharing && !p.hidden && p.st === 'connected' && p.rs.getTracks().length) want.set(p.id, { name: p.name, v: p.rs }) });
  tiles.forEach((t, k) => { if (!want.has(k)) { t.box.remove(); tiles.delete(k) } });
  want.forEach((w, k) => {
    let t = tiles.get(k);
    if (!t) { t = mkTile(k, w); tiles.set(k, t); $('tiles').append(t.box) }
    t.nm.textContent = w.name;
    if (t.video.srcObject !== w.v) { t.video.srcObject = w.v; t.video.play().catch(() => {}) }
  });
  echoGuard(); renderEmpty(); renderUsers();
}
// Capturar o áudio do sistema captura também o som das outras transmissões: silencia localmente para não gerar eco.
function echoGuard() {
  const g = !!stream && stream.getAudioTracks().length > 0 && $('guard').checked;
  tiles.forEach((t, k) => { if (k !== 'me') t.video.muted = g || t.muted });
  if (!g) echoGuard.said = false;
  else if (!echoGuard.said && [...tiles.keys()].some(k => k !== 'me')) {
    echoGuard.said = true;
    say('', 'Você está transmitindo o áudio do PC, então o som das outras transmissões fica silenciado aqui para evitar eco.', 1);
  }
}

// ---------- mensagens do canal de dados ----------
function onMsg(p, raw) {
  let d; try { d = JSON.parse(raw) } catch { return }
  switch (d.t) {
    case 'p': send(p, { t: 'q', ts: d.ts }); break;
    case 'q': p.ping = Math.round(performance.now() - d.ts); break;
    case 'c': say(p.name, String(d.m).slice(0, 500)); break;
    case 'hi':
      p.name = uniq(String(d.n || 'Anônimo').slice(0, 20), p);
      if (!p.joined) { p.joined = true; say('', p.name + ' entrou', 1) }
      renderTiles(); break;
    case 'share':
      if (!!d.on !== p.sharing) say('', p.name + (d.on ? ' começou a transmitir' : ' parou de transmitir'), 1);
      p.sharing = !!d.on; renderTiles(); break;
    case 'qual': p.maxH = +d.h || 9999; applyParams(p); break;
    case 'watch': p.paused = !d.on; applyParams(p); break;
  }
}

// ---------- qualidade (por pessoa que assiste) ----------
function applyParams(p) {
  if (!stream) return;
  const vt = stream.getVideoTracks()[0]; if (!vt) return;
  const vs = p.pc.getSenders().find(s => s.track === vt);
  if (vs) {
    const H = Math.min(+$('res').value || 9999, p.maxH || 9999), cap = vt.getSettings().height || 1080;
    const pr = vs.getParameters(); if (!pr.encodings?.length) pr.encodings = [{}];
    Object.assign(pr.encodings[0], { active: !p.paused, scaleResolutionDownBy: Math.max(1, cap / H), maxFramerate: +$('fps').value, maxBitrate: H <= 480 ? 1.5e6 : H <= 720 ? 3.5e6 : H <= 1080 ? 7e6 : 12e6 });
    vs.setParameters(pr).catch(() => {});
  }
  const as = p.pc.getSenders().find(s => s.track?.kind === 'audio');
  if (as) { const pr = as.getParameters(); if (pr.encodings?.length) { pr.encodings[0].active = !p.paused; as.setParameters(pr).catch(() => {}) } }
}
function hint() { const t = stream?.getVideoTracks()[0]; if (t && 'contentHint' in t) t.contentHint = +$('fps').value >= 30 ? 'motion' : 'detail' }
$('res').onchange = $('fps').onchange = () => { if (stream) { hint(); peers.forEach(applyParams) } };
$('vq').onchange = () => { recvH = +$('vq').value || 9999; bcast({ t: 'qual', h: recvH }) };
$('vol').oninput = () => tiles.forEach(t => t.video.volume = +$('vol').value);
$('guard').onchange = echoGuard;

// ---------- ping + estatísticas ----------
async function stats(p) {
  if (p.pc.connectionState !== 'connected') return;
  let r; for (const s of (await p.pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesPerSecond) r = s;
  p.info = r ? `${r.frameHeight || '?'}p · ${Math.round(r.framesPerSecond || 0)} fps` : '';
  const t = tiles.get(p.id); if (t) t.inf.textContent = p.info;
}
setInterval(() => {
  peers.forEach(p => { if (p.ch?.readyState === 'open') { send(p, { t: 'p', ts: performance.now() }); stats(p) } });
  const vt = stream?.getVideoTracks()[0], t = tiles.get('me');
  if (vt && t) { const s = vt.getSettings(); t.inf.textContent = `${s.height || '?'}p · ${Math.round(s.frameRate || 0)} fps` }
  renderUsers();
}, 2000);

// ---------- conexão entre pessoas (malha WebRTC) ----------
// Duas faixas fixas por par (vídeo e áudio, nos dois sentidos). Começar/parar de transmitir
// só troca a faixa (replaceTrack), então não há renegociação e a sala segue de pé sem imagem.
async function attach(p) {
  const vt = stream?.getVideoTracks()[0] || null, at = stream?.getAudioTracks()[0] || null;
  for (const t of p.pc.getTransceivers()) {
    try { await t.sender.replaceTrack(t.receiver.track.kind === 'video' ? vt : at) } catch {}
  }
}
function mkPeer(id, name, init) {
  const pc = new RTCPeerConnection(ICE);
  const p = { id, pc, init, name: uniq(String(name || 'Anônimo').slice(0, 20), null), st: 'new', ping: null, maxH: 9999, rs: new MediaStream(), sharing: false, hidden: false, paused: false, joined: false, info: '' };
  peers.set(id, p);
  p.ch = pc.createDataChannel('d', { negotiated: true, id: 0 });
  p.ch.onmessage = e => onMsg(p, e.data);
  p.ch.onopen = () => { send(p, { t: 'hi', n: myName() }); send(p, { t: 'share', on: !!stream }); send(p, { t: 'qual', h: recvH }); applyParams(p) };
  p.ch.onclose = () => dropPeer(p);
  pc.ontrack = e => { p.rs.addTrack(e.track); if (p.sharing) renderTiles() };
  pc.onconnectionstatechange = () => {
    p.st = pc.connectionState;
    if (p.st === 'connected') { clearTimeout(p.timer); applyParams(p) }
    if (p.st === 'failed' || p.st === 'closed') return dropPeer(p);
    renderTiles(); refreshStatus();
  };
  p.timer = setTimeout(() => { if (p.st !== 'connected') dropPeer(p, true) }, 25000);
  return p;
}
function dropPeer(p, quiet) {
  if (peers.get(p.id) !== p) return;
  peers.delete(p.id); clearTimeout(p.timer); try { p.pc.close() } catch {}
  if (!quiet && p.joined) say('', p.name + ' saiu', 1);
  renderTiles(); refreshStatus();
}
async function initiate(id, name) {
  if (peers.has(id) || !sig) return;
  const p = mkPeer(id, name, true);
  try {
    p.pc.addTransceiver('video', { direction: 'sendrecv' }); p.pc.addTransceiver('audio', { direction: 'sendrecv' });
    await attach(p); restrict(p.pc);
    const o = await p.pc.createOffer(); o.sdp = stereo(o.sdp); await p.pc.setLocalDescription(o); await ice(p.pc);
    sig?.send({ k: 'offer', from: myId, to: id, n: myName(), d: await pack(p.pc.localDescription) });
  } catch { dropPeer(p, true) }
}
async function onOffer(m) {
  let p = peers.get(m.from);
  if (p && p.st === 'connected') return;
  if (p) dropPeer(p, true);
  p = mkPeer(m.from, m.n, false);
  try {
    await p.pc.setRemoteDescription(await unpack(m.d));
    p.pc.getTransceivers().forEach(t => t.direction = 'sendrecv');
    await attach(p); restrict(p.pc);
    const a = await p.pc.createAnswer(); a.sdp = stereo(a.sdp); await p.pc.setLocalDescription(a); await ice(p.pc);
    sig?.send({ k: 'answer', from: myId, to: m.from, d: await pack(p.pc.localDescription) });
  } catch { dropPeer(p, true) }
}
async function onAnswer(m) {
  const p = peers.get(m.from);
  if (!p || !p.init || p.pc.signalingState !== 'have-local-offer') return;
  try { await p.pc.setRemoteDescription(await unpack(m.d)) } catch { dropPeer(p, true) }
}

// ---------- sinalização por código (ntfy só troca as mensagens de conexão; vídeo e chat vão direto) ----------
const sigBase = () => store.get('sigUrl', 'https://ntfy.sh').replace(/\/+$/, '');
function openSig(code, on) {
  const url = sigBase() + '/mtela-' + code; let es;
  const open = () => {
    es = new EventSource(url + '/sse');
    es.onopen = () => on({ k: 'open' });
    es.onmessage = e => { try { on(JSON.parse(JSON.parse(e.data).message)) } catch {} };
    es.onerror = () => on({ k: 'err' });
  };
  open();
  return { send: o => fetch(url, { method: 'POST', body: JSON.stringify(o) }).catch(() => {}), close: () => es.close() };
}
const hello = () => sig?.send({ k: 'hello', from: myId, n: myName() });
// Quem tem o id menor faz a oferta; assim nunca há duas ofertas ao mesmo tempo para o mesmo par.
function learn(id, name) { if (!peers.has(id) && myId < id) initiate(id, name) }
function onSig(m) {
  if (m.k === 'open') { hello(); return }
  if (m.k === 'err') { if (!peers.size) setStatus('Sem acesso ao servidor de códigos. Tentando de novo...', 'bad'); return }
  if (!m.from || m.from === myId || (m.to && m.to !== myId)) return;
  if (m.k === 'hello') {
    const p = peers.get(m.from);
    if (!p || p.st !== 'connected') { sig?.send({ k: 'here', from: myId, to: m.from, n: myName() }); learn(m.from, m.n) }
  }
  else if (m.k === 'here') learn(m.from, m.n);
  else if (m.k === 'offer') onOffer(m);
  else if (m.k === 'answer') onAnswer(m);
}

// ---------- salas ----------
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
function setRoomUi(on) {
  $('joinBox').classList.toggle('hidden', on); $('roomBox').classList.toggle('hidden', !on);
  $('ci').disabled = $('cs').disabled = !on; $('room').textContent = room || '—';
  const last = store.get('lastRoom', '');
  $('last').classList.toggle('hidden', !last || on); $('last').textContent = 'Voltar para a sala ' + last;
  renderTiles(); refreshStatus();
}
function enterRoom(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) return setStatus('Código de sala inválido', 'bad');
  if (!('CompressionStream' in window)) return setStatus('Navegador sem suporte', 'bad');
  if (room) leaveRoom(true);
  room = code; store.set('lastRoom', code); $('msgs').replaceChildren();
  say('', 'Você entrou na sala ' + code + '. Ela continua aberta enquanto houver alguém nela.', 1);
  sig = openSig(code, onSig); hb = setInterval(hello, 30000);
  setStatus('Conectando à sala...', 'wait'); setRoomUi(true);
}
function leaveRoom(quiet) {
  stopShare(true);
  clearInterval(hb); sig?.close(); sig = null;
  peers.forEach(p => { clearTimeout(p.timer); try { p.pc.close() } catch {} }); peers.clear();
  room = null; $('users').replaceChildren(); $('info').textContent = '';
  if (!quiet) { $('msgs').replaceChildren(); setRoomUi(false) }
}

// ---------- compartilhar a tela ----------
function pickSource() {
  return api.sources().then(list => new Promise(res => {
    let done = 0; const fin = v => { if (!done) { done = 1; res(v) } };
    renderPick = () => $('pickList').replaceChildren(...list.filter(s => s.type === pickType).map(s => {
      const b = el('button', 'pk'), i = el('img'); i.src = s.thumb; b.append(i, el('span', '', s.name));
      b.onclick = () => { fin(s); $('picker').close() }; return b;
    }));
    $('pkS').classList.toggle('on', pickType === 'screen'); $('pkW').classList.toggle('on', pickType === 'window');
    renderPick();
    $('picker').addEventListener('close', () => fin(null), { once: true });
    $('picker').showModal();
  }));
}
$('pkS').onclick = () => { pickType = 'screen'; $('pkS').classList.add('on'); $('pkW').classList.remove('on'); renderPick() };
$('pkW').onclick = () => { pickType = 'window'; $('pkW').classList.add('on'); $('pkS').classList.remove('on'); renderPick() };
$('pickCancel').onclick = () => $('picker').close();

async function startShare() {
  if (!room || stream) return;
  const opt = { video: { frameRate: { ideal: +$('fps').value }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: $('aud').checked && { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  try {
    if (window.api) { const src = await pickSource(); if (!src) return; await api.choose(src.id) }
    stream = await navigator.mediaDevices.getDisplayMedia(opt);
  } catch { stream = null; return setStatus('Captura cancelada ou bloqueada', 'bad') }
  stream.getVideoTracks()[0].onended = () => stopShare();
  stream.getAudioTracks().forEach(t => t.contentHint = 'music'); hint();
  $('aud').disabled = true; $('go').textContent = '⏹ Parar de compartilhar'; $('go').classList.add('danger');
  for (const p of peers.values()) { await attach(p); applyParams(p) }
  bcast({ t: 'share', on: true });
  say('', 'Você começou a transmitir' + (stream.getAudioTracks().length ? ' (com áudio).' : ' (sem áudio).'), 1);
  if ($('aud').checked && !stream.getAudioTracks().length) say('', 'Nenhum áudio foi capturado. No navegador comum, escolha "Tela inteira" e marque "Compartilhar áudio do sistema".', 1);
  renderTiles(); refreshStatus();
}
function stopShare(quiet) {
  if (!stream) return;
  const s = stream; stream = null;
  s.getTracks().forEach(t => { t.onended = null; t.stop() });
  peers.forEach(p => attach(p)); bcast({ t: 'share', on: false });
  $('aud').disabled = false; $('go').textContent = '🖥 Compartilhar tela'; $('go').classList.remove('danger');
  if (!quiet) say('', 'Você parou de transmitir. A sala continua aberta.', 1);
  renderTiles();
}
$('go').onclick = () => stream ? stopShare() : startShare();

// ---------- pop-up (janela flutuante sempre no topo) ----------
$('pop').onclick = async () => {
  const tl = $('tiles');
  if (window.documentPictureInPicture && !tl.classList.contains('hidden')) {
    try {
      const w = await documentPictureInPicture.requestWindow({ width: 640, height: 400 });
      for (const l of document.querySelectorAll('link[rel=stylesheet]')) { const n = w.document.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; w.document.head.append(n) }
      w.document.body.className = 'pip'; w.document.body.append(tl);
      w.addEventListener('pagehide', () => $('stage').insertBefore(tl, $('bar')));
      return;
    } catch {}
  }
  const v = [...document.querySelectorAll('#tiles video')].find(v => v.srcObject);
  if (v && document.pictureInPictureEnabled) document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture().catch(() => {});
  else setStatus('Nada para abrir em pop-up', 'bad');
};

// ---------- interface ----------
$('enter').onclick = () => enterRoom($('roomIn').value);
$('roomIn').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom($('roomIn').value) });
$('create').onclick = () => enterRoom(newCode());
$('last').onclick = () => enterRoom(store.get('lastRoom', ''));
$('exit').onclick = () => leaveRoom();
$('cpRoom').onclick = e => room && copyText(room, e.target);
$('cs').onclick = chat; $('ci').addEventListener('keydown', e => { if (e.key === 'Enter') chat() });
$('me').value = store.get('nome', '');
$('me').oninput = () => av(myName(), $('myav'));
$('me').onchange = () => { store.set('nome', $('me').value); bcast({ t: 'hi', n: myName() }); renderUsers() };
$('cfgBtn').onclick = () => { $('sigUrl').value = sigBase(); $('cfgDlg').showModal() };
$('cfgCancel').onclick = () => $('cfgDlg').close();
$('cfgSave').onclick = () => {
  const v = $('sigUrl').value.trim();
  if (/^https?:\/\/\S+$/.test(v)) { store.set('sigUrl', v); $('cfgDlg').close(); if (room) say('', 'Servidor de códigos alterado. Saia e entre na sala de novo para aplicar.', 1) }
};
window.addEventListener('beforeunload', () => peers.forEach(p => { try { p.pc.close() } catch {} }));
av(myName(), $('myav')); setRoomUi(false);
