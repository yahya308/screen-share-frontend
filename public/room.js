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
let adminMicTransport;    // Admin: independent send transport for mic
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

const consumers      = new Map(); // consumerId -> consumer

// Audio oynatma state'i — video mute'tan BAĞIMSIZ (B4 düzeltmesi)
let audioMutedState  = false;
// Autoplay politikası yüzünden bekleyen (henüz çalamayan) audio elementleri (B2a)
const pendingAudioElements = new Set();

// Mobile browsers switch to a communication/VoIP audio route while capturing.
// Keep remote playout in one graph so that route attenuation can be compensated
// without changing desktop playback or creating a second audible output.
const MOBILE_DUPLEX_OUTPUT_GAIN = 1.58; // approximately +4 dB
const remoteAudioSources = new Map(); // consumerId -> { source, stream }
let remoteAudioContext = null;
let remoteAudioMasterGain = null;
let remoteAudioLimiter = null;
let mobileDuplexAudioActive = false;
let mobileAudioSessionReassertTimer = null;

let isAdmin          = false;
let mySocketId       = '';
let adminSocketId    = null;   // U1: yayın sahibi konuşunca video kenarını vurgula

let viewerMicEnabled = true;  // Can viewers use mic? (admin controls this)
let chatEnabled      = true;  // Is chat open? (admin controls this)

let currentQuality   = 'auto';
let videoConsumer    = null;
const iceRestartState = new WeakMap();
let initMediasoupPromise = null;
let producerTransportPromise = null;
let adminMicTransportPromise = null;
let consumerTransportPromise = null;
let viewerSendTransportPromise = null;
let adminMicPublishPromise = null;
let viewerMicOpenPromise = null;
const consumerByProducerId = new Map();
const consumingProducerIds = new Set();
const MIC_NOISE_SUPPRESSION_STORAGE_KEY = 'velo_mic_noise_suppression';
let micNoiseSuppressionSupported = true;
let micNoiseSuppressionEnabled = loadMicNoiseSuppressionPreference();

// Stream timer
let streamTimerInterval = null;
let streamStartTime    = null;

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
const adminNoiseSuppressionToggle = document.getElementById('adminNoiseSuppressionToggle');
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
const viewerNoiseSuppressionToggle = document.getElementById('viewerNoiseSuppressionToggle');
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

// UI: Stream status badge, timer, connection quality, presets
const streamStatusBadge = document.getElementById('streamStatusBadge');
const streamTimerEl     = document.getElementById('streamTimer');
const adminStreamInfo   = document.getElementById('adminStreamInfo');
const adminTimerEl      = document.getElementById('adminTimer');
const connDot           = document.getElementById('connDot');
const connText          = document.getElementById('connText');
const presetButtons     = document.querySelectorAll('.preset-btn');

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

    registerSocketEvents();

    socket.on('connect', () => {
        mySocketId = socket.id;
        console.log('Connected:', socket.id);

        if (isAdminMode) {
            socket.emit('admin-rejoin', { roomId, nickname }, async (result) => {
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
                await initMediasoup();
                await republishAdminMic();
            });
        } else {
            const storedPassword = sessionStorage.getItem(`room_password_${roomId}`);
            attemptJoinRoom(storedPassword, nickname);
        }
    });

    socket.on('disconnect', () => {
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
        void initMediasoup().then(() => {
            if (consumerTransport && !consumerTransport.closed) getProducers();
        }).catch((err) => console.error('initMediasoup error:', err));
    });

    socket.on('stream-paused', () => pausedOverlay.classList.remove('hidden'));

    socket.on('producer-closed', ({ remoteProducerId }) => {
        // B2b: Bu artık backup görevi görür — asıl temizlik consumer'ın
        // 'producerclose' event'inde (attachConsumerCleanup) yapılır.
        for (const [, consumer] of [...consumers]) {
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
            if (!enabled && (viewerMicProducer || viewerMicTrack)) {
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
    socket.emit('join-room', { roomId, password, nickname }, async (result) => {
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

        if (result.isStreaming || viewerMicTrack?.readyState === 'live') await initMediasoup();
        if (viewerMicTrack?.readyState === 'live') await republishViewerMic();
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

        socket.emit('join-room', { roomId, password: pw, nickname }, async (result) => {
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
            if (result.isStreaming || viewerMicTrack?.readyState === 'live') await initMediasoup();
            if (viewerMicTrack?.readyState === 'live') await republishViewerMic();
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

    if (!canUseDisplayCapture()) {
        btnStartStream.disabled = true;
        btnStartStream.classList.add('opacity-60', 'cursor-not-allowed');
        btnStartStream.title = 'Bu cihaz/tarayici ekran paylasimini desteklemiyor';
        showToast('Bu cihazda ekran paylasimi desteklenmiyor. Mobilde izleyici modu onerilir.', 'warning', 6000);
    } else if (isLikelyMobileDevice()) {
        btnStartStream.title = 'Mobil tarayicilarda ekran paylasimi ve sistem sesi sinirli olabilir';
    }

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
                    <button onclick="kickUser('${escapeHtml(user.socketId)}')" title="Odadan At"
                        class="p-1.5 text-orange-400 hover:bg-orange-500/20 rounded-lg transition-colors">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                        </button>
                    <button onclick="banUser('${escapeHtml(user.socketId)}')" title="Banla"
                        class="p-1.5 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                        </button>
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
    consumerByProducerId.clear();
    consumingProducerIds.clear();
    // Tüm consumer'ları ve audio elementlerini kapat
    for (const [, consumer] of [...consumers]) {
        closeAndRemoveConsumer(consumer);
    }
    consumers.clear();
    videoConsumer = null;
    // Transport'ları kapat
    try { if (producerTransport) producerTransport.close(); } catch (e) { /* yoksay */ }
    try { if (adminMicTransport) adminMicTransport.close(); } catch (e) { /* yoksay */ }
    try { if (consumerTransport) consumerTransport.close(); } catch (e) { /* yoksay */ }
    try { if (viewerSendTransport) viewerSendTransport.close(); } catch (e) { /* yoksay */ }
    producerTransport = adminMicTransport = consumerTransport = viewerSendTransport = null;
    producerTransportPromise = adminMicTransportPromise = consumerTransportPromise = viewerSendTransportPromise = null;
    videoProducer = systemAudioProducer = mixedAudioProducer = micProducer = viewerMicProducer = null;
    // Device'ı sıfırla (yeniden load edilebilmesi için)
    device = null;
    // Video alanını temizle
    if (remoteVideo.srcObject) {
        try { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); } catch (e) { /* yoksay */ }
        remoteVideo.srcObject = null;
    }
    // Konuşma göstergesini sıfırla
    if (videoContainer) videoContainer.classList.remove('speaking-ring');
}

async function initMediasoup() {
    if (initMediasoupPromise) return initMediasoupPromise;
    const hasActiveState =
        device &&
        consumerTransport &&
        !consumerTransport.closed &&
        (!isAdmin || (producerTransport && !producerTransport.closed));

    if (hasActiveState) return device;

    initMediasoupPromise = new Promise((resolve, reject) => {
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
            try {
                if (rtpCapabilities?.error) throw new Error(rtpCapabilities.error);

                // Cihaz zaten yüklüyse (reconnect / yeniden giriş) eski state'i temizle
                if (device) resetMediaState();

                device = new Device();
                await device.load({ routerRtpCapabilities: rtpCapabilities });

                if (isAdmin) {
                    await createSendTransportAsync();
                    await createRecvTransportAsync();
                } else {
                    await createRecvTransportAsync();
                }

                resolve(device);
            } catch (err) {
                reject(err);
            } finally {
                initMediasoupPromise = null;
            }
        });
    });

    return initMediasoupPromise;
}

function createSendTransport() {
    return createSendTransportAsync();
}

function connectTransportWithAckFallback(transport, dtlsParameters, cb, errback) {
    let settled = false;
    const fallback = setTimeout(() => {
        if (settled) return;
        settled = true;
        cb();
    }, 1500);

    socket.emit('transport-connect', { transportId: transport.id, dtlsParameters }, (result = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (result.error) { errback(new Error(result.error)); return; }
        cb();
    });
}

function createSendTransportAsync() {
    if (producerTransport && !producerTransport.closed) return Promise.resolve(producerTransport);
    if (producerTransportPromise) return producerTransportPromise;

    producerTransportPromise = new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
            if (params.error) { console.error(params.error); reject(new Error(params.error)); return; }

            producerTransport = device.createSendTransport(params);
            attachTransportHandlers(producerTransport);

            producerTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                connectTransportWithAckFallback(producerTransport, dtlsParameters, cb, errback);
            });

            producerTransport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('transport-produce', { transportId: producerTransport.id, kind, rtpParameters, appData },
                    ({ id, error }) => { if (error) { errback(new Error(error)); return; } cb({ id }); });
            });

            resolve(producerTransport);
        });
    }).finally(() => {
        producerTransportPromise = null;
    });

    return producerTransportPromise;
}

function createRecvTransport() {
    return createRecvTransportAsync();
}

function createAdminMicTransportAsync() {
    if (adminMicTransport && !adminMicTransport.closed) return Promise.resolve(adminMicTransport);
    if (adminMicTransportPromise) return adminMicTransportPromise;

    adminMicTransportPromise = new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
            if (params.error) { reject(new Error(params.error)); return; }

            adminMicTransport = device.createSendTransport(params);
            attachTransportHandlers(adminMicTransport);
            adminMicTransport.on('transportclose', () => {
                adminMicTransport = null;
                micProducer = null;
            });

            adminMicTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                connectTransportWithAckFallback(adminMicTransport, dtlsParameters, cb, errback);
            });

            adminMicTransport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('transport-produce', { transportId: adminMicTransport.id, kind, rtpParameters, appData },
                    ({ id, error }) => { if (error) { errback(new Error(error)); return; } cb({ id }); });
            });

            resolve(adminMicTransport);
        });
    }).finally(() => {
        adminMicTransportPromise = null;
    });

    return adminMicTransportPromise;
}

function createRecvTransportAsync() {
    if (consumerTransport && !consumerTransport.closed) return Promise.resolve(consumerTransport);
    if (consumerTransportPromise) return consumerTransportPromise;

    consumerTransportPromise = new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
            if (params.error) { console.error(params.error); reject(new Error(params.error)); return; }

            consumerTransport = device.createRecvTransport(params);
            attachTransportHandlers(consumerTransport);

            consumerTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                connectTransportWithAckFallback(consumerTransport, dtlsParameters, cb, errback);
            });

            getProducers();
            resolve(consumerTransport);
        });
    }).finally(() => {
        consumerTransportPromise = null;
    });

    return consumerTransportPromise;
}

/** Create send transport for viewer mic */
function createViewerSendTransport() {
    return createViewerSendTransportAsync();
}

function createViewerSendTransportAsync() {
    if (viewerSendTransport && !viewerSendTransport.closed) return Promise.resolve(viewerSendTransport);
    if (viewerSendTransportPromise) return viewerSendTransportPromise;

    viewerSendTransportPromise = new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
            if (params.error) { reject(new Error(params.error)); return; }

            viewerSendTransport = device.createSendTransport(params);
            attachTransportHandlers(viewerSendTransport);

            viewerSendTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                connectTransportWithAckFallback(viewerSendTransport, dtlsParameters, cb, errback);
            });

            viewerSendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('transport-produce', { transportId: viewerSendTransport.id, kind, rtpParameters, appData },
                    ({ id, error }) => { if (error) { errback(new Error(error)); return; } cb({ id }); });
            });

            resolve(viewerSendTransport);
        });
    }).finally(() => {
        viewerSendTransportPromise = null;
    });

    return viewerSendTransportPromise;
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
    if (!device || !consumerTransport || consumerTransport.closed) {
        try {
            await initMediasoup();
            if (!consumerTransport || consumerTransport.closed) await createRecvTransportAsync();
        } catch (err) {
            console.warn('consume init failed:', err.message);
            return;
        }
    }
    if (!consumerTransport || consumerTransport.closed) return;
    if (consumerByProducerId.has(producerId)) return;
    if (consumingProducerIds.has(producerId)) return;

    consumingProducerIds.add(producerId);

    socket.emit('consume', {
        transportId: consumerTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities
    }, async ({ params }) => {
        try {
            if (params.error) { console.error(params.error); return; }

            const consumer = await consumerTransport.consume({
                id: params.id,
                producerId: params.producerId,
                kind: params.kind,
                rtpParameters: params.rtpParameters
            });

            consumers.set(consumer.id, consumer);
            consumerByProducerId.set(producerId, consumer);

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
                } catch (e) { /* yoksay */ }
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
                audioEl.setAttribute('playsinline', '');
                audioEl.preload = 'auto';
                audioEl.volume = volumeSlider ? parseFloat(volumeSlider.value) : 1;
                // Video mute'una BAĞLANMIYOR — bağımsız audioMutedState (B4)
                audioEl.muted = audioMutedState;
                audioEl.srcObject = new MediaStream([consumer.track]);
                document.body.appendChild(audioEl);
                consumer.appData = { ...(consumer.appData || {}), audioEl, source: meta?.source || null };
                if (mobileDuplexAudioActive) await attachConsumerToMobileAudio(consumer);
                // Hemen play() dene — autoplay reddedilirse playAudioElement() handle eder
                playAudioElement(audioEl);
                unlockRemoteAudioPlayback();
            }

            waitingOverlay.classList.add('hidden');
            pausedOverlay.classList.add('hidden');

            socket.emit('resume', { consumerId: consumer.id });
        } finally {
            consumingProducerIds.delete(producerId);
        }
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
        const isDuplexRouted = audioEl.dataset.mobileDuplexRouted === 'true';
        audioEl.muted = isDuplexRouted || audioMutedState;
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
function unlockRemoteAudioPlayback() {
    resumeMobileRemoteAudioOutput();
    syncAllAudioElements();
    resumePendingAudio();
    if (remoteVideo?.srcObject && remoteVideo.paused) {
        remoteVideo.play().then(() => updatePlayPauseIcon(true)).catch(() => { /* user gesture may still be required */ });
    }
}

function setupAudioGestureUnlock() {
    const unlock = () => unlockRemoteAudioPlayback();
    ['click', 'touchstart', 'pointerdown', 'keydown'].forEach(evt =>
        document.addEventListener(evt, unlock, { once: false, passive: true }));

    const recoverMobileDuplexAudio = () => {
        if (!mobileDuplexAudioActive || document.visibilityState === 'hidden') return;
        void activateMobileDuplexAudioSession();
    };
    document.addEventListener('visibilitychange', recoverMobileDuplexAudio);
    window.addEventListener('pageshow', recoverMobileDuplexAudio);
    navigator.mediaDevices?.addEventListener?.('devicechange', recoverMobileDuplexAudio);
}
setupAudioGestureUnlock();

/**
 * Bir consumer'ı tamamen kapat ve DOM/Map temizliğini yap.
 * Hem producer-closed socket event'inde hem de mediasoup event'lerinde kullanılır.
 */
function closeAndRemoveConsumer(consumer) {
    if (!consumer) return;
    const wasInMap = consumers.delete(consumer.id);
    if (consumer.producerId) {
        const mapped = consumerByProducerId.get(consumer.producerId);
        if (mapped === consumer) consumerByProducerId.delete(consumer.producerId);
    }
    if (videoConsumer === consumer) videoConsumer = null;

    if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
        detachConsumerFromMobileAudio(consumer);
        const el = consumer.appData.audioEl;
        pendingAudioElements.delete(el);
        try { el.pause(); } catch (e) { /* yoksay */ }
        try { el.srcObject = null; } catch (e) { /* yoksay */ }
        el.remove();
        consumer.appData.audioEl = null;
    } else if (consumer.kind === 'video' && remoteVideo.srcObject) {
        try { remoteVideo.srcObject.removeTrack(consumer.track); } catch (e) { /* yoksay */ }
    }

    if (wasInMap) { try { consumer.close(); } catch (e) { /* yoksay */ } }
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
    const volume = getSelectedPlaybackVolume();
    updateMobileRemoteAudioGain(volume);

    for (const [, consumer] of consumers) {
        if (consumer.kind === 'audio' && consumer.appData?.audioEl) {
            const isDuplexRouted = remoteAudioSources.has(consumer.id);
            consumer.appData.audioEl.dataset.mobileDuplexRouted = String(isDuplexRouted);
            consumer.appData.audioEl.muted = isDuplexRouted || audioMutedState;
            consumer.appData.audioEl.volume = volume;
            // Eğer daha önce autoplay yüzünden beklemedeyse ve artık çalması gerekiyorsa
            if (!audioMutedState && consumer.appData.audioEl.paused) {
                playAudioElement(consumer.appData.audioEl);
            }
        }
    }
}

function getSelectedPlaybackVolume() {
    const value = volumeSlider ? parseFloat(volumeSlider.value) : 1;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function setPageAudioSessionType(type) {
    const audioSession = navigator.audioSession;
    if (!audioSession || !('type' in audioSession)) return;
    try {
        audioSession.type = type;
        console.info('[mobile-audio] navigator.audioSession.type=' + type);
    } catch (err) {
        console.debug('[mobile-audio] audio session type could not be changed:', err);
    }
}

function clearClosedRemoteAudioGraph() {
    if (remoteAudioContext?.state !== 'closed') return;
    remoteAudioSources.clear();
    remoteAudioContext = null;
    remoteAudioMasterGain = null;
    remoteAudioLimiter = null;
}

async function ensureMobileRemoteAudioGraph() {
    clearClosedRemoteAudioGraph();
    if (remoteAudioContext && remoteAudioMasterGain && remoteAudioLimiter) {
        if (remoteAudioContext.state === 'suspended') {
            try { await remoteAudioContext.resume(); } catch (e) { /* user gesture may still be required */ }
        }
        return remoteAudioContext;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    try {
        try {
            remoteAudioContext = new AudioCtx({ latencyHint: 'interactive' });
        } catch (e) {
            remoteAudioContext = new AudioCtx();
        }

        remoteAudioMasterGain = remoteAudioContext.createGain();
        remoteAudioLimiter = remoteAudioContext.createDynamicsCompressor();
        remoteAudioLimiter.threshold.value = -3;
        remoteAudioLimiter.knee.value = 6;
        remoteAudioLimiter.ratio.value = 12;
        remoteAudioLimiter.attack.value = 0.003;
        remoteAudioLimiter.release.value = 0.25;
        remoteAudioMasterGain.connect(remoteAudioLimiter);
        remoteAudioLimiter.connect(remoteAudioContext.destination);
        updateMobileRemoteAudioGain();

        if (remoteAudioContext.state === 'suspended') {
            try { await remoteAudioContext.resume(); } catch (e) { /* user gesture may still be required */ }
        }
        return remoteAudioContext;
    } catch (err) {
        console.warn('[mobile-audio] Web Audio output could not be created; element playback remains active:', err);
        remoteAudioContext = null;
        remoteAudioMasterGain = null;
        remoteAudioLimiter = null;
        return null;
    }
}

function updateMobileRemoteAudioGain(volume = getSelectedPlaybackVolume()) {
    if (!remoteAudioContext || !remoteAudioMasterGain) return;
    const target = audioMutedState ? 0 : volume * (mobileDuplexAudioActive ? MOBILE_DUPLEX_OUTPUT_GAIN : 1);
    const now = remoteAudioContext.currentTime;
    try {
        remoteAudioMasterGain.gain.cancelScheduledValues(now);
        remoteAudioMasterGain.gain.setTargetAtTime(target, now, 0.015);
    } catch (e) {
        remoteAudioMasterGain.gain.value = target;
    }
}

async function attachConsumerToMobileAudio(consumer) {
    if (!mobileDuplexAudioActive || consumer?.kind !== 'audio' || !consumer.track) return false;
    if (remoteAudioSources.has(consumer.id)) return true;

    const context = await ensureMobileRemoteAudioGraph();
    if (!context || !mobileDuplexAudioActive || !consumers.has(consumer.id) || consumer.track.readyState === 'ended') return false;
    // Recovery events can overlap; another call may have attached it while we awaited resume().
    if (remoteAudioSources.has(consumer.id)) return true;

    try {
        const stream = new MediaStream([consumer.track]);
        const source = context.createMediaStreamSource(stream);
        source.connect(remoteAudioMasterGain);
        remoteAudioSources.set(consumer.id, { source, stream });
        if (consumer.appData?.audioEl) {
            consumer.appData.audioEl.dataset.mobileDuplexRouted = 'true';
            consumer.appData.audioEl.muted = true;
        }
        return true;
    } catch (err) {
        console.warn('[mobile-audio] Consumer could not be routed through Web Audio:', err);
        return false;
    }
}

function detachConsumerFromMobileAudio(consumer) {
    if (!consumer) return;
    const routed = remoteAudioSources.get(consumer.id);
    if (routed) {
        try { routed.source.disconnect(); } catch (e) { /* already disconnected */ }
        remoteAudioSources.delete(consumer.id);
    }
    if (consumer.appData?.audioEl) {
        consumer.appData.audioEl.dataset.mobileDuplexRouted = 'false';
    }
}

async function enableMobileRemoteAudioRouting() {
    const context = await ensureMobileRemoteAudioGraph();
    if (!context || !mobileDuplexAudioActive) {
        syncAllAudioElements();
        return;
    }
    const audioConsumers = [...consumers.values()].filter(consumer => consumer.kind === 'audio');
    await Promise.all(audioConsumers.map(consumer => attachConsumerToMobileAudio(consumer)));
    syncAllAudioElements();
}

function disableMobileRemoteAudioRouting() {
    for (const consumer of consumers.values()) {
        if (consumer.kind === 'audio') detachConsumerFromMobileAudio(consumer);
    }
    updateMobileRemoteAudioGain();
    syncAllAudioElements();
    if (remoteAudioContext?.state === 'running') {
        remoteAudioContext.suspend().catch(() => { /* best effort */ });
    }
}

function resumeMobileRemoteAudioOutput() {
    if (!mobileDuplexAudioActive || remoteAudioContext?.state !== 'suspended') return;
    remoteAudioContext.resume().then(() => updateMobileRemoteAudioGain()).catch(() => { /* user gesture may still be required */ });
}

async function prepareMobileDuplexAudioSession() {
    if (!isLikelyMobileDevice()) return;
    if (mobileAudioSessionReassertTimer) clearTimeout(mobileAudioSessionReassertTimer);
    // WebKit route reset: release a stale capture route before requesting the mic.
    setPageAudioSessionType('auto');
    await ensureMobileRemoteAudioGraph();
}

async function activateMobileDuplexAudioSession() {
    if (!isLikelyMobileDevice()) return;
    mobileDuplexAudioActive = true;
    setPageAudioSessionType('play-and-record');
    await enableMobileRemoteAudioRouting();
    resumeMobileRemoteAudioOutput();

    if (mobileAudioSessionReassertTimer) clearTimeout(mobileAudioSessionReassertTimer);
    mobileAudioSessionReassertTimer = setTimeout(() => {
        if (!mobileDuplexAudioActive) return;
        setPageAudioSessionType('play-and-record');
        resumeMobileRemoteAudioOutput();
        syncAllAudioElements();
    }, 250);
}

function deactivateMobileDuplexAudioSession() {
    if (!isLikelyMobileDevice()) return;
    mobileDuplexAudioActive = false;
    if (mobileAudioSessionReassertTimer) {
        clearTimeout(mobileAudioSessionReassertTimer);
        mobileAudioSessionReassertTimer = null;
    }
    disableMobileRemoteAudioRouting();
    // WebKit needs playback -> auto to leave the capture/receiver route reliably.
    setPageAudioSessionType('playback');
    setPageAudioSessionType('auto');
    setTimeout(() => unlockRemoteAudioPlayback(), 0);
}

// ==================== ADMIN: STREAM CONTROLS ====================

/**
 * Stream timer ve LIVE badge yönetimi
 */
function startStreamTimer() {
    streamStartTime = Date.now();
    const update = () => {
        const elapsed = Math.floor((Date.now() - streamStartTime) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        if (streamTimerEl) streamTimerEl.textContent = `${mm}:${ss}`;
        if (adminTimerEl) adminTimerEl.textContent = `${mm}:${ss}`;
    };
    update();
    streamTimerInterval = setInterval(update, 1000);
    // LIVE badge göster
    if (streamStatusBadge) { streamStatusBadge.classList.remove('hidden'); streamStatusBadge.classList.add('flex'); }
    if (adminStreamInfo) { adminStreamInfo.classList.remove('hidden'); adminStreamInfo.classList.add('flex'); }
}

function stopStreamTimer() {
    if (streamTimerInterval) { clearInterval(streamTimerInterval); streamTimerInterval = null; }
    streamStartTime = null;
    if (streamStatusBadge) { streamStatusBadge.classList.add('hidden'); streamStatusBadge.classList.remove('flex'); }
    if (adminStreamInfo) { adminStreamInfo.classList.add('hidden'); adminStreamInfo.classList.remove('flex'); }
}

/**
 * Kalite preset'leri — çözünürlük + FPS + bitrate'i birlikte ayarlar
 */
const QUALITY_PRESETS = {
    low:    { res: '480',  fps: '24', bitrate: '1500',  label: 'Düşük' },
    medium: { res: '720',  fps: '30', bitrate: '3500',  label: 'Orta' },
    high:   { res: '720',  fps: '30', bitrate: '5000',  label: 'Yüksek' },
    ultra:  { res: '1080', fps: '60', bitrate: '10000', label: 'Ultra' }
};

function applyPreset(preset) {
    const p = QUALITY_PRESETS[preset];
    if (!p) return;
    if (resSelect) resSelect.value = p.res;
    if (fpsSelect) fpsSelect.value = p.fps;
    if (bitrateInput) bitrateInput.value = p.bitrate;
    // Aktif preset görselini güncelle
    presetButtons.forEach(btn => {
        btn.classList.toggle('preset-active', btn.dataset.preset === preset);
    });
}

presetButtons.forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

btnStartStream.addEventListener('click', async () => {
    await initMediasoup();
    await startStream();
});

async function startStream() {
    if (!canUseDisplayCapture()) {
        showToast('Bu cihaz/tarayici ekran paylasimini desteklemiyor. Mobilde izleyici modu onerilir.', 'warning', 6000);
        return;
    }

    // Refresh only screen/system producers. Admin mic uses its own transport.
    [videoProducer, systemAudioProducer, mixedAudioProducer].forEach(p => {
        if (p) { socket.emit('producer-closing', { producerId: p.id }); try { p.close(); } catch (e) { /* yoksay */ } }
    });
    videoProducer = systemAudioProducer = mixedAudioProducer = null;

    if (producerTransport) {
        try { producerTransport.close(); } catch (e) { /* yoksay */ }
        producerTransport = null;
        if (micProducer?.closed) micProducer = null;
    }

    // Drop stale system audio tracks before asking for a fresh screen stream.
    if (systemAudioTrack) {
        try { systemAudioTrack.stop(); } catch (e) { /* yoksay */ }
        systemAudioTrack = null;
    }

    const height  = parseInt(resSelect.value);
    const fps     = parseInt(fpsSelect.value);
    const bitrate = parseInt(bitrateInput.value) * 1000;
    const width   = Math.round(height * (16 / 9));

    try {
        await createSendTransportAsync();
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
            startStreamTimer();
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
    [videoProducer, systemAudioProducer, mixedAudioProducer].forEach(p => {
        if (p) { socket.emit('producer-closing', { producerId: p.id }); try { p.close(); } catch (e) { /* yoksay */ } }
    });
    videoProducer = systemAudioProducer = mixedAudioProducer = null;

    if (producerTransport && !micProducer) {
        try { producerTransport.close(); } catch (e) { /* yoksay */ }
        producerTransport = null;
    }

    if (systemAudioTrack) { systemAudioTrack.stop(); systemAudioTrack = null; }

    if (localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(t => t.stop());
        localVideo.srcObject = null;
    }

    btnStartStream.classList.remove('hidden');
    btnStopStream.classList.add('hidden');
    updateAdminAudioButton(false);
    stopStreamTimer();
    showToast('Yayın durduruldu');
}

/**
 * Admin mikrofon producer'ını (gerekirse) oluştur/yeniden yayınla.
 * B1 DÜZELTMESİ: Mikrofon yayın başlamadan önce açıldıysa producerTransport henüz
 * yoktu ve micProducer hiç oluşmuyordu. Bu fonksiyon, transport hazır olduktan
 * sonra (startStream sonunda veya transport gelince) eksik producer'ı kurar.
 */
async function republishAdminMic() {
    if (adminMicPublishPromise) return adminMicPublishPromise;
    adminMicPublishPromise = republishAdminMicUnlocked().finally(() => {
        adminMicPublishPromise = null;
    });
    return adminMicPublishPromise;
}

async function republishAdminMicUnlocked() {
    // Mikrofon track'i yoksa veya producer zaten varsa bir şey yapma
    if (!micTrack || micProducer) return;

    if (!adminMicTransport || adminMicTransport.closed) {
        await createAdminMicTransportAsync();
    }
    try {
        micProducer = await adminMicTransport.produce({
            track: micTrack,
            codecOptions: { opusStereo: 0, opusFec: 1, opusDtx: 0, opusMaxAverageBitrate: 64000 },
            appData: { source: 'admin-mic' }
        });
        micProducer.on('transportclose', () => { micProducer = null; });
        micProducer.on('trackended', () => { micProducer = null; updateAdminMicButton(false); });
        console.log('🎤 Admin mic producer oluşturuldu:', micProducer.id);
    } catch (err) {
        console.error('Admin mic republish hatası:', err);
        showToast('Mikrofon yayını başlatılamadı');
    }
}


function loadMicNoiseSuppressionPreference() {
    try {
        const saved = localStorage.getItem(MIC_NOISE_SUPPRESSION_STORAGE_KEY);
        return saved === null ? true : saved === 'true';
    } catch (e) {
        return true;
    }
}

function saveMicNoiseSuppressionPreference() {
    try { localStorage.setItem(MIC_NOISE_SUPPRESSION_STORAGE_KEY, String(micNoiseSuppressionEnabled)); } catch (e) { /* yoksay */ }
}

function detectMicNoiseSuppressionSupport() {
    const supported = navigator.mediaDevices?.getSupportedConstraints?.();
    return !supported || supported.noiseSuppression === true;
}

function buildMicCaptureConstraints() {
    const audio = {
        echoCancellation: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
    };
    if (micNoiseSuppressionSupported) audio.noiseSuppression = micNoiseSuppressionEnabled;
    return { audio };
}

function buildMicLiveConstraints() {
    const constraints = {
        echoCancellation: true,
        autoGainControl: true
    };
    if (micNoiseSuppressionSupported) constraints.noiseSuppression = micNoiseSuppressionEnabled;
    return constraints;
}

function syncMicNoiseSuppressionToggles() {
    const toggles = [adminNoiseSuppressionToggle, viewerNoiseSuppressionToggle].filter(Boolean);
    toggles.forEach((toggle) => {
        toggle.checked = micNoiseSuppressionSupported && micNoiseSuppressionEnabled;
        toggle.disabled = !micNoiseSuppressionSupported;
        const label = toggle.closest('label');
        if (label) {
            label.classList.toggle('opacity-50', !micNoiseSuppressionSupported);
            label.classList.toggle('cursor-not-allowed', !micNoiseSuppressionSupported);
            label.title = micNoiseSuppressionSupported ? '' : 'Bu taray\u0131c\u0131 mikrofon g\u00fcr\u00fclt\u00fc engellemeyi desteklemiyor';
        }
    });
}

function initMicNoiseSuppressionControls() {
    micNoiseSuppressionSupported = detectMicNoiseSuppressionSupport();
    syncMicNoiseSuppressionToggles();

    [adminNoiseSuppressionToggle, viewerNoiseSuppressionToggle].filter(Boolean).forEach((toggle) => {
        toggle.addEventListener('change', () => {
            void setMicNoiseSuppressionEnabled(toggle.checked);
        });
    });
}

async function setMicNoiseSuppressionEnabled(enabled) {
    if (!micNoiseSuppressionSupported) {
        syncMicNoiseSuppressionToggles();
        showToast('Bu taray\u0131c\u0131 mikrofon g\u00fcr\u00fclt\u00fc engellemeyi desteklemiyor', 'warning');
        return;
    }

    const previousValue = micNoiseSuppressionEnabled;
    micNoiseSuppressionEnabled = !!enabled;
    saveMicNoiseSuppressionPreference();
    syncMicNoiseSuppressionToggles();

    try {
        await applyMicNoiseSuppressionToLiveMic();
    } catch (err) {
        micNoiseSuppressionEnabled = previousValue;
        saveMicNoiseSuppressionPreference();
        console.warn('Mikrofon g\u00fcr\u00fclt\u00fc engelleme g\u00fcncellenemedi:', err);
        showToast('G\u00fcr\u00fclt\u00fc engelleme de\u011fi\u015ftirilemedi');
        syncMicNoiseSuppressionToggles();
    }
}

function getActiveLocalMicContext() {
    if (micTrack?.readyState === 'live') {
        return { role: 'admin', track: micTrack, producer: micProducer };
    }
    if (viewerMicTrack?.readyState === 'live') {
        return { role: 'viewer', track: viewerMicTrack, producer: viewerMicProducer };
    }
    return null;
}

async function applyMicNoiseSuppressionToLiveMic() {
    const context = getActiveLocalMicContext();
    if (!context) return;

    try {
        await context.track.applyConstraints(buildMicLiveConstraints());
        setupVAD(new MediaStream([context.track]));
        logMicNoiseSuppressionSettings(context.role, context.track);
        showToast(micNoiseSuppressionEnabled ? 'G\u00fcr\u00fclt\u00fc engelleme a\u00e7\u0131ld\u0131' : 'G\u00fcr\u00fclt\u00fc engelleme kapat\u0131ld\u0131', 'success');
    } catch (err) {
        console.warn('applyConstraints ba\u015far\u0131s\u0131z, mikrofon track de\u011fi\u015ftiriliyor:', err);
        await replaceLiveMicTrack(context);
    }
}

async function replaceLiveMicTrack(context) {
    const stream = await navigator.mediaDevices.getUserMedia(buildMicCaptureConstraints());
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) throw new Error('Yeni mikrofon track al\u0131namad\u0131');

    try {
        if (context.producer && !context.producer.closed) {
            await context.producer.replaceTrack({ track: newTrack });
        }

        const oldTrack = context.role === 'admin' ? micTrack : viewerMicTrack;
        if (context.role === 'admin') {
            micTrack = newTrack;
            updateAdminMicButton(true);
        } else {
            viewerMicTrack = newTrack;
            viewerMicTrack.onended = () => closeViewerMic();
            updateViewerMicButton(true);
            await activateMobileDuplexAudioSession();
        }
        if (oldTrack && oldTrack !== newTrack) oldTrack.stop();

        setupVAD(stream);
        logMicNoiseSuppressionSettings(context.role, newTrack);
        showToast(micNoiseSuppressionEnabled ? 'G\u00fcr\u00fclt\u00fc engelleme a\u00e7\u0131ld\u0131' : 'G\u00fcr\u00fclt\u00fc engelleme kapat\u0131ld\u0131', 'success');
    } catch (err) {
        newTrack.stop();
        throw err;
    }
}

function logMicNoiseSuppressionSettings(role, track) {
    const settings = track?.getSettings?.() || {};
    const actual = Object.prototype.hasOwnProperty.call(settings, 'noiseSuppression') ? settings.noiseSuppression : 'unknown';
    console.info('[mic:' + role + '] noiseSuppression requested=' + micNoiseSuppressionEnabled + ', actual=' + actual);
}

// Admin's own mic toggle
btnToggleMic.addEventListener('click', async () => {
    if (micTrack) {
        // --- Mikrofonu KAPAT ---
        micTrack.stop(); micTrack = null;
        updateAdminMicButton(false);
        if (micProducer) {
            socket.emit('producer-closing', { producerId: micProducer.id });
            try { micProducer.close(); } catch(e) { /* yoksay */ }
            micProducer = null;
        }
        if (adminMicTransport) {
            try { adminMicTransport.close(); } catch(e) { /* yoksay */ }
            adminMicTransport = null;
        }
        stopVAD();
    } else {
        // --- Mikrofonu AÇ ---
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('Bu tarayici mikrofon erisimini desteklemiyor');
            }
            const stream = await navigator.mediaDevices.getUserMedia(buildMicCaptureConstraints());
            micTrack = stream.getAudioTracks()[0];
            logMicNoiseSuppressionSettings('admin', micTrack);
            unlockRemoteAudioPlayback();
            updateAdminMicButton(true);
            // Producer'ı oluştur (transport varsa). Yoksa startStream sonunda
            // republishAdminMic() ile tamamlanacak (B1 düzeltmesi).
            await republishAdminMic();
            unlockRemoteAudioPlayback();
            setupVAD(stream);
        } catch (err) {
            console.error('Mic error:', err);
            showToast('Mikrofon erişimi başarısız: ' + (err.message || ''));
        }
    }
});

/** Admin mikrofon butonu için net görsel state (U2) — SVG+span yapısına uygun */
function updateAdminMicButton(on) {
    if (!btnToggleMic) return;
    const span = btnToggleMic.querySelector('span');
    if (on) {
        if (span) span.textContent = 'Mikrofonum (Açık)';
        btnToggleMic.className = 'w-full py-2 bg-red-600/60 hover:bg-red-600 rounded-lg text-xs transition-all ctrl-btn flex items-center justify-center gap-1.5 font-medium';
    } else {
        if (span) span.textContent = 'Mikrofonum (Kapalı)';
        btnToggleMic.className = 'w-full py-2 bg-slate-700/50 hover:bg-slate-600 rounded-lg text-xs transition-all ctrl-btn flex items-center justify-center gap-1.5';
    }
}

/**
 * Sistem sesi producer'ını (gerekirse) oluştur. Mevcut track'i yeniden kullanır
 * böylece tekrar ekran paylaşım izin diyaloğu çıkmaz (U3 düzeltmesi).
 */
async function republishSystemAudio() {
    if (!systemAudioTrack || systemAudioProducer) return;
    if (!producerTransport || producerTransport.closed) {
        await createSendTransportAsync();
    }
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

/** Admin sistem sesi butonu için net görsel state (U2) — SVG+span yapısına uygun */
function updateAdminAudioButton(on) {
    if (!btnToggleAudio) return;
    const span = btnToggleAudio.querySelector('span');
    if (on) {
        if (span) span.textContent = 'Sistem Sesi (Açık)';
        btnToggleAudio.className = 'w-full py-2 bg-emerald-700/40 hover:bg-emerald-700/50 border border-emerald-700/30 rounded-lg text-xs transition-all ctrl-btn flex items-center justify-center gap-1.5 font-medium';
    } else {
        if (span) span.textContent = 'Sistem Sesi (Kapalı)';
        btnToggleAudio.className = 'w-full py-2 bg-slate-700/50 hover:bg-slate-600 rounded-lg text-xs transition-all ctrl-btn flex items-center justify-center gap-1.5';
    }
}

// Admin's system audio toggle
btnToggleAudio.addEventListener('click', async () => {
    if (systemAudioProducer) {
        // --- Sistem sesini KAPAT ---
        // U3: track'i durdurma — sadece producer'ı kapat. Böylece tekrar açarken
        // yeniden getDisplayMedia çağrılmaz (kullanıcıyı tekrar prompt etmez).
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        try { systemAudioProducer.close(); } catch(e) { /* yoksay */ }
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
        btnToggleViewerMic.className = 'w-full py-2 bg-emerald-700/30 hover:bg-emerald-700/40 border border-emerald-700/30 rounded-lg text-xs transition-all ctrl-btn font-medium';
    } else {
        btnToggleViewerMic.textContent = '🎙️ İzleyici Mikrofonu: Kapalı';
        btnToggleViewerMic.className = 'w-full py-2 bg-red-700/20 hover:bg-red-700/30 border border-red-700/20 rounded-lg text-xs transition-all ctrl-btn font-medium text-red-400';
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
        btnToggleChat.className = 'w-full py-2 bg-emerald-700/30 hover:bg-emerald-700/40 border border-emerald-700/30 rounded-lg text-xs transition-all ctrl-btn font-medium';
    } else {
        btnToggleChat.textContent = '💬 Chat: Kapalı';
        btnToggleChat.className = 'w-full py-2 bg-red-700/20 hover:bg-red-700/30 border border-red-700/20 rounded-lg text-xs transition-all ctrl-btn font-medium text-red-400';
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

    if (viewerMicProducer || viewerMicTrack?.readyState === 'live') {
        closeViewerMic();
    } else {
        await openViewerMic();
    }
});

async function openViewerMic() {
    if (viewerMicOpenPromise) return viewerMicOpenPromise;
    viewerMicOpenPromise = openViewerMicUnlocked().finally(() => {
        viewerMicOpenPromise = null;
    });
    return viewerMicOpenPromise;
}

async function openViewerMicUnlocked() {
    if (!viewerMicEnabled) return;

    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Bu tarayici mikrofon erisimini desteklemiyor');
        }
        await prepareMobileDuplexAudioSession();
        const stream = await navigator.mediaDevices.getUserMedia(buildMicCaptureConstraints());
        viewerMicTrack = stream.getAudioTracks()[0];
        if (!viewerMicTrack) throw new Error('Mikrofon ses izi alınamadı');
        await activateMobileDuplexAudioSession();
        logMicNoiseSuppressionSettings('viewer', viewerMicTrack);
        unlockRemoteAudioPlayback();

        // Ensure we have a healthy mediasoup state
        await initMediasoup();

        // Ensure recv transport exists (viewers need it to hear others)
        if (!consumerTransport || consumerTransport.closed) await createRecvTransportAsync();

        // Create send transport if not exists
        if (!viewerSendTransport || viewerSendTransport.closed) {
            await createViewerSendTransportAsync();
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

        viewerMicProducer.on('transportclose', () => {
            viewerMicProducer = null;
            updateViewerMicButton(false);
        });
        viewerMicProducer.on('trackended', () => closeViewerMic());

        setupVAD(stream);
        updateViewerMicButton(true);
        unlockRemoteAudioPlayback();

        viewerMicTrack.onended = () => closeViewerMic();
    } catch (err) {
        console.error('Viewer mic error:', err);
        if (viewerMicProducer) { try { viewerMicProducer.close(); } catch (e) { /* yoksay */ } viewerMicProducer = null; }
        if (viewerMicTrack) { try { viewerMicTrack.stop(); } catch (e) { /* yoksay */ } viewerMicTrack = null; }
        deactivateMobileDuplexAudioSession();
        updateViewerMicButton(false);
        showToast('Mikrofon açılamadı: ' + (err.message || 'İzin reddedildi'));
    }
}

async function republishViewerMic() {
    if (!viewerMicEnabled || !viewerMicTrack || viewerMicTrack.readyState !== 'live' || viewerMicProducer) return;

    await activateMobileDuplexAudioSession();
    await initMediasoup();
    if (!consumerTransport || consumerTransport.closed) await createRecvTransportAsync();
    if (!viewerSendTransport || viewerSendTransport.closed) await createViewerSendTransportAsync();

    viewerMicProducer = await viewerSendTransport.produce({
        track: viewerMicTrack,
        codecOptions: {
            opusStereo: 0,
            opusFec: 1,
            opusDtx: 0,
            opusMaxAverageBitrate: 64000
        },
        appData: { source: 'viewer-mic' }
    });
    viewerMicProducer.on('transportclose', () => {
        viewerMicProducer = null;
        updateViewerMicButton(false);
    });
    viewerMicProducer.on('trackended', () => closeViewerMic());

    setupVAD(new MediaStream([viewerMicTrack]));
    updateViewerMicButton(true);
    unlockRemoteAudioPlayback();
}

function closeViewerMic() {
    stopVAD();
    if (viewerMicProducer) {
        socket.emit('producer-closing', { producerId: viewerMicProducer.id });
        try { viewerMicProducer.close(); } catch (e) { /* yoksay */ }
        viewerMicProducer = null;
    }
    if (viewerSendTransport) {
        try { viewerSendTransport.close(); } catch (e) { /* yoksay */ }
        viewerSendTransport = null;
    }
    if (viewerMicTrack) { viewerMicTrack.stop(); viewerMicTrack = null; }
    deactivateMobileDuplexAudioSession();
    socket.emit('voice-activity', { speaking: false });
    updateViewerMicButton(false);
}

function updateViewerMicButton(open) {
    if (!btnViewerMic) return;
    const span = btnViewerMic.querySelector('span');
    if (!viewerMicEnabled) {
        if (span) span.textContent = 'Mikrofon (Devre Dışı)';
        btnViewerMic.disabled = true;
        btnViewerMic.className = 'w-full py-2.5 bg-slate-600/30 text-slate-500 rounded-lg text-sm cursor-not-allowed flex items-center justify-center gap-2';
    } else if (open) {
        if (span) span.textContent = 'Mikrofonu Kapat';
        btnViewerMic.disabled = false;
        btnViewerMic.className = 'w-full py-2.5 bg-red-600/60 hover:bg-red-600 rounded-lg text-sm transition-all ctrl-btn font-medium flex items-center justify-center gap-2';
    } else {
        if (span) span.textContent = 'Mikrofon Aç';
        btnViewerMic.disabled = false;
        btnViewerMic.className = 'w-full py-2.5 bg-slate-700/50 hover:bg-slate-600 rounded-lg text-sm transition-all ctrl-btn font-medium flex items-center justify-center gap-2';
    }
}

// ==================== VAD (Voice Activity Detection) ====================

function setupVAD(stream) {
    stopVAD();
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        vadContext = new AudioCtx();
        if (vadContext.state === 'suspended') {
            vadContext.resume().catch(() => { /* user gesture may still be required */ });
        }
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
    if (vadContext) { try { vadContext.close(); } catch (e) { /* yoksay */ } vadContext = null; }
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
    try { localStorage.setItem('velo_volume', String(v)); } catch (e2) { /* yoksay */ }
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

            // U7: Düşük kalite uyarısı — videoLossPct burada tanımlanıyor
            const videoLossPct = packetsTotal ? (packetsLost / packetsTotal) * 100 : 0;
            const now2 = Date.now();

            // Bağlantı kalitesi göstergesi (header)
            if (connDot && connText) {
                const rttMs = rtt ? Math.round(rtt * 1000) : 0;
                if (videoLossPct > 5 || rttMs > 300) {
                    connDot.className = "w-2 h-2 rounded-full conn-poor";
                    connText.textContent = "Zayıf";
                } else if (videoLossPct > 2 || rttMs > 150) {
                    connDot.className = "w-2 h-2 rounded-full conn-good";
                    connText.textContent = "Orta";
                } else {
                    connDot.className = "w-2 h-2 rounded-full conn-excellent";
                    connText.textContent = "İyi";
                }
            }

            if (videoLossPct > 8 && (!showToast._lastLowQualityWarn || now2 - showToast._lastLowQualityWarn > 15000)) {
                showToast._lastLowQualityWarn = now2;
                showToast('Bağlantı zayıf görünüyor, görüntü kalitesi düşebilir', 'warning');
            }
        } catch (e) { /* yoksay */ }
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

function canUseDisplayCapture() {
    return !!navigator.mediaDevices?.getDisplayMedia;
}

function isLikelyMobileDevice() {
    const ua = navigator.userAgent || '';
    return navigator.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
        (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
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

function showToast(message, type = 'error', duration = 3500) {
    toastMessage.textContent = message;
    const colors = {
        error:   'bg-red-500 border-red-600',
        success: 'bg-green-600 border-green-700',
        warning: 'bg-yellow-500 border-yellow-600'
    };
    toast.className = `fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-xs px-5 py-3 rounded-lg shadow-lg text-white border z-50 ${colors[type] || colors.error}`;
    toast.classList.remove('hidden');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), duration);
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
    if (viewerMicProducer || viewerMicTrack) closeViewerMic();
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
    } catch (e) { /* yoksay */ }

    initMicNoiseSuppressionControls();
    const nickname = await showNicknameModal();
    await initSocket(nickname);
})();
