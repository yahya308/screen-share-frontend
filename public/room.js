/**
 * VELOSTREAM Room - v2
 * Features: nickname, user list, chat, viewer mic (VAD), moderasyon (kick/ban)
 */

import { Device } from 'mediasoup-client';

// ==================== URL PARAMS ====================

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
const isAdminMode = urlParams.get('admin') === 'true';

if (!roomId) window.location.href = 'index.html';

// ==================== STATE ====================

let socket;
let device;
let producerTransport;    // Admin: send transport for screen share
let consumerTransport;    // Everyone: receive transport
let viewerSendTransport;  // Viewers: send transport for mic

let videoProducer     = null;
let micProducer       = null;  // Admin own mic (mixed)
let systemAudioProducer = null;
let mixedAudioProducer  = null;
let viewerMicProducer   = null; // Viewer mic producer

let systemAudioTrack = null;
let micTrack         = null;   // Admin own mic track
let viewerMicTrack   = null;   // Viewer mic track

let audioContext     = null;
const consumers      = new Map(); // consumerId -> consumer

// Audio oynatma state'i — video mute'tan BAĞIMSIZ (B4 düzeltmesi)
let audioMutedState  = false;
// Autoplay politikası yüzünden bekleyen (henüz çalamayan) audio elementleri (B2a)
const pendingAudioElements = new Set();

let isAdmin          = false;
let myNickname       = '';
let mySocketId       = '';
let adminSocketId    = null;   // U1: yayın sahibi konuşunca video kenarını vurgula

let viewerMicEnabled = true;  // Can viewers use mic? (admin controls this)
let chatEnabled      = true;  // Is chat open? (admin controls this)

let currentQuality   = 'auto';
let videoConsumer    = null;
const iceRestartState = new WeakMap();

// Stats
let statsInterval  = null;
let lastStats      = { timestamp: 0, bytes: 0 };
let statsStarted   = false;

// VAD (Voice Activity Detection)
let vadInterval    = null;
let vadAnalyser    = null;
let vadContext     = null;
let vadWasSpeaking = false;

// ==================== DOM REFS ====================

const roomName       = document.getElementById('roomName');
const userCount      = document.getElementById('userCount');
const btnInvite      = document.getElementById('btnInvite');
const remoteVideo    = document.getElementById('remoteVideo');
const localVideo     = document.getElementById('localVideo');
const pausedOverlay  = document.getElementById('pausedOverlay');
const waitingOverlay = document.getElementById('waitingOverlay');
const videoContainer = document.getElementById('videoContainer');

// Admin elements
const adminPanel         = document.getElementById('adminPanel');
const viewerInfo         = document.getElementById('viewerInfo');
const viewerControls     = document.getElementById('viewerControls');
const btnStartStream     = document.getElementById('btnStartStream');
const btnStopStream      = document.getElementById('btnStopStream');
const btnToggleMic       = document.getElementById('btnToggleMic');
const btnToggleAudio     = document.getElementById('btnToggleAudio');
const btnToggleViewerMic = document.getElementById('btnToggleViewerMic');
const btnToggleChat      = document.getElementById('btnToggleChat');
const btnCloseRoom       = document.getElementById('btnCloseRoom');
const btnUpdateMaxUsers  = document.getElementById('btnUpdateMaxUsers');
const maxUsersInput      = document.getElementById('maxUsersInput');
const resSelect          = document.getElementById('resSelect');
const fpsSelect          = document.getElementById('fpsSelect');
const bitrateInput       = document.getElementById('bitrateInput');

// Viewer elements
const btnViewerMic  = document.getElementById('btnViewerMic');
const btnLeaveRoom  = document.getElementById('btnLeaveRoom');

// Viewer playback controls
const btnPlayPause   = document.getElementById('btnPlayPause');
const iconPlay       = document.getElementById('iconPlay');
const iconPause      = document.getElementById('iconPause');
const btnMute        = document.getElementById('btnMute');
const iconVolumeOn   = document.getElementById('iconVolumeOn');
const iconVolumeOff  = document.getElementById('iconVolumeOff');
const volumeSlider   = document.getElementById('volumeSlider');
const qualitySelect  = document.getElementById('qualitySelect');
const btnFullscreen  = document.getElementById('btnFullscreen');
const btnStats       = document.getElementById('btnStats');

// Stats panel
const statsPanel   = document.getElementById('statsPanel');
const statsBitrate = document.getElementById('statsBitrate');
const statsFps     = document.getElementById('statsFps');
const statsRtt     = document.getElementById('statsRtt');
const statsLoss    = document.getElementById('statsLoss');
const statsJitter  = document.getElementById('statsJitter');

// Modals
const nicknameModal    = document.getElementById('nicknameModal');
const nicknameInput    = document.getElementById('nicknameInput');
const nicknameError    = document.getElementById('nicknameError');
const btnConfirmNickname = document.getElementById('btnConfirmNickname');

const leaveModal      = document.getElementById('leaveModal');
const btnCancelLeave  = document.getElementById('btnCancelLeave');
const btnConfirmLeave = document.getElementById('btnConfirmLeave');

// Chat
const chatMessages    = document.getElementById('chatMessages');
const chatInput       = document.getElementById('chatInput');
const btnSendChat     = document.getElementById('btnSendChat');
const chatInputArea   = document.getElementById('chatInputArea');
const chatDisabledMsg = document.getElementById('chatDisabledMsg');
const chatStatusBadge = document.getElementById('chatStatusBadge');

// User list
const userListContainer = document.getElementById('userListContainer');
const userCountBadge    = document.getElementById('userCountBadge');

// Toast
const toast        = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// ==================== NICKNAME MODAL ====================

function validateNicknameClient(nick) {
    if (!nick || !nick.trim()) return 'Nickname gerekli';
    const t = nick.trim();
    if (t.length < 3) return 'En az 3 karakter olmalı';
    if (t.length > 30) return 'En fazla 30 karakter olmalı';
    if (/\s/.test(t)) return 'Boşluk içeremez';
    if (/^[0-9]+$/.test(t)) return 'Yalnızca rakamlardan oluşamaz';
    if (!/^[a-zA-Z0-9\u00c0-\u024f_-]+$/.test(t)) return 'Sadece harf, rakam, _ ve - kullanılabilir';
    return null;
}

function showNicknameModal() {
    return new Promise((resolve) => {
        const saved = sessionStorage.getItem('velo_nickname');
        if (saved) {
            const err = validateNicknameClient(saved);
            if (!err) { resolve(saved.trim()); return; }
        }

        nicknameModal.classList.remove('hidden');
        nicknameModal.classList.add('flex');
        nicknameInput.focus();

        const confirm = () => {
            const val = nicknameInput.value.trim();
            const err = validateNicknameClient(val);
            if (err) {
                nicknameError.textContent = err;
                nicknameError.classList.remove('hidden');
                return;
            }
            nicknameError.classList.add('hidden');
            sessionStorage.setItem('velo_nickname', val);
            nicknameModal.classList.add('hidden');
            nicknameModal.classList.remove('flex');
            resolve(val);
        };

        btnConfirmNickname.onclick = confirm;
        nicknameInput.onkeydown = (e) => { if (e.key === 'Enter') confirm(); };
    });
}

// ==================== SOCKET / INIT ====================

async function getConfig() {
    try {
        const r = await fetch('/api/config', { cache: 'no-store' });
        if (!r.ok) return {};
        return await r.json();
    } catch { return {}; }
}

async function initSocket(nickname) {
    const config = await getConfig();
    const signalingUrl = config.signalingUrl || window.location.origin;

    socket = io(signalingUrl, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });
    myNickname = nickname;

    registerSocketEvents();

    socket.on('connect', () => {
        mySocketId = socket.id;
        console.log('Connected:', socket.id);

        if (isAdminMode) {
            socket.emit('admin-rejoin', { roomId, nickname }, (result) => {
                if (result.error) {
                    if (result.error.includes('nickname') || result.error.includes('Nickname')) {
                        sessionStorage.removeItem('velo_nickname');
                        showToast(result.error);
                        setTimeout(() => window.location.reload(), 1500);
                    } else {
                        showToast(result.error);
                        setTimeout(() => window.location.href = 'index.html', 2000);
                    }
                    return;
                }

                roomName.textContent = result.roomName;
                userCount.textContent = result.userCount || 1;
                maxUsersInput.value = result.maxUsers || 100;
                viewerMicEnabled = result.viewerMicEnabled ?? true;
                chatEnabled = result.chatEnabled ?? true;

                isAdmin = true;
                setupAdminUI();
                updateViewerMicToggle();
                updateChatToggle();
                initMediasoup();
            });
        } else {
            const storedPassword = sessionStorage.getItem(`room_password_${roomId}`);
            attemptJoinRoom(storedPassword, nickname);
        }
    });

    socket.on('disconnect', (reason) => {
        showToast('Sunucu bağlantısı kesildi, yeniden bağlanılıyor...', 'warning');
    });

    // V4/U5: Yeniden bağlanınca bilgilendir (connect handler zaten yeniden join yapar)
    socket.io.on('reconnect', () => {
        showToast('Yeniden bağlandı', 'success');
    });

    socket.io.on('reconnect_attempt', () => {
        // sessizce deniyoruz
    });
}

function registerSocketEvents() {
    // User count updates
    socket.on('user-joined', ({ userCount: c }) => { userCount.textContent = c; });
    socket.on('user-left', ({ userCount: c }) => { userCount.textContent = c; });

    // Full user list
    socket.on('user-list', (users) => renderUserList(users));

    // Mediasoup events
    // new-producer artık { id, kind, source } objesi gönderiyor (eski id-only ile uyumlu)
    socket.on('new-producer', (data) => {
        const producerId = typeof data === 'object' ? data.id : data;
        consumeProducer(producerId, typeof data === 'object' ? data : null);
    });

    socket.on('stream-started', () => {
        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');
        if (!device) initMediasoup();
        else getProducers();
    });

    socket.on('stream-paused', () => pausedOverlay.classList.remove('hidden'));

    socket.on('producer-closed', ({ remoteProducerId }) => {
        // B2b: Bu artık backup görevi görür — asıl temizlik consumer'ın
        // 'producerclose' event'inde (attachConsumerCleanup) yapılır.
        for (const [id, consumer] of [...consumers]) {
            if (consumer.producerId === remoteProducerId) {
                closeAndRemoveConsumer(consumer);
            }
        }
    });

    // Room events
    socket.on('room-closed', ({ reason }) => {
        showToast(reason || 'Oda kapatıldı');
        setTimeout(() => window.location.href = 'index.html', 2000);
    });

    // Moderation
    socket.on('you-were-kicked', () => {
        alert('Oda sahibi tarafından odadan atıldınız!');
        window.location.href = 'index.html';
    });

    socket.on('you-were-banned', () => {
        alert('Oda sahibi tarafından BU ODADAN BANLANDINIZ! Artık bu sunucu çalışırken giriş yapamazsınız.');
        window.location.href = 'index.html';
    });

    // Viewer mic state changed by admin
    socket.on('viewer-mic-state', ({ enabled }) => {
        viewerMicEnabled = enabled;
        if (!isAdmin) {
            updateViewerMicButton();
            if (!enabled && viewerMicProducer) {
                // Admin disabled viewer mic — stop ours
                closeViewerMic();
                showToast('Mikrofon özelliği oda sahibi tarafından kapatıldı');
            }
        } else {
            updateViewerMicToggle();
        }
    });

    // Chat state changed by admin
    socket.on('chat-state', ({ enabled }) => {
        chatEnabled = enabled;
        updateChatUI();
        if (isAdmin) updateChatToggle();
    });

    // Incoming chat message
    socket.on('chat-message', ({ socketId, nickname, role, message, timestamp }) => {
        appendChatMessage({ socketId, nickname, role, message, timestamp });
    });

    // Voice activity
    socket.on('voice-activity', ({ socketId, speaking }) => {
        updateSpeakingIndicator(socketId, speaking);
    });
}

// ==================== JOIN / SETUP ====================

function attemptJoinRoom(password, nickname) {
    socket.emit('join-room', { roomId, password, nickname }, (result) => {
        if (result.error) {
            if (result.needPassword) {
                showPasswordModal(nickname);
            } else if (result.banned) {
                showToast(result.error);
                setTimeout(() => window.location.href = 'index.html', 3000);
            } else if (result.blocked) {
                showToast(result.error);
                setTimeout(() => window.location.href = 'index.html', 3000);
            } else if (result.error.includes('nickname') || result.error.includes('Nickname') || result.error.includes('kullanılıyor')) {
                sessionStorage.removeItem('velo_nickname');
                showToast(result.error);
                setTimeout(() => window.location.reload(), 1500);
            } else {
                showToast(result.error);
                setTimeout(() => window.location.href = 'index.html', 2000);
            }
            return;
        }

        sessionStorage.removeItem(`room_password_${roomId}`);
        roomName.textContent = result.roomName;
        userCount.textContent = result.userCount || 1;
        viewerMicEnabled = result.viewerMicEnabled ?? true;
        chatEnabled = result.chatEnabled ?? true;

        isAdmin = false;
        setupViewerUI();
        updateViewerMicButton();
        updateChatUI();

        if (result.isStreaming) initMediasoup();
    });
}

function showPasswordModal(nickname) {
    const modal    = document.getElementById('passwordModal');
    const input    = document.getElementById('passwordInput');
    const btnOk    = document.getElementById('btnSubmitPassword');
    const btnBack  = document.getElementById('btnCancelPassword');
    const errorEl  = document.getElementById('passwordModalError');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    input.value = '';
    input.focus();
    errorEl.classList.add('hidden');

    const handleSubmit = () => {
        const pw = input.value;
        if (!pw) { errorEl.textContent = 'Şifre girin'; errorEl.classList.remove('hidden'); return; }

        socket.emit('join-room', { roomId, password: pw, nickname }, (result) => {
            if (result.error) {
                if (result.needPassword) {
                    errorEl.textContent = `Yanlış şifre (${result.remainingAttempts ?? '?'} deneme)`;
                    errorEl.classList.remove('hidden');
                } else if (result.blocked) {
                    modal.classList.add('hidden');
                    showToast(result.error);
                    setTimeout(() => window.location.href = 'index.html', 3000);
                } else {
                    errorEl.textContent = result.error;
                    errorEl.classList.remove('hidden');
                }
                return;
            }
            modal.classList.add('hidden');
            roomName.textContent = result.roomName;
            userCount.textContent = result.userCount || 1;
            viewerMicEnabled = result.viewerMicEnabled ?? true;
            chatEnabled = result.chatEnabled ?? true;
            isAdmin = false;
            setupViewerUI();
            updateViewerMicButton();
            updateChatUI();
            if (result.isStreaming) initMediasoup();
        });
    };

    btnOk.onclick = handleSubmit;
    input.onkeydown = (e) => { if (e.key === 'Enter') handleSubmit(); };
    btnBack.onclick = () => { modal.classList.add('hidden'); window.location.href = 'index.html'; };
}

function setupAdminUI() {
    adminPanel.classList.remove('hidden');
    viewerInfo.classList.add('hidden');
    localVideo.classList.remove('hidden');
    remoteVideo.classList.add('hidden');
    waitingOverlay.classList.add('hidden');

    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = 'Sekmeyi kapatırsanız odanız silinecektir!';
    });
}

function setupViewerUI() {
    adminPanel.classList.add('hidden');
    viewerInfo.classList.remove('hidden');
    viewerControls.classList.remove('hidden');
    localVideo.classList.add('hidden');
    remoteVideo.classList.remove('hidden');

    // U4: İzleyiciler için de çıkış uyarısı
    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
    });
}

// ==================== USER LIST ====================

function renderUserList(users) {
    if (!Array.isArray(users)) return;

    userCountBadge.textContent = users.length;
    userCount.textContent = users.length;
    userListContainer.innerHTML = '';

    // U1: Admin socket ID'sini bul (video speaking göstergesi için)
    const admin = users.find(u => u.role === 'admin');
    adminSocketId = admin ? admin.socketId : null;

    users.forEach(user => {
        const isMe = user.socketId === mySocketId;
        const isOwner = user.role === 'admin';
        const initials = (user.nickname || '?')[0].toUpperCase();

        const item = document.createElement('div');
        item.className = 'flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700/50 transition-colors';
        item.dataset.socketId = user.socketId;

        // Avatar with speaking indicator
        item.innerHTML = `
            <div class="relative flex-shrink-0">
                <div class="w-7 h-7 rounded-full bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center text-xs font-bold text-white">
                    ${escapeHtml(initials)}
                </div>
                <div id="speaking_${user.socketId}" class="${user.speaking ? '' : 'hidden'} absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 ring-2 ring-slate-800 animate-pulse"></div>
            </div>
            <div class="flex-1 min-w-0">
                <span class="text-sm truncate block ${isOwner ? 'text-yellow-400 font-semibold' : 'text-slate-200'}">
                    ${isOwner ? '👑 ' : ''}${escapeHtml(user.nickname)}${isMe ? ' <span class="text-slate-500 text-xs">(Sen)</span>' : ''}
                </span>
            </div>
            ${isAdmin && !isOwner && !isMe ? `
                <div class="flex gap-1 flex-shrink-0">
                    <button onclick="kickUser('${escapeHtml(user.socketId)}')" title="Kick"
                        class="p-1 text-orange-400 hover:bg-orange-500/20 rounded transition-colors text-xs">✱</button>
                    <button onclick="banUser('${escapeHtml(user.socketId)}')" title="Ban"
                        class="p-1 text-red-400 hover:bg-red-500/20 rounded transition-colors text-xs">🚫</button>
                </div>
            ` : ''}
        `;

        userListContainer.appendChild(item);
    });
}

function updateSpeakingIndicator(socketId, speaking) {
    const el = document.getElementById(`speaking_${socketId}`);
    if (!el) return;
    if (speaking) el.classList.remove('hidden');
    else el.classList.add('hidden');

    // U1: Yayın sahibi (admin) konuşuyorsa video alanında konuşma halkası göster
    if (socketId === adminSocketId && videoContainer) {
        if (speaking) videoContainer.classList.add('speaking-ring');
        else videoContainer.classList.remove('speaking-ring');
    }
}

// Kick / Ban (called from HTML onclick)
window.kickUser = function(targetSocketId) {
    if (!isAdmin) return;
    if (!confirm('Bu kullanıcıyı odadan atmak istiyor musunuz? (Tekrar girebilir)')) return;
    socket.emit('kick-user', { targetSocketId }, (result) => {
        if (result?.error) showToast(result.error);
        else showToast('Kullanıcı odadan atıldı', 'success');
    });
};

window.banUser = function(targetSocketId) {
    if (!isAdmin) return;
    if (!confirm('Bu kullanıcıyı BAN\'lamak istiyor musunuz? (Bu sunucu oturumunda odaya giremez)')) return;
    socket.emit('ban-user', { targetSocketId }, (result) => {
        if (result?.error) showToast(result.error);
        else showToast('Kullanıcı banlandı', 'success');
    });
};

// ==================== MEDIASOUP ====================

/**
 * Tüm mediasoup state'ini (consumer, transport, audio element, device) temizler.
 * Yeniden bağlanma (reconnect) ve yeniden init durumlarında eski/çift element
 * birikmesini önler (V4/U5).
 */
function resetMediaState() {
    // Bekleyen autoplay elementlerini temizle
    pendingAudioElements.clear();
    // Tüm consumer'ları ve audio elementlerini kapat
    for (const [, consumer] of [...consumers]) {
        closeAndRemoveConsumer(consumer);
    }
    consumers.clear();
    videoConsumer = null;
    // Transport'ları kapat
    try { if (producerTransport) producerTransport.close(); } catch (e) {}
    try { if (consumerTransport) consumerTransport.close(); } catch (e) {}
    try { if (viewerSendTransport) viewerSendTransport.close(); } catch (e) {}
    producerTransport = consumerTransport = viewerSendTransport = null;
    // Device'ı sıfırla (yeniden load edilebilmesi için)
    device = null;
    // Video alanını temizle
    if (remoteVideo.srcObject) {
        try { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); } catch (e) {}
        remoteVideo.srcObject = null;
    }
    // Konuşma göstergesini sıfırla
    if (videoContainer) videoContainer.classList.remove('speaking-ring');
}

async function initMediasoup() {
    socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
        if (rtpCapabilities.error) { showToast(rtpCapabilities.error); return; }

        // Cihaz zaten yüklüyse (reconnect / yeniden giriş) eski state'i temizle
        if (device) resetMediaState();

        device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });

        if (isAdmin) {
            createSendTransport();
            createRecvTransport();
        }
        else {
            createRecvTransport();
        }
    });
}

function createSendTransport() {
    socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
        if (params.error) { console.error(params.error); return; }

        producerTransport = device.createSendTransport(params);
        attachTransportHandlers(producerTransport);

        producerTransport.on('connect', ({ dtlsParameters }, cb) => {
            socket.emit('transport-connect', { transportId: producerTransport.id, dtlsParameters });
            cb();
        });

        producerTransport.on('produce', ({ kind, rtpParameters, appData }, cb) => {
            socket.emit('transport-produce', { transportId: producerTransport.id, kind, rtpParameters, appData },
                ({ id, error }) => { if (error) console.error(error); cb({ id }); });
        });
    });
}

function createRecvTransport() {
    socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
        if (params.error) { console.error(params.error); return; }

        consumerTransport = device.createRecvTransport(params);
        attachTransportHandlers(consumerTransport);

        consumerTransport.on('connect', ({ dtlsParameters }, cb) => {
            socket.emit('transport-connect', { transportId: consumerTransport.id, dtlsParameters });
            cb();
        });

        getProducers();
    });
}

/** Create send transport for viewer mic */
function createViewerSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
            if (params.error) { reject(new Error(params.error)); return; }

            viewerSendTransport = device.createSendTransport(params);
            attachTransportHandlers(viewerSendTransport);

            viewerSendTransport.on('connect', ({ dtlsParameters }, cb) => {
                socket.emit('transport-connect', { transportId: viewerSendTransport.id, dtlsParameters });
                cb();
            });

            viewerSendTransport.on('produce', ({ kind, rtpParameters, appData }, cb) => {
                socket.emit('transport-produce', { transportId: viewerSendTransport.id, kind, rtpParameters, appData },
                    ({ id, error }) => { if (error) { reject(new Error(error)); return; } cb({ id }); });
            });

            resolve(viewerSendTransport);
        });
    });
}

function attachTransportHandlers(transport) {
    transport.on('connectionstatechange', (state) => {
        if (state === 'failed' || state === 'disconnected') attemptIceRestart(transport);
    });
}

function attemptIceRestart(transport) {
    if (!transport || transport.closed) return;
    const state = iceRestartState.get(transport) || { inProgress: false, lastAttempt: 0 };
    const now = Date.now();
    if (state.inProgress || now - state.lastAttempt < 5000) return;

    state.inProgress = true;
    state.lastAttempt = now;
    iceRestartState.set(transport, state);

    socket.emit('restartIce', { transportId: transport.id }, async ({ iceParameters, error }) => {
        try {
            if (error) { console.warn('ICE restart error:', error); return; }
            await transport.restartIce({ iceParameters });
            console.log('ICE restart OK');
        } catch (e) {
            console.warn('ICE restart failed:', e.message);
        } finally {
            state.inProgress = false;
            iceRestartState.set(transport, state);
        }
    });
}

function getProducers() {
    socket.emit('getProducers', (ids) => {
        ids.forEach(id => consumeProducer(id));
    });
}

async function consumeProducer(producerId, meta = null) {
    if (!consumerTransport) return;

    socket.emit('consume', {
        transportId: consumerTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities
    }, async ({ params }) => {
        if (params.error) { console.error(params.error); return; }

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        });

        consumers.set(consumer.id, consumer);

        // B2b: Producer kapanınca veya track biterse consumer'ı + DOM elementini
        // GÜVENLE temizle. Sadece socket 'producer-closed' event'ine güvenmek
        // yarış koşullarına (stale/eksik audio element) yol açıyordu.
        attachConsumerCleanup(consumer);

        if (params.kind === 'video') {
            videoConsumer = consumer;
            if (!statsStarted) { startStatsLoop(false); statsStarted = true; }
            setTimeout(() => setConsumerQuality(consumer, currentQuality), 500);

            try {
                const receivers = consumerTransport.handler._pc.getReceivers();
                const vr = receivers.find(r => r.track?.kind === 'video');
                if (vr && 'jitterBufferTarget' in vr) vr.jitterBufferTarget = 100;
            } catch (e) {}
        }

        if (params.kind === 'video') {
            if (remoteVideo.srcObject) {
                remoteVideo.srcObject.addTrack(consumer.track);
            } else {
                remoteVideo.srcObject = new MediaStream([consumer.track]);
            }
            remoteVideo.playsInline = true;
            remoteVideo.addEventListener('stalled', () => {
                if (videoConsumer) socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
            });
            if (!consumer._autoPlaySet) {
                consumer._autoPlaySet = true;
                remoteVideo.addEventListener('loadeddata', () => autoPlayVideo(), { once: true });
            }
        } else if (params.kind === 'audio') {
            // B2a/B4: Audio elementi bağımsız state ile oluştur ve KESİNLİKLE play() çağır
            const audioEl = document.createElement('audio');
            audioEl.id = `audio-consumer-${consumer.id}`;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            audioEl.volume = volumeSlider ? parseFloat(volumeSlider.value) : 1;
            // Video mute'una BAĞLANMIYOR — bağımsız audioMutedState (B4)
            audioEl.muted = audioMutedState;
            audioEl.srcObject = new MediaStream([consumer.track]);
            document.body.appendChild(audioEl);
            consumer.appData = { ...(consumer.appData || {}), audioEl, source: meta?.source || null };
            // Hemen play() dene — autoplay reddedilirse playAudioElement() handle eder
            playAudioElement(audioEl);
        }

        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');

        socket.emit('resume', { consumerId: consumer.id });
    });
}

/**
 * Bir audio elementini güvenli şekilde çalmaya çalışır.
 * Tarayıcı autoplay politikası reddederse: sessiz modda çal, sonra ilk kullanıcı
 * etkileşiminde gerçek (sesli) oynatmaya geç. (B2a düzeltmesi)
 */
function playAudioElement(audioEl) {
    if (!audioEl) return;
    audioEl.play().then(() => {
        // Başarılı — bekleme listesinden çıkar
        pendingAudioElements.delete(audioEl);
    }).catch((err) => {
        console.warn('⚠️ Audio autoplay engellendi, sessiz modda deneniyor:', err.name);
        // Sessiz modda (mute) çal — bu neredeyse her zaman kabul edilir
        audioEl.muted = true;
        audioEl.play().then(() => {
            pendingAudioElements.add(audioEl);
        }).catch((e2) => {
            console.warn('⚠️ Audio sessiz modda da çalınamadı, etkileşim bekleniyor:', e2.name);
            pendingAudioElements.add(audioEl);
        });
    });
}

/**
 * İlk kullanıcı etkileşiminde bekleyen tüm audio elementlerini sesli çalmaya geç.
 * (autoplay politikasını aşmanın resmi yöntemi)
 */
function resumePendingAudio() {
    if (!pendingAudioElements.size) return;
    pendingAudioElements.forEach((audioEl) => {
        audioEl.muted = audioMutedState; // kullanıcının tercih ettiği mute durumuna dön
        if (!audioMutedState) {
            audioEl.play().then(() => {
                pendingAudioElements.delete(audioEl);
            }).catch(() => { /* hâlâ engelleniyorsa beklemede kal */ });
        } else {
            pendingAudioElements.delete(audioEl);
        }
    });
}

// İlk etkileşimde (click/touch/keydown) bekleyen sesleri aç
function setupAudioGestureUnlock() {
    const unlock = () => resumePendingAudio();
    ['click', 'touchstart', 'keydown'].forEach(evt =>
        document.addEventListener(evt, unlock, { once: false, passive: true }));
}
setupAudioGestureUnlock();

/**
 * Bir consumer'ı tamamen kapat ve DOM/Map temizliğini yap.
 * Hem producer-closed socket event'inde hem de mediasoup event'lerinde kullanılır.
 */
function closeAndRemoveConsumer(consumer) {
    if (!consumer) return;
    const wasInMap = consumers.delete(consumer.id);
    if (videoConsumer === consumer) videoConsumer = null;

    if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
        const el = consumer.appData.audioEl;
        pendingAudioElements.delete(el);
        try { el.pause(); } catch (e) {}
        try { el.srcObject = null; } catch (e) {}
        el.remove();
        consumer.appData.audioEl = null;
    } else if (consumer.kind === 'video' && remoteVideo.srcObject) {
        try { remoteVideo.srcObject.removeTrack(consumer.track); } catch (e) {}
    }

    if (wasInMap) { try { consumer.close(); } catch (e) {} }
}

/**
 * Bir consumer kapanınca (producer kapandı / track bitti / transport kapandı)
 * audio elementini ve consumers Map'ini güvenle temizle. (B2b düzeltmesi)
 */
function attachConsumerCleanup(consumer) {
    const cleanup = () => closeAndRemoveConsumer(consumer);
    consumer.on('producerclose', cleanup);
    consumer.on('trackended', cleanup);
    consumer.on('transportclose', cleanup);
}

/**
 * Tüm (video + audio) elementlerin mute/volume durumunu tek tutarlı state ile
 * senkronize et. (B4 düzeltmesi)
 */
function syncAllAudioElements() {
    for (const [, consumer] of consumers) {
        if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
            consumer.appData.audioEl.muted = audioMutedState;
            if (volumeSlider) consumer.appData.audioEl.volume = parseFloat(volumeSlider.value);
            // Eğer daha önce autoplay yüzünden beklemedeyse ve artık çalması gerekiyorsa
            if (!audioMutedState && consumer.appData.audioEl.paused) {
                playAudioElement(consumer.appData.audioEl);
            }
        }
    }
}

// ==================== ADMIN: STREAM CONTROLS ====================

btnStartStream.addEventListener('click', async () => {
    if (!producerTransport) {
        await initMediasoup();
        setTimeout(startStream, 500);
    } else {
        startStream();
    }
});

async function startStream() {
    // Close existing producers
    [videoProducer, systemAudioProducer, mixedAudioProducer, micProducer].forEach(p => {
        if (p) { socket.emit('producer-closing', { producerId: p.id }); p.close(); }
    });
    videoProducer = systemAudioProducer = mixedAudioProducer = micProducer = null;

    const height  = parseInt(resSelect.value);
    const fps     = parseInt(fpsSelect.value);
    const bitrate = parseInt(bitrateInput.value) * 1000;
    const width   = Math.round(height * (16 / 9));

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: width, max: 1920 }, height: { ideal: height, max: 1080 }, frameRate: { ideal: fps, max: 60 } },
            audio: true
        });

        localVideo.srcObject = stream;
        const videoTrack = stream.getVideoTracks()[0];
        const settings   = videoTrack.getSettings();
        const actualH    = settings.height || height;
        const actualFps  = settings.frameRate || fps;

        if (videoTrack.contentHint !== undefined) videoTrack.contentHint = 'detail';

        const codec = pickVideoCodec(false);
        videoProducer = await producerTransport.produce({
            track: videoTrack,
            encodings: [{ maxBitrate: bitrate, maxFramerate: actualFps, scalabilityMode: 'L1T3' }],
            codec: codec || undefined,
            codecOptions: {
                videoGoogleStartBitrate: Math.floor(bitrate * 0.8),
                videoGoogleMaxBitrate: bitrate,
                videoGoogleMinBitrate: Math.floor(bitrate * 0.6) // Keep resolution high
            },
            appData: { source: 'screen', resolution: actualH }
        });

        videoTrack.onended = stopStream;

        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            systemAudioTrack = audioTrack;
            // DTX kapalı (B3) — sistem sesinde (müzik/film) DTX kaliteyi bozar
            systemAudioProducer = await producerTransport.produce({
                track: systemAudioTrack,
                codecOptions: { opusStereo: 1, opusFec: 1, opusDtx: 0, opusMaxAverageBitrate: 128000 },
                appData: { source: 'admin-sys-audio' }
            });
            updateAdminAudioButton(true);
        }

            btnStartStream.classList.add('hidden');
            btnStopStream.classList.remove('hidden');
            showToast('Yayın başlandı', 'success');
            startStatsLoop(true);
            statsStarted = true;

            // B1 DÜZELTMESİ: Yayın başlamadan önce açılmış mikrofon varsa, artık
            // producerTransport hazır → producer'ı oluştur ki ses izleyicilere gitsin.
            // (startStream başında micProducer=null yapılmıştı, micTrack hâlâ canlı.)
            await republishAdminMic();
    } catch (err) {
        console.error('Stream error:', err);
        showToast('Yayın başlatılamadı: ' + err.message);
    }
}

btnStopStream.addEventListener('click', stopStream);

function stopStream() {
    [videoProducer, systemAudioProducer, mixedAudioProducer, micProducer].forEach(p => {
        if (p) { socket.emit('producer-closing', { producerId: p.id }); try { p.close(); } catch (e) {} }
    });
    videoProducer = systemAudioProducer = mixedAudioProducer = micProducer = null;

    if (systemAudioTrack) { systemAudioTrack.stop(); systemAudioTrack = null; }
    if (micTrack) { micTrack.stop(); micTrack = null; }

    if (localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(t => t.stop());
        localVideo.srcObject = null;
    }

    btnStartStream.classList.remove('hidden');
    btnStopStream.classList.add('hidden');
    updateAdminMicButton(false);
    updateAdminAudioButton(false);
    showToast('Yayın durduruldu');
}

/**
 * Admin mikrofon producer'ını (gerekirse) oluştur/yeniden yayınla.
 * B1 DÜZELTMESİ: Mikrofon yayın başlamadan önce açıldıysa producerTransport henüz
 * yoktu ve micProducer hiç oluşmuyordu. Bu fonksiyon, transport hazır olduktan
 * sonra (startStream sonunda veya transport gelince) eksik producer'ı kurar.
 */
async function republishAdminMic() {
    // Mikrofon track'i yoksa veya producer zaten varsa bir şey yapma
    if (!micTrack || micProducer) return;

    // Transport hazır olmayabilir (startStream → initMediasoup yarışı).
    // Birkaç kez bekle ve tekrar dene.
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let attempt = 0; attempt < 10; attempt++) {
        if (producerTransport && !producerTransport.closed && device) break;
        await wait(200);
    }
    if (!producerTransport || producerTransport.closed) {
        console.warn('⚠️ republishAdminMic: producerTransport hazır olmadı, mikrofon beklemeye alındı');
        return;
    }
    try {
        micProducer = await producerTransport.produce({
            track: micTrack,
            codecOptions: { opusStereo: 0, opusFec: 1, opusDtx: 0, opusMaxAverageBitrate: 64000 },
            appData: { source: 'admin-mic' }
        });
        console.log('🎤 Admin mic producer oluşturuldu:', micProducer.id);
    } catch (err) {
        console.error('Admin mic republish hatası:', err);
        showToast('Mikrofon yayını başlatılamadı');
    }
}

// Admin's own mic toggle
btnToggleMic.addEventListener('click', async () => {
    if (micTrack) {
        // --- Mikrofonu KAPAT ---
        micTrack.stop(); micTrack = null;
        updateAdminMicButton(false);
        if (micProducer) {
            socket.emit('producer-closing', { producerId: micProducer.id });
            try { micProducer.close(); } catch(e) {}
            micProducer = null;
        }
        stopVAD();
    } else {
        // --- Mikrofonu AÇ ---
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,    // A4: explicit AGC
                    sampleRate: 48000,
                    channelCount: 1
                }
            });
            micTrack = stream.getAudioTracks()[0];
            updateAdminMicButton(true);
            // Producer'ı oluştur (transport varsa). Yoksa startStream sonunda
            // republishAdminMic() ile tamamlanacak (B1 düzeltmesi).
            await republishAdminMic();
            setupVAD(stream);
        } catch (err) {
            console.error('Mic error:', err);
            showToast('Mikrofon erişimi başarısız: ' + (err.message || ''));
        }
    }
});

/** Admin mikrofon butonu için net görsel state (U2) */
function updateAdminMicButton(on) {
    if (!btnToggleMic) return;
    if (on) {
        btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Açık)';
        btnToggleMic.className = 'w-full py-1.5 bg-red-600/60 hover:bg-red-600 rounded-lg text-xs transition-colors font-medium';
    } else {
        btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Kapalı)';
        btnToggleMic.className = 'w-full py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs transition-colors';
    }
}

/**
 * Sistem sesi producer'ını (gerekirse) oluştur. Mevcut track'i yeniden kullanır
 * böylece tekrar ekran paylaşım izin diyaloğu çıkmaz (U3 düzeltmesi).
 */
async function republishSystemAudio() {
    if (!systemAudioTrack || systemAudioProducer) return;
    if (!producerTransport || producerTransport.closed) return;
    try {
        systemAudioProducer = await producerTransport.produce({
            track: systemAudioTrack,
            codecOptions: { opusStereo: 1, opusFec: 1, opusDtx: 0, opusMaxAverageBitrate: 128000 },
            appData: { source: 'admin-sys-audio' }
        });
        console.log('🔊 System audio producer:', systemAudioProducer.id);
    } catch (err) {
        console.error('System audio republish hatası:', err);
    }
}

/** Admin sistem sesi butonu için net görsel state (U2) */
function updateAdminAudioButton(on) {
    if (!btnToggleAudio) return;
    if (on) {
        btnToggleAudio.textContent = '🔊 Sistem Sesi (Açık)';
        btnToggleAudio.className = 'w-full py-1.5 bg-emerald-700/60 hover:bg-emerald-700 rounded-lg text-xs transition-colors font-medium';
    } else {
        btnToggleAudio.textContent = '🔊 Sistem Sesi (Kapalı)';
        btnToggleAudio.className = 'w-full py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs transition-colors';
    }
}

// Admin's system audio toggle
btnToggleAudio.addEventListener('click', async () => {
    if (systemAudioProducer) {
        // --- Sistem sesini KAPAT ---
        // U3: track'i durdurma — sadece producer'ı kapat. Böylece tekrar açarken
        // yeniden getDisplayMedia çağrılmaz (kullanıcıyı tekrar prompt etmez).
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        try { systemAudioProducer.close(); } catch(e) {}
        systemAudioProducer = null;
        updateAdminAudioButton(false);
    } else {
        // --- Sistem sesini AÇ ---
        // Önce mevcut (canlı) track'i dene — prompt yok (U3)
        if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
            updateAdminAudioButton(true);
            await republishSystemAudio();
        } else {
            // Track yoksa (ör. ekran paylaşımı sırasında hiç ses verilmedi) — fallback
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                stream.getVideoTracks().forEach(t => t.stop());
                const track = stream.getAudioTracks()[0];
                if (track) {
                    systemAudioTrack = track;
                    updateAdminAudioButton(true);
                    await republishSystemAudio();
                } else {
                    showToast('Sistem sesi bulunamadı (tarayıcı/sistem ses paylaşımı desteklemiyor olabilir)');
                }
            } catch (err) {
                console.error(err);
                showToast('Sistem sesi alınamadı');
            }
        }
    }
});

// ==================== ADMIN: ROOM CONTROLS ====================

// Toggle viewer mic permission
let adminViewerMicEnabled = true;
btnToggleViewerMic.addEventListener('click', () => {
    adminViewerMicEnabled = !adminViewerMicEnabled;
    socket.emit('toggle-viewer-mic', { enabled: adminViewerMicEnabled }, (result) => {
        if (result?.error) showToast(result.error);
    });
});

function updateViewerMicToggle() {
    if (!btnToggleViewerMic) return;
    if (viewerMicEnabled) {
        btnToggleViewerMic.textContent = '🎙️ İzleyici Mikrofonu: Açık';
        btnToggleViewerMic.className = 'w-full py-1.5 bg-emerald-700/60 hover:bg-emerald-700 rounded-lg text-xs transition-colors font-medium';
    } else {
        btnToggleViewerMic.textContent = '🎙️ İzleyici Mikrofonu: Kapalı';
        btnToggleViewerMic.className = 'w-full py-1.5 bg-red-700/40 hover:bg-red-700/60 rounded-lg text-xs transition-colors font-medium text-red-300';
    }
    adminViewerMicEnabled = viewerMicEnabled;
}

// Toggle chat
let adminChatEnabled = true;
btnToggleChat.addEventListener('click', () => {
    adminChatEnabled = !adminChatEnabled;
    socket.emit('toggle-chat', { enabled: adminChatEnabled }, (result) => {
        if (result?.error) showToast(result.error);
    });
});

function updateChatToggle() {
    if (!btnToggleChat) return;
    if (chatEnabled) {
        btnToggleChat.textContent = '💬 Chat: Açık';
        btnToggleChat.className = 'w-full py-1.5 bg-emerald-700/60 hover:bg-emerald-700 rounded-lg text-xs transition-colors font-medium';
    } else {
        btnToggleChat.textContent = '💬 Chat: Kapalı';
        btnToggleChat.className = 'w-full py-1.5 bg-red-700/40 hover:bg-red-700/60 rounded-lg text-xs transition-colors font-medium text-red-300';
    }
    adminChatEnabled = chatEnabled;
}

btnCloseRoom.addEventListener('click', () => {
    if (confirm('Odayı kapatmak istediğinize emin misiniz?')) socket.emit('close-room');
});

btnUpdateMaxUsers.addEventListener('click', () => {
    socket.emit('update-max-users', { maxUsers: parseInt(maxUsersInput.value) }, (result) => {
        if (result?.success) showToast('Limit güncellendi', 'success');
    });
});

// ==================== VIEWER MIC ====================

btnViewerMic.addEventListener('click', async () => {
    if (!viewerMicEnabled) {
        showToast('Mikrofon özelliği şu an oda sahibi tarafından kapalı');
        return;
    }

    if (viewerMicProducer) {
        closeViewerMic();
    } else {
        await openViewerMic();
    }
});

async function openViewerMic() {
    if (!viewerMicEnabled) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,    // A4: explicit AGC
                sampleRate: 48000,
                channelCount: 1
            }
        });
        viewerMicTrack = stream.getAudioTracks()[0];

        // Ensure we have a device loaded
        if (!device) await initMediasoup();

        // Ensure recv transport exists (viewers need it to hear others)
        if (!consumerTransport) await new Promise(resolve => {
            createRecvTransport();
            setTimeout(resolve, 800);
        });

        // Create send transport if not exists
        if (!viewerSendTransport || viewerSendTransport.closed) {
            await createViewerSendTransport();
        }

        viewerMicProducer = await viewerSendTransport.produce({
            track: viewerMicTrack,
            codecOptions: {
                opusStereo: 0,
                opusFec: 1,
                opusDtx: 0,                      // B3: DTX kapalı — gürültü/kesik yok
                opusMaxAverageBitrate: 64000     // 64kbps voice (netlik için 48→64)
            },
            appData: { source: 'viewer-mic' }
        });

        console.log('🎤 Viewer mic producer created:', viewerMicProducer.id);

        setupVAD(stream);
        updateViewerMicButton(true);

        viewerMicTrack.onended = () => closeViewerMic();
    } catch (err) {
        console.error('Viewer mic error:', err);
        showToast('Mikrofon açılamadı: ' + (err.message || 'İzin reddedildi'));
    }
}

function closeViewerMic() {
    stopVAD();
    if (viewerMicProducer) {
        socket.emit('producer-closing', { producerId: viewerMicProducer.id });
        try { viewerMicProducer.close(); } catch (e) {}
        viewerMicProducer = null;
    }
    if (viewerMicTrack) { viewerMicTrack.stop(); viewerMicTrack = null; }
    socket.emit('voice-activity', { speaking: false });
    updateViewerMicButton(false);
}

function updateViewerMicButton(open) {
    if (!btnViewerMic) return;
    if (!viewerMicEnabled) {
        btnViewerMic.textContent = '🎤 Mikrofon (Devre Dışı)';
        btnViewerMic.disabled = true;
        btnViewerMic.className = 'w-full py-2 bg-slate-600/50 text-slate-500 rounded-lg text-sm cursor-not-allowed';
    } else if (open) {
        btnViewerMic.textContent = '🎤 Mikrofon Kapat';
        btnViewerMic.disabled = false;
        btnViewerMic.className = 'w-full py-2 bg-red-600/60 hover:bg-red-600 rounded-lg text-sm transition-colors font-medium';
    } else {
        btnViewerMic.textContent = '🎤 Mikrofon Aç';
        btnViewerMic.disabled = false;
        btnViewerMic.className = 'w-full py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors font-medium';
    }
}

// ==================== VAD (Voice Activity Detection) ====================

function setupVAD(stream) {
    stopVAD();
    try {
        vadContext = new AudioContext();
        const source = vadContext.createMediaStreamSource(stream);
        vadAnalyser = vadContext.createAnalyser();
        vadAnalyser.fftSize = 512;
        vadAnalyser.smoothingTimeConstant = 0.8;
        source.connect(vadAnalyser);

        const dataArr = new Uint8Array(vadAnalyser.fftSize);
        vadWasSpeaking = false;

        vadInterval = setInterval(() => {
            if (!vadAnalyser) return;
            vadAnalyser.getByteTimeDomainData(dataArr);
            let sum = 0;
            for (let i = 0; i < dataArr.length; i++) {
                const v = (dataArr[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / dataArr.length);

            // A5: Histeresisli VAD — konuşma BAŞLAMA eşiği daha yüksek (0.025),
            // BITME eşiği daha düşük (0.012). Böylece fan/klavye gibi sürekli
            // düşük gürültü "konuşuyor" tetiklemez ve göstergenin titremesi engellenir.
            const startThreshold = 0.025;
            const stopThreshold = 0.012;
            let speaking = vadWasSpeaking;
            if (!speaking && rms > startThreshold) speaking = true;
            else if (speaking && rms < stopThreshold) speaking = false;

            if (speaking !== vadWasSpeaking) {
                vadWasSpeaking = speaking;
                socket.emit('voice-activity', { speaking });
                // Also update own indicator locally
                updateSpeakingIndicator(socket.id, speaking);
            }
        }, 80); // ~12Hz polling
    } catch (e) {
        console.warn('VAD setup failed:', e.message);
    }
}

function stopVAD() {
    if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
    if (vadContext) { try { vadContext.close(); } catch (e) {} vadContext = null; }
    vadAnalyser = null;
    vadWasSpeaking = false;
}

// ==================== CHAT ====================

function updateChatUI() {
    if (chatEnabled) {
        chatInput.disabled = false;
        btnSendChat.disabled = false;
        chatInputArea.classList.remove('hidden');
        chatDisabledMsg.classList.add('hidden');
        chatStatusBadge.textContent = 'Açık';
        chatStatusBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-emerald-700/40 text-emerald-400';
    } else {
        chatInput.disabled = true;
        btnSendChat.disabled = true;
        chatInputArea.classList.add('hidden');
        chatDisabledMsg.classList.remove('hidden');
        chatStatusBadge.textContent = 'Kapalı';
        chatStatusBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-red-700/40 text-red-400';
    }
}

function sendChatMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    if (!chatEnabled) { showToast('Chat kapalı'); return; }

    socket.emit('chat-message', { message: msg }, (result) => {
        if (result?.error) showToast(result.error);
    });
    chatInput.value = '';
}

btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });

function appendChatMessage({ socketId, nickname, role, message, timestamp }) {
    const isMe = socketId === mySocketId;
    const isOwner = role === 'admin';
    const time = new Date(timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    const el = document.createElement('div');
    el.className = `chat-msg flex flex-col ${isMe ? 'items-end' : 'items-start'}`;
    el.innerHTML = `
        <div class="flex items-center gap-1 mb-0.5">
            ${isOwner ? '<span class="text-yellow-400 text-xs">👑</span>' : ''}
            <span class="text-xs font-semibold ${isOwner ? 'text-yellow-400' : isMe ? 'text-brand-400' : 'text-slate-400'}">${escapeHtml(nickname)}</span>
            <span class="text-xs text-slate-600">${time}</span>
        </div>
        <div class="max-w-[220px] px-3 py-1.5 rounded-2xl text-sm break-words
            ${isMe ? 'bg-brand-600 text-white rounded-tr-sm' : 'bg-slate-700 text-slate-100 rounded-tl-sm'}">
            ${escapeHtml(message)}
        </div>
    `;

    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Keep max 200 messages
    while (chatMessages.children.length > 200) chatMessages.removeChild(chatMessages.firstChild);
}

// ==================== VIEWER PLAYBACK CONTROLS ====================

btnPlayPause?.addEventListener('click', async () => {
    if (remoteVideo.paused) {
        if (videoConsumer) socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
        try {
            await remoteVideo.play();
            updatePlayPauseIcon(true);
        } catch {
            remoteVideo.muted = true;
            await remoteVideo.play();
            updatePlayPauseIcon(true);
        }
    } else {
        remoteVideo.pause();
        updatePlayPauseIcon(false);
    }
});

btnMute?.addEventListener('click', () => {
    audioMutedState = !audioMutedState;
    remoteVideo.muted = audioMutedState;
    iconVolumeOn.classList.toggle('hidden', audioMutedState);
    iconVolumeOff.classList.toggle('hidden', !audioMutedState);
    // B4: tüm audio elementleri tek tutarlı state ile senkronize
    syncAllAudioElements();
    // Kullanıcı manuel unmute yaptıysa bekleyen autoplay audio'larını da aç
    if (!audioMutedState) resumePendingAudio();
});

volumeSlider?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    remoteVideo.volume = v;
    // Seviyeyi kaydet (A8)
    try { localStorage.setItem('velo_volume', String(v)); } catch (e2) {}
    syncAllAudioElements();
});

btnFullscreen?.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else videoContainer.requestFullscreen();
});

qualitySelect?.addEventListener('change', async () => {
    currentQuality = qualitySelect.value;
    if (videoConsumer) await setConsumerQuality(videoConsumer, currentQuality);
});

// ==================== INVITE ====================

btnInvite.addEventListener('click', () => {
    const url = `${window.location.origin}/room.html?roomId=${roomId}`;
    navigator.clipboard.writeText(url).then(() => showToast('Davet linki kopyalandı!', 'success'));
});

// ==================== STATS ====================

btnStats?.addEventListener('click', () => statsPanel.classList.toggle('hidden'));

function startStatsLoop(isSender) {
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    const pc = isSender ? producerTransport?.handler?._pc : consumerTransport?.handler?._pc;
    if (!pc) return;

    // V8: Ses için ayrı delta takibi
    let lastAudioStats = { timestamp: 0, bytes: 0 };

    statsInterval = setInterval(async () => {
        try {
            const stats = await pc.getStats();
            let bytes = 0, fps = 0, packetsLost = 0, packetsTotal = 0, jitter = 0, rtt = 0;
            // Ses metrikleri
            let audioBytes = 0, audioPacketsLost = 0, audioPacketsTotal = 0, audioJitter = 0;

            stats.forEach((report) => {
                const type = isSender ? 'outbound-rtp' : 'inbound-rtp';
                if (report.type === type && report.kind === 'video') {
                    bytes = report.bytesSent || report.bytesReceived || bytes;
                    fps = report.framesPerSecond || fps;
                    packetsLost = report.packetsLost || packetsLost;
                    packetsTotal = (report.packetsLost || 0) + (report.packetsReceived || 0);
                    jitter = report.jitter || jitter;
                }
                // V8: Ses metriklerini de topla
                if (report.type === type && report.kind === 'audio') {
                    audioBytes = report.bytesSent || report.bytesReceived || 0;
                    audioPacketsLost = report.packetsLost || 0;
                    audioPacketsTotal = (report.packetsLost || 0) + (report.packetsReceived || report.packetsSent || 0);
                    audioJitter = report.jitter || 0;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
                    rtt = report.currentRoundTripTime;
                }
            });

            const now = Date.now();
            let bitrateKbps = 0;
            if (lastStats.timestamp) {
                const dMs = now - lastStats.timestamp;
                const dB  = bytes - lastStats.bytes;
                if (dMs > 0) bitrateKbps = Math.max(0, Math.round((dB * 8) / dMs));
            }
            lastStats = { timestamp: now, bytes };

            // V8: Ses bitrate hesabı
            let audioBitrateKbps = 0;
            if (lastAudioStats.timestamp) {
                const dMs = now - lastAudioStats.timestamp;
                const dB = audioBytes - lastAudioStats.bytes;
                if (dMs > 0) audioBitrateKbps = Math.max(0, Math.round((dB * 8) / dMs));
            }
            lastAudioStats = { timestamp: now, bytes: audioBytes };

            if (statsBitrate) statsBitrate.textContent = `${bitrateKbps} kbps`;
            if (statsFps) statsFps.textContent = fps ? `${Math.round(fps)} fps` : '-';
            if (statsRtt) statsRtt.textContent = rtt ? `${Math.round(rtt * 1000)} ms` : '-';
            if (statsLoss) statsLoss.textContent = packetsTotal ? `${Math.round((packetsLost / packetsTotal) * 100)}%` : '0%';
            if (statsJitter) statsJitter.textContent = jitter ? `${Math.round(jitter * 1000)} ms` : '-';

            // V8: Ses metriklerini güncelle (HTML elementleri varsa)
            const aBitrate = document.getElementById('statsAudioBitrate');
            const aLoss = document.getElementById('statsAudioLoss');
            const aJitter = document.getElementById('statsAudioJitter');
            if (aBitrate) aBitrate.textContent = audioBytes ? `${audioBitrateKbps} kbps` : '-';
            if (aLoss) aLoss.textContent = audioPacketsTotal ? `${Math.round((audioPacketsLost / audioPacketsTotal) * 100)}%` : '0%';
            if (aJitter) aJitter.textContent = audioJitter ? `${Math.round(audioJitter * 1000)} ms` : '-';

            // U7: Düşük kalite uyarısı — yüksek paket kaybı tespit edilirse kullanıcı bilgilendir
            const videoLossPct = packetsTotal ? (packetsLost / packetsTotal) * 100 : 0;
            const now2 = Date.now();
            if (videoLossPct > 8 && (!showToast._lastLowQualityWarn || now2 - showToast._lastLowQualityWarn > 15000)) {
                showToast._lastLowQualityWarn = now2;
                showToast('Bağlantı zayıf görünüyor, görüntü kalitesi düşebilir', 'warning');
            }
        } catch (e) {}
    }, 2000);
}

// ==================== QUALITY ====================

async function setConsumerQuality(consumer, quality) {
    if (!consumer || consumer.kind !== 'video') return;

    if (quality === 'auto') {
        socket.emit('setAutoLayers', { consumerId: consumer.id }); return;
    }

    const encodingsCount = consumer.rtpParameters?.encodings?.length || 1;
    const maxSpatialLayer = Math.max(0, encodingsCount - 1);
    let spatialLayer = maxSpatialLayer, temporalLayer;

    switch (quality) {
        case 'high': temporalLayer = 2; break;
        case 'mid':  temporalLayer = 1; spatialLayer = Math.min(1, maxSpatialLayer); break;
        case 'low':  temporalLayer = 0; spatialLayer = 0; break;
        default:     temporalLayer = 2;
    }

    socket.emit('setPreferredLayers', { consumerId: consumer.id, spatialLayer, temporalLayer });
}

// ==================== HELPERS ====================

function pickVideoCodec(preferSimulcast) {
    const codecs = device?.rtpCapabilities?.codecs || [];
    const vp8 = codecs.find(c => c.mimeType?.toLowerCase() === 'video/vp8');
    const h264 = codecs.find(c => c.mimeType?.toLowerCase() === 'video/h264');
    const vp9 = codecs.find(c => c.mimeType?.toLowerCase() === 'video/vp9');
    return preferSimulcast ? (vp8 || h264 || vp9 || null) : (vp9 || vp8 || h264 || null);
}

async function autoPlayVideo() {
    try {
        await remoteVideo.play();
        updatePlayPauseIcon(true);
    } catch {
        // Video autoplay policy yüzünden reddedilirse sessiz modda dene.
        // Ses ayrı <audio> elementlerinde bağımsız çaldığı için bu sadece video'yu etkiler.
        remoteVideo.muted = true;
        try { await remoteVideo.play(); updatePlayPauseIcon(true); showToast('Görüntü başlatıldı (ses için sayfaya tıklayın)', 'warning'); }
        catch { updatePlayPauseIcon(false); }
    }
}

function updatePlayPauseIcon(playing) {
    if (iconPlay && iconPause) {
        iconPlay.classList.toggle('hidden', playing);
        iconPause.classList.toggle('hidden', !playing);
    }
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
}

function showToast(message, type = 'error') {
    toastMessage.textContent = message;
    const colors = {
        error:   'bg-red-500 border-red-600',
        success: 'bg-green-600 border-green-700',
        warning: 'bg-yellow-500 border-yellow-600'
    };
    toast.className = `fixed bottom-4 right-4 max-w-xs px-5 py-3 rounded-lg shadow-lg text-white border z-50 ${colors[type] || colors.error}`;
    toast.classList.remove('hidden');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ==================== LEAVE ====================

btnLeaveRoom?.addEventListener('click', () => {
    leaveModal.classList.remove('hidden');
    leaveModal.classList.add('flex');
});

btnCancelLeave?.addEventListener('click', () => {
    leaveModal.classList.add('hidden');
    leaveModal.classList.remove('flex');
});

btnConfirmLeave?.addEventListener('click', () => {
    if (viewerMicProducer) closeViewerMic();
    window.location.href = 'index.html';
});

// ==================== ENTRY POINT ====================

(async () => {
    // A8: Kayıtlı ses seviyesini geri yükle
    try {
        const savedVol = localStorage.getItem('velo_volume');
        if (savedVol !== null && volumeSlider) {
            const v = parseFloat(savedVol);
            if (!isNaN(v)) {
                volumeSlider.value = String(v);
                remoteVideo.volume = v;
            }
        }
    } catch (e) {}

    const nickname = await showNicknameModal();
    myNickname = nickname;
    await initSocket(nickname);
})();
