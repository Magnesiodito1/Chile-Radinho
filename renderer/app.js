'use strict';
const $ = id => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e };
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }], bundlePolicy: 'max-bundle' };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, v); return true } catch { return false } }
};

const myId = Math.random().toString(36).slice(2, 10);
const peers = new Map();   // id -> participante conectado por WebRTC
const tiles = new Map();   // 'me' | id -> bloco de vídeo
let room = null, sig = null, stream = null, hb = null, recvH = 9999, pickType = 'screen', renderPick = () => {}, pickRes = () => {}, roomT0 = 0, mic = null, mt = null, myAvatar = store.get('avatar', '');
const removedIds = new Set(), urows = new Map(), OKIMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

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
function av(n, e, img) {
  e = e || el('span', 'av');
  if (img && OKIMG.test(img)) { e.textContent = ''; e.style.background = `center/cover no-repeat url("${img}")` }
  else { e.textContent = [...n][0]?.toUpperCase() || '?'; e.style.background = `hsl(${hue(n)} 50% 45%)` }
  return e;
}
const avOf = n => n === myName() ? myAvatar : [...peers.values()].find(p => p.name === n)?.avatar || '';
const paintMe = () => { av(myName(), $('myav'), myAvatar); av(myName(), $('pav'), myAvatar); $('pDel').disabled = !myAvatar };
const fmtT = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600 | 0, s % 3600 / 60 | 0, s % 60].map(n => String(n).padStart(2, '0')).join(':') };
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
    t.append(m); w.append(h, t); d.append(av(n, null, avOf(n)), w);
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
  const box = $('users');
  if (!room) { urows.clear(); return box.replaceChildren() }
  const list = [{ k: 'me', name: myName() + ' (você)', base: myName(), live: !!stream, cls: 'ok', img: myAvatar, talk: !!mic },
    ...[...peers.values()].map(p => ({ k: p.id, p, name: p.name, base: p.name, live: p.sharing, ping: p.ping, img: p.avatar, talk: p.talking,
      cls: p.st === 'connected' ? lv(p.ping) : p.st === 'failed' ? 'bad' : 'wait', watching: !!stream && !p.paused && !p.removed && p.st === 'connected' }))];
  const keep = new Set(list.map(x => x.k));
  urows.forEach((v, k) => { if (!keep.has(k)) { v.r.remove(); urows.delete(k) } });
  list.forEach((x, i) => {
    let v = urows.get(x.k);
    if (!v) {
      v = { r: el('div', 'u'), a: el('span', 'av'), n: el('span', 'un'), t: el('span', 'ms', '🎤'), w: el('span', 'ms'), l: el('span', 'live', 'AO VIVO'), b: el('button', 'ic'), p: el('span', 'ms'), d: el('i', 'dot'), m: el('button', 'ic more', '⋯') };
      v.t.title = 'Microfone ligado'; v.m.title = 'Opções';
      v.r.append(v.a, v.n, v.t, v.w, v.l, v.b, v.p, v.d, v.m);
      if (x.p) {
        const q = x.p;
        v.b.onclick = () => toggleWatch(q);
        v.m.onclick = e => { const r = e.currentTarget.getBoundingClientRect(); openCtx(q, r.left, r.bottom + 4) };
        v.r.oncontextmenu = e => { e.preventDefault(); openCtx(q, e.clientX, e.clientY) };
      } else v.m.remove();
      urows.set(x.k, v);
    }
    if (v.base !== x.base || v.img !== x.img) { av(x.base, v.a, x.img); v.base = x.base; v.img = x.img }
    const wt = x.p?.removed ? ['⛔', 'Removido da sua transmissão'] : x.watching ? ['👀', 'Assistindo à sua transmissão'] : null;
    v.n.textContent = x.name; v.t.classList.toggle('hidden', !x.talk); v.l.classList.toggle('hidden', !x.live);
    v.w.classList.toggle('hidden', !wt); if (wt) { v.w.textContent = wt[0]; v.w.title = wt[1] }
    v.b.classList.toggle('hidden', !(x.p && x.live));
    if (x.p) { v.b.textContent = x.p.hidden ? '🙈' : '👁'; v.b.title = x.p.hidden ? 'Voltar a assistir' : 'Parar de assistir' }
    v.p.textContent = x.ping == null ? '' : x.ping + ' ms'; v.d.className = 'dot ' + x.cls;
    if (box.children[i] !== v.r) box.insertBefore(v.r, box.children[i] || null);
  });
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
  peers.forEach(p => { if (p.sharing && !p.hidden && !p.banned && p.st === 'connected' && p.rs.getTracks().length) want.set(p.id, { name: p.name, v: p.rs }) });
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
const guardOn = () => !!stream && stream.getAudioTracks().length > 0 && $('guard').checked;
function applyVoice(p) { p.au.muted = p.vmute || guardOn(); p.au.volume = p.vvol * +$('vol').value }
function echoGuard() {
  const g = guardOn();
  tiles.forEach((t, k) => { if (k !== 'me') t.video.muted = g || t.muted });
  peers.forEach(applyVoice);
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
      if (d.age > 0 && d.age < 2592e6) roomT0 = Math.min(roomT0 || Infinity, Date.now() - d.age);
      if (!p.joined) { p.joined = true; say('', p.name + ' entrou', 1) }
      renderTiles(); break;
    case 'share':
      if (!!d.on !== p.sharing) say('', p.name + (d.on ? ' começou a transmitir' : ' parou de transmitir'), 1);
      p.sharing = !!d.on; renderTiles(); break;
    case 'qual': p.maxH = +d.h || 9999; applyParams(p); break;
    case 'watch': p.paused = !d.on; applyParams(p); break;
    case 'mic': p.talking = !!d.on; renderUsers(); break;
    case 'kick': p.banned = true; say('', p.name + ' removeu você da transmissão dele.', 1); renderTiles(); break;
    case 'allow': p.banned = false; say('', p.name + ' readmitiu você na transmissão dele.', 1); renderTiles(); break;
    case 'av':
      if (!d.c) { p.avatar = ''; p.avb = null }
      else if (d.c <= 150) {
        if (d.i === 0) p.avb = [];
        if (p.avb && p.avb.length === d.i) { p.avb.push(String(d.d)); if (p.avb.length === d.c) { const u = p.avb.join(''); p.avb = null; p.avatar = u.length < 1.6e6 && OKIMG.test(u) ? u : '' } }
      }
      renderUsers(); break;
  }
}

// ---------- qualidade (por pessoa que assiste) ----------
function applyParams(p) {
  const [vs, as, ms] = p.pc.getTransceivers().map(t => t.sender), off = p.paused || p.removed;
  const set = (s, o) => { try { if (!s) return; const pr = s.getParameters(); if (!pr.encodings?.length) pr.encodings = [{}]; Object.assign(pr.encodings[0], o); s.setParameters(pr).catch(() => {}) } catch {} };
  const vt = stream?.getVideoTracks()[0];
  if (vt) {
    const H = Math.min(+$('res').value || 9999, p.maxH || 9999), cap = vt.getSettings().height || 1080, f = +$('fps').value;
    // teto de bitrate mais alto que antes (720p: 3,5 -> 5 Mbps): é o que deixava o 720p embaçado
    const br = (H <= 480 ? 2e6 : H <= 720 ? 5e6 : H <= 1080 ? 9e6 : 16e6) * (f >= 60 ? 1.5 : 1);
    set(vs, { active: !off, scaleResolutionDownBy: Math.max(1, cap / H), maxFramerate: f, maxBitrate: br, priority: 'high', networkPriority: 'high' });
  }
  set(as, { active: !off });          // áudio do PC: segue a transmissão
  set(ms, { maxBitrate: 48000 });     // voz: nunca é cortada por pausa/remoção
}
function hint() { const t = stream?.getVideoTracks()[0]; if (t && 'contentHint' in t) t.contentHint = $('pri').value }
async function outStats() {
  const p = [...peers.values()].find(p => p.st === 'connected' && !p.paused && !p.removed); if (!p || !stream) return '';
  for (const s of (await p.pc.getStats()).values()) if (s.type === 'outbound-rtp' && s.kind === 'video' && s.frameHeight) {
    const why = { bandwidth: 'banda', cpu: 'CPU' }[s.qualityLimitationReason];
    return `${s.frameHeight}p · ${Math.round(s.framesPerSecond || 0)} fps` + (why ? ' · limitado por ' + why : '');
  }
  return '';
}
$('res').onchange = $('fps').onchange = () => { if (stream) { hint(); peers.forEach(applyParams) } };
$('pri').onchange = () => { store.set('pri', $('pri').value); hint() };
$('vq').onchange = () => { recvH = +$('vq').value || 9999; bcast({ t: 'qual', h: recvH }) };
$('vol').oninput = () => { tiles.forEach(t => t.video.volume = +$('vol').value); peers.forEach(applyVoice) };
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
  if (vt && t) { const s = vt.getSettings(); t.inf.textContent = `${s.height || '?'}p · ${Math.round(s.frameRate || 0)} fps`; outStats().then(x => x && tiles.get('me') && (tiles.get('me').inf.textContent = x)) }
  renderUsers();
}, 2000);

// ---------- conexão entre pessoas (malha WebRTC) ----------
// Três faixas fixas por par (vídeo, áudio do PC e voz/microfone, nos dois sentidos). Começar/parar de transmitir
// só troca a faixa (replaceTrack), então não há renegociação e a sala segue de pé sem imagem.
async function attach(p) {
  const tr = [stream?.getVideoTracks()[0], stream?.getAudioTracks()[0], mic?.getAudioTracks()[0]];
  for (const [i, t] of p.pc.getTransceivers().entries()) { try { await t.sender.replaceTrack(tr[i] || null) } catch {} }
}
function mkPeer(id, name, init) {
  const pc = new RTCPeerConnection(ICE);
  const p = { id, pc, init, name: uniq(String(name || 'Anônimo').slice(0, 20), null), st: 'new', ping: null, maxH: 9999, rs: new MediaStream(), vs: new MediaStream(), au: new Audio(), sharing: false, hidden: false, paused: false, joined: false, info: '', talking: false, avatar: '', avb: null, vmute: false, vvol: 1, removed: removedIds.has(id), banned: false };
  peers.set(id, p); p.au.autoplay = true; p.au.srcObject = p.vs; applyVoice(p);
  p.ch = pc.createDataChannel('d', { negotiated: true, id: 0 });
  p.ch.onmessage = e => onMsg(p, e.data);
  p.ch.onopen = () => { send(p, { t: 'hi', n: myName(), age: Date.now() - roomT0 }); send(p, { t: 'share', on: !!stream }); send(p, { t: 'mic', on: !!mic }); if (p.removed) send(p, { t: 'kick' }); sendAvatar(p); send(p, { t: 'qual', h: recvH }); applyParams(p) };
  p.ch.onclose = () => dropPeer(p);
  pc.ontrack = e => { if (pc.getTransceivers().indexOf(e.transceiver) === 2) p.vs.addTrack(e.track); else { p.rs.addTrack(e.track); if (p.sharing) renderTiles() } };
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
  peers.delete(p.id); clearTimeout(p.timer); try { p.pc.close() } catch {} p.au.srcObject = null;
  if (!quiet && p.joined) say('', p.name + ' saiu', 1);
  renderTiles(); refreshStatus();
}
async function initiate(id, name) {
  if (peers.has(id) || !sig) return;
  const p = mkPeer(id, name, true);
  try {
    p.pc.addTransceiver('video', { direction: 'sendrecv' }); p.pc.addTransceiver('audio', { direction: 'sendrecv' }); p.pc.addTransceiver('audio', { direction: 'sendrecv' });
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
  room = code; roomT0 = Date.now(); store.set('lastRoom', code); $('msgs').replaceChildren();
  say('', 'Você entrou na sala ' + code + '. Ela continua aberta enquanto houver alguém nela.', 1);
  sig = openSig(code, onSig); hb = setInterval(hello, 30000);
  setStatus('Conectando à sala...', 'wait'); setRoomUi(true); tickTimer();
}
function leaveRoom(quiet) {
  stopShare(true); micStop(true); removedIds.clear(); roomT0 = 0;
  clearInterval(hb); sig?.close(); sig = null;
  peers.forEach(p => { clearTimeout(p.timer); try { p.pc.close() } catch {} p.au.srcObject = null }); peers.clear();
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
// ---------- microfone ----------
const micUi = () => { $('mic').classList.toggle('on', !!mic); $('mic').title = mic ? 'Desligar microfone' : 'Ativar microfone' };
const micArgs = () => ({ echoCancellation: $('mEC').checked, noiseSuppression: $('mNS').checked, autoGainControl: $('mAG').checked });
const openMic = id => navigator.mediaDevices.getUserMedia({ audio: id ? { ...micArgs(), deviceId: { exact: id } } : micArgs() });
async function micStart() {
  if (!room || mic) return;
  const id = $('micSel').value; let s;
  try { s = await openMic(id).catch(e => id ? openMic('') : Promise.reject(e)) }
  catch { setStatus('Não foi possível usar o microfone', 'bad'); return setTimeout(refreshStatus, 3000) }
  if (!room || mic) { s.getTracks().forEach(t => t.stop()); return }
  mic = s; mic.getAudioTracks()[0].onended = () => micStop();
  for (const p of peers.values()) await attach(p);
  bcast({ t: 'mic', on: true }); micUi(); refreshMics(); renderUsers(); say('', 'Microfone ligado.', 1);
}
function micStop(quiet) {
  if (!mic) return;
  const s = mic; mic = null; s.getTracks().forEach(t => { t.onended = null; t.stop() });
  peers.forEach(p => attach(p)); bcast({ t: 'mic', on: false }); micUi(); renderUsers();
  if (!quiet) say('', 'Microfone desligado.', 1);
}
async function micRestart() { micStop(true); await micStart() }
async function refreshMics(unlock) {
  const list = async () => { try { return (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications') } catch { return [] } };
  let d = await list();
  if (unlock && !mic && d.some(x => !x.label)) { try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); d = await list() } catch {} }
  const sel = $('micSel'), cur = store.get('micId', '');
  sel.replaceChildren(new Option('Padrão do sistema', ''), ...d.map((x, i) => new Option(x.label || 'Microfone ' + (i + 1), x.deviceId)));
  sel.value = d.some(x => x.deviceId === cur) ? cur : '';
}
// medidor de nível (teste do microfone, sem devolver o som nos alto-falantes)
function meterStop() { if (!mt) return; cancelAnimationFrame(mt.raf); mt.ctx.close().catch(() => {}); if (mt.own) mt.s.getTracks().forEach(t => t.stop()); mt = null; $('meter').style.width = '0'; $('mTest').textContent = 'Testar microfone' }
async function meterStart() {
  const s = mic || await openMic($('micSel').value), ctx = new AudioContext(), an = ctx.createAnalyser(), buf = new Uint8Array(512);
  an.fftSize = 512; ctx.createMediaStreamSource(s).connect(an);
  const m = mt = { ctx, s, own: s !== mic, raf: 0 };
  const loop = () => { an.getByteTimeDomainData(buf); let x = 0; for (const v of buf) x = Math.max(x, Math.abs(v - 128)); $('meter').style.width = Math.min(100, x / 50 * 100) + '%'; m.raf = requestAnimationFrame(loop) };
  loop(); $('mTest').textContent = 'Parar teste';
}
const meterRestart = () => { meterStop(); meterStart().catch(() => {}) };
$('mic').onclick = () => mic ? micStop() : micStart();
$('mTest').onclick = () => mt ? meterStop() : meterStart().catch(() => { $('mTest').textContent = 'Sem acesso ao microfone' });
$('micSel').onchange = () => { store.set('micId', $('micSel').value); if (mic) micRestart(); if (mt) meterRestart() };
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshMics());

// ---------- foto / GIF do perfil ----------
const readFile = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f) });
function sendAvatar(p) {
  if (!myAvatar) return send(p, { t: 'av', c: 0 });
  const n = Math.ceil(myAvatar.length / 12000);
  for (let i = 0; i < n; i++) send(p, { t: 'av', c: n, i, d: myAvatar.slice(i * 12000, (i + 1) * 12000) });
}
async function setAvatarFile(f) {
  const msg = t => $('pMsg').textContent = t;
  if (!f) return;
  try {
    let url;
    if (f.type === 'image/gif') {                       // GIF animado: vai como está (limite 1 MB)
      if (f.size > 1048576) return msg('GIF muito grande. O limite é 1 MB.');
      url = await readFile(f);
    } else {                                            // foto: recorta quadrado e reduz para 256 px
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
      const S = 256, c = document.createElement('canvas'), k = Math.max(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
      c.width = c.height = S; c.getContext('2d').drawImage(img, (S - w) / 2, (S - h) / 2, w, h); URL.revokeObjectURL(img.src);
      url = c.toDataURL('image/webp', 0.85);
    }
    if (!OKIMG.test(url)) return msg('Formato de imagem não suportado.');
    if (!store.set('avatar', url)) return msg('Não foi possível salvar a imagem.');
    myAvatar = url; paintMe(); renderUsers(); peers.forEach(sendAvatar); msg('Foto atualizada.');
  } catch { msg('Não foi possível abrir essa imagem.') }
}
$('pPick').onclick = () => $('pFile').click();
$('pFile').onchange = e => { setAvatarFile(e.target.files[0]); e.target.value = '' };
$('pDel').onclick = () => { store.set('avatar', ''); myAvatar = ''; paintMe(); renderUsers(); peers.forEach(sendAvatar); $('pMsg').textContent = 'Foto removida.' };

// ---------- menu de botão direito (usuário) ----------
const cx = $('ctx');
function closeCtx() { cx.classList.add('hidden'); cx.replaceChildren() }
function removeViewer(p, on) {
  if (on) removedIds.add(p.id); else removedIds.delete(p.id);
  p.removed = on; send(p, { t: on ? 'kick' : 'allow' }); applyParams(p); renderUsers();
  say('', on ? p.name + ' foi removido da sua transmissão.' + (stream ? '' : ' Ele não receberá suas próximas transmissões.') : p.name + ' voltou a receber sua transmissão.', 1);
}
function openCtx(p, x, y) {
  const it = (t, f, c) => { const b = el('button', 'ci' + (c ? ' ' + c : ''), t); b.onclick = () => { closeCtx(); f() }; return b };
  const head = el('div', 'ch'), rg = el('input'), vl = el('label', 'cv', '🔊');
  head.append(av(p.name, null, p.avatar), el('b', '', p.name));
  rg.type = 'range'; rg.min = 0; rg.max = 1; rg.step = .05; rg.value = p.vvol; rg.title = 'Volume da voz'; rg.oninput = () => { p.vvol = +rg.value; applyVoice(p) }; vl.append(rg);
  cx.replaceChildren(head,
    it(p.vmute ? '🎤 Ativar voz' : '🔇 Silenciar voz', () => { p.vmute = !p.vmute; applyVoice(p) }), vl,
    ...(p.sharing ? [it(p.hidden ? '👁 Voltar a assistir' : '🙈 Parar de assistir', () => toggleWatch(p))] : []),
    el('div', 'sep'),
    p.removed ? it('↩ Readmitir na transmissão', () => removeViewer(p, false)) : it('⛔ Remover da transmissão', () => removeViewer(p, true), 'red'));
  cx.classList.remove('hidden');
  cx.style.left = Math.max(4, Math.min(x, innerWidth - cx.offsetWidth - 4)) + 'px'; cx.style.top = Math.max(4, Math.min(y, innerHeight - cx.offsetHeight - 4)) + 'px';
}
document.addEventListener('mousedown', e => { if (!cx.contains(e.target)) closeCtx() });
addEventListener('keydown', e => { if (e.key === 'Escape') closeCtx() });
addEventListener('blur', closeCtx); addEventListener('resize', closeCtx);

// ---------- opções e personalização ----------
// Para criar uma nova aba: botão <button class="tab" data-tab="x"> e <section class="tp hidden" id="tp-x"> no index.html.
const bool = (k, d) => store.get(k, d) === '1';
const applyTheme = () => document.body.classList.toggle('amoled', bool('amoled', '0'));
const tickTimer = () => { $('info').textContent = room && bool('timer', '1') ? '⏱ ' + fmtT(Date.now() - roomT0) : '' };
setInterval(tickTimer, 1000);
const chk = (id, key, d, f) => { $(id).checked = bool(key, d); $(id).onchange = () => { store.set(key, $(id).checked ? '1' : '0'); f?.() } };
const remic = () => { if (mic) micRestart(); if (mt) meterRestart() };
chk('amo', 'amoled', '0', applyTheme); chk('tmr', 'timer', '1', tickTimer);
chk('mEC', 'mEC', '1', remic); chk('mNS', 'mNS', '1', remic); chk('mAG', 'mAG', '1', remic);
function showTab(n) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === n));
  document.querySelectorAll('.tp').forEach(s => s.classList.toggle('hidden', s.id !== 'tp-' + n));
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function openCfg(tab) { $('sigUrl').value = sigBase(); $('pName').value = $('me').value; showTab(tab); refreshMics(true); $('cfgDlg').showModal() }
$('cfgBtn').onclick = () => openCfg('opt'); $('myav').onclick = () => openCfg('per');
$('cfgDlg').addEventListener('close', meterStop);
$('cfgSave').onclick = () => {
  const v = $('sigUrl').value.trim();
  if (v !== sigBase()) {
    if (!/^https?:\/\/\S+$/.test(v)) return $('sigUrl').focus();
    store.set('sigUrl', v); if (room) say('', 'Servidor de códigos alterado. Saia e entre na sala de novo para aplicar.', 1);
  }
  $('cfgDlg').close();
};

// ---------- interface ----------
$('enter').onclick = () => enterRoom($('roomIn').value);
$('roomIn').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom($('roomIn').value) });
$('create').onclick = () => enterRoom(newCode());
$('last').onclick = () => enterRoom(store.get('lastRoom', ''));
$('exit').onclick = () => leaveRoom();
$('cpRoom').onclick = e => room && copyText(room, e.target);
$('cs').onclick = chat; $('ci').addEventListener('keydown', e => { if (e.key === 'Enter') chat() });
$('me').value = $('pName').value = store.get('nome', '');
$('me').oninput = () => { $('pName').value = $('me').value; paintMe() };
$('pName').oninput = () => { $('me').value = $('pName').value; paintMe() };
$('me').onchange = $('pName').onchange = () => { store.set('nome', $('me').value); bcast({ t: 'hi', n: myName(), age: Date.now() - roomT0 }); renderUsers() };
window.addEventListener('beforeunload', () => peers.forEach(p => { try { p.pc.close() } catch {} }));
$('pri').value = store.get('pri', 'detail'); $('info').title = 'Tempo de sala (sincronizado entre os participantes)';
applyTheme(); paintMe(); setRoomUi(false); micUi(); refreshMics();
