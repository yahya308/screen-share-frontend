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

let isAdmin          = false;
let myNickname       = '';
let mySocketId       = '';

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

    socket = io(signalingUrl);
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

    socket.on('disconnect', () => {
        showToast('Sunucu bağlantısı kesildi');
    });
}

function registerSocketEvents() {
    // User count updates
    socket.on('user-joined', ({ userCount: c }) => { userCount.textContent = c; });
    socket.on('user-left', ({ userCount: c }) => { userCount.textContent = c; });

    // Full user list
    socket.on('user-list', (users) => renderUserList(users));

    // Mediasoup events
    socket.on('new-producer', (producerId) => consumeProducer(producerId));

    socket.on('stream-started', () => {
        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');
        if (!device) initMediasoup();
        else getProducers();
    });

    socket.on('stream-paused', () => pausedOverlay.classList.remove('hidden'));

    socket.on('producer-closed', ({ remoteProducerId }) => {
        for (const [id, consumer] of consumers) {
            if (consumer.producerId === remoteProducerId) {
                consumer.close();
                consumers.delete(id);
                if (consumer.kind === 'video' && remoteVideo.srcObject) {
                    remoteVideo.srcObject.removeTrack(consumer.track);
                } else if (consumer.kind === 'audio') {
                    if (consumer.appData && consumer.appData.audioEl) {
                        consumer.appData.audioEl.remove();
                    } else if (remoteVideo.srcObject) {
                        remoteVideo.srcObject.removeTrack(consumer.track);
                    }
                }
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
}

// ==================== USER LIST ====================

function renderUserList(users) {
    if (!Array.isArray(users)) return;

    userCountBadge.textContent = users.length;
    userCount.textContent = users.length;
    userListContainer.innerHTML = '';

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

async function initMediasoup() {
    socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
        if (rtpCapabilities.error) { showToast(rtpCapabilities.error); return; }

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

async function consumeProducer(producerId) {
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

        if (params.kind === 'video') {
            videoConsumer = consumer;
            if (!statsStarted) { startStatsLoop(false); statsStarted = true; }
            setTimeout(() => setConsumerQuality(consumer, currentQuality), 500);

            try {
                const receivers = consumerTransport.handler._pc.getReceivers();
                const vr = receivers.find(r => r.track?.kind === 'video');
                if (vr && 'jitterBufferTarget' in vr) vr.jitterBufferTarget = 100;
            } catch (e) {}

            setInterval(() => {
                if (videoConsumer && !videoConsumer.closed)
                    socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
            }, 30000);
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
            const audioEl = document.createElement('audio');
            audioEl.id = `audio-consumer-${consumer.id}`;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            if (volumeSlider) audioEl.volume = volumeSlider.value;
            audioEl.muted = remoteVideo.muted;
            audioEl.srcObject = new MediaStream([consumer.track]);
            document.body.appendChild(audioEl);
            consumer.appData = { ...consumer.appData, audioEl };
        }

        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');

        socket.emit('resume', { consumerId: consumer.id });
    });
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

        if (videoTrack.contentHint !== undefined) videoTrack.contentHint = 'motion';

        const codec = pickVideoCodec(false);
        videoProducer = await producerTransport.produce({
            track: videoTrack,
            encodings: [{ maxBitrate: bitrate, maxFramerate: actualFps, scalabilityMode: 'L1T3' }],
            codec: codec || undefined,
            codecOptions: {
                videoGoogleStartBitrate: Math.floor(bitrate * 0.8),
                videoGoogleMaxBitrate: bitrate,
                videoGoogleMinBitrate: Math.floor(bitrate / 2)
            },
            appData: { source: 'screen', resolution: actualH }
        });

        videoTrack.onended = stopStream;

        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            systemAudioTrack = audioTrack;
            if (producerTransport) {
                systemAudioProducer = await producerTransport.produce({
                    track: systemAudioTrack,
                    codecOptions: { opusStereo: 1, opusFec: 1, opusDtx: 1, opusMaxAverageBitrate: 128000 },
                    appData: { source: 'admin-sys-audio' }
                });
            }
            btnToggleAudio.textContent = '🔊 Sistem Sesi (Açık)';
        }

        btnStartStream.classList.add('hidden');
        btnStopStream.classList.remove('hidden');
        showToast('Yayın başladı', 'success');
        startStatsLoop(true);
        statsStarted = true;
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
    btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Kapalı)';
    btnToggleAudio.textContent = '🔊 Sistem Sesi (Kapalı)';
    showToast('Yayın durduruldu');
}

// Admin's own mic toggle
btnToggleMic.addEventListener('click', async () => {
    if (micTrack) {
        micTrack.stop(); micTrack = null;
        btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Kapalı)';
        if (micProducer) {
            socket.emit('producer-closing', { producerId: micProducer.id });
            try { micProducer.close(); } catch(e) {}
            micProducer = null;
        }
        stopVAD();
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 } });
            micTrack = stream.getAudioTracks()[0];
            btnToggleMic.textContent = '🎤 Kendi Mikrofonum (Açık)';
            if (producerTransport) {
                micProducer = await producerTransport.produce({
                    track: micTrack,
                    codecOptions: { opusStereo: 0, opusFec: 1, opusDtx: 1, opusMaxAverageBitrate: 48000 },
                    appData: { source: 'admin-mic' }
                });
            }
            setupVAD(stream);
        } catch (err) {
            showToast('Mikrofon erişimi başarısız');
        }
    }
});

// Admin's system audio toggle
btnToggleAudio.addEventListener('click', async () => {
    if (systemAudioTrack) {
        systemAudioTrack.stop(); systemAudioTrack = null;
        btnToggleAudio.textContent = '🔊 Sistem Sesi (Kapalı)';
        if (systemAudioProducer) {
            socket.emit('producer-closing', { producerId: systemAudioProducer.id });
            try { systemAudioProducer.close(); } catch(e) {}
            systemAudioProducer = null;
        }
    } else {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            stream.getVideoTracks().forEach(t => t.stop());
            const track = stream.getAudioTracks()[0];
            if (track) {
                systemAudioTrack = track;
                btnToggleAudio.textContent = '🔊 Sistem Sesi (Açık)';
                if (producerTransport) {
                    systemAudioProducer = await producerTransport.produce({
                        track: systemAudioTrack,
                        codecOptions: { opusStereo: 1, opusFec: 1, opusDtx: 1, opusMaxAverageBitrate: 128000 },
                        appData: { source: 'admin-sys-audio' }
                    });
                }
            }
        } catch (err) { console.error(err); }
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
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 1 }
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
                opusDtx: 1,
                opusMaxAverageBitrate: 48000     // 48kbps for voice
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
            const speaking = rms > 0.015;

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
    remoteVideo.muted = !remoteVideo.muted;
    iconVolumeOn.classList.toggle('hidden', remoteVideo.muted);
    iconVolumeOff.classList.toggle('hidden', !remoteVideo.muted);
    for (const [id, consumer] of consumers) {
        if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
            consumer.appData.audioEl.muted = remoteVideo.muted;
        }
    }
});

volumeSlider?.addEventListener('input', (e) => { 
    remoteVideo.volume = e.target.value; 
    for (const [id, consumer] of consumers) {
        if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
            consumer.appData.audioEl.volume = e.target.value;
        }
    }
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

    statsInterval = setInterval(async () => {
        try {
            const stats = await pc.getStats();
            let bytes = 0, fps = 0, packetsLost = 0, packetsTotal = 0, jitter = 0, rtt = 0;

            stats.forEach((report) => {
                if (report.type === (isSender ? 'outbound-rtp' : 'inbound-rtp') && report.kind === 'video') {
                    bytes = report.bytesSent || report.bytesReceived || bytes;
                    fps = report.framesPerSecond || fps;
                    packetsLost = report.packetsLost || packetsLost;
                    packetsTotal = (report.packetsLost || 0) + (report.packetsReceived || 0);
                    jitter = report.jitter || jitter;
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

            if (statsBitrate) statsBitrate.textContent = `${bitrateKbps} kbps`;
            if (statsFps) statsFps.textContent = fps ? `${Math.round(fps)} fps` : '-';
            if (statsRtt) statsRtt.textContent = rtt ? `${Math.round(rtt * 1000)} ms` : '-';
            if (statsLoss) statsLoss.textContent = packetsTotal ? `${Math.round((packetsLost / packetsTotal) * 100)}%` : '0%';
            if (statsJitter) statsJitter.textContent = jitter ? `${Math.round(jitter * 1000)} ms` : '-';
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
        remoteVideo.muted = true;
        try { await remoteVideo.play(); updatePlayPauseIcon(true); showToast('Ses kapatılarak başlatıldı', 'warning'); }
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
    const nickname = await showNicknameModal();
    myNickname = nickname;
    await initSocket(nickname);
})();
