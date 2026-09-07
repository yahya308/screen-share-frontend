/**
 * VELOSTREAM Room - v2
 * Features: nickname, user list, chat, viewer mic (VAD), moderasyon (kick/ban)
 */

// Çıplak ad ('mediasoup-client') değil, gerçek yol. Çıplak adı çözmek satır içi
// bir import map gerektiriyordu; onu da üretimdeki `script-src 'self'` engelliyor
// ve bu modül hiç çalışmıyordu (bkz. room.html'deki not).
import { Device } from '/vendor/mediasoup-client.esm.js?v=3.18.1';
import { screenSettings, screenEncodings, preferredLayers, layerLimits, playoutTarget, audioLevel, canUseShortcut, RtcSampler } from './media-policy.mjs';

// ==================== URL PARAMS ====================

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');

if (!roomId) window.location.href = 'index.html';

const ADMIN_TOKEN_KEY = `velo_admin_token_${roomId}`;

/** Odayı kurarken saklanan yönetici sırrını oku (yoksa ''). */
function readAdminToken() {
    try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
    catch { return ''; }
}

function clearAdminToken() {
    try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); }
    catch { /* depolama kapalı olabilir */ }
}

// Yönetici modunu URL DEĞİL, sırrın kendisi belirler.
//
// Önceden yalnızca `?admin=true` sorgusuna bakılıyordu. O parametre yolda
// düşerse — temiz URL yönlendirmesi, kopyalanırken kırpılan bir bağlantı,
// sekme geri yükleme — oda sahibi kendi odasına İZLEYİCİ olarak giriyordu.
// Token zaten yetkinin tek kanıtı; modun da tek kaynağı o olmalı. Sorgu
// parametresi yalnızca "yönetici olmayı bekliyordum" niyetini taşıyor.
const wantsAdmin = urlParams.get('admin') === 'true';
const isAdminMode = !!readAdminToken();

// ==================== STATE ====================

let socket;
let mediaEpoch = 0;
let roomJoined = false;
let lastRoomPassword = null;
let commonCodecs = null;
let iceConfig = null;
let iceRefreshTimer = null;
let mediaRecovery = null;
let screenPublishPromise = null;
let simulcastFallback = false;
let appliedScreenSettings = null;
let userPaused = false;
let systemAudioWanted = true;
let screenRevision = 0;
let playoutBufferMs = 150;
let lastBufferChange = 0;
let lastQualityMetrics = null;
let streamJoinedAt = 0;
let firstFrameMs = null;
let freezeTotal = 0;
let freezeSecondsTotal = 0;
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
let statsSampler = null;

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
const contentTypeSelect  = document.getElementById('contentTypeSelect');
const codecSelect        = document.getElementById('codecSelect');

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
    socket = io(config.signalingUrl || window.location.origin, { reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    registerSocketEvents();
    socket.on('connect', () => {
        mySocketId = socket.id;
        const epoch = mediaEpoch;
        const adminToken = readAdminToken();
        if (isAdminMode && adminToken) {
            signal('admin-rejoin', { roomId, nickname, adminToken }, epoch).then(async result => {
                if (result.error) {
                    if (result.forbidden) clearAdminToken();
                    showToast(result.error, 'error', 8000);
                    setMediaStatus(result.error); return;
                }
                roomName.textContent = result.roomName; userCount.textContent = result.userCount || 1;
                maxUsersInput.value = result.maxUsers || 100;
                viewerMicEnabled = result.viewerMicEnabled ?? true; chatEnabled = result.chatEnabled ?? true;
                roomContentType = ['motion', 'interactive'].includes(result.contentType) ? result.contentType : 'detail';
                isAdmin = true; roomJoined = true;
                setupAdminUI(); updateViewerMicToggle(); updateChatToggle();
                await initMediasoup();
                if (epoch !== mediaEpoch) return;
                if (localVideo.srcObject?.getVideoTracks()[0]?.readyState === 'live') await publishScreen(localVideo.srcObject);
                await republishAdminMic();
                setMediaStatus('');
            }).catch(err => { mediaError(err); setMediaStatus('Bağlantı kurulamadı. Yeniden bağlanmayı deneyin.', true); });
        } else {
            void attemptJoinRoom(lastRoomPassword || sessionStorage.getItem('room_password_' + roomId), nickname);
        }
    });
    socket.on('disconnect', () => {
        roomJoined = false; mediaEpoch++; iceConfig = null; clearTimeout(iceRefreshTimer);
        resetMediaState();
        setMediaStatus('Bağlantı kesildi. Yeniden bağlanılıyor…');
    });
    socket.on('connect_error', () => setMediaStatus('Sunucuya ulaşılamıyor. Bağlantı yeniden deneniyor…'));
}

function registerSocketEvents() {
    socket.on('viewer-codecs', ({ codecs }) => {
        commonCodecs = codecs;
        const current = videoProducer?.rtpParameters?.codecs?.find(c => c.mimeType.startsWith('video/'))?.mimeType?.toLowerCase();
        if (isAdmin && current && codecs.length && !codecs.includes(current) && localVideo.srcObject) {
            showToast('Yeni izleyici için uyumlu görüntü biçimine geçiliyor', 'warning', 6000);
            void publishScreen(localVideo.srcObject).catch(mediaError);
        }
    });
    // User count updates
    socket.on('user-joined', ({ userCount: c }) => { userCount.textContent = c; });
    socket.on('user-left', ({ userCount: c }) => { userCount.textContent = c; });

    // Full user list
    socket.on('user-list', (users) => renderUserList(users));

    // Mediasoup events
    // new-producer artık { id, kind, source } objesi gönderiyor (eski id-only ile uyumlu)
    socket.on('new-producer', (data) => {
        const producerId = typeof data === 'object' ? data.id : data;
        void consumeProducer(producerId, typeof data === 'object' ? data : null);
    });

    socket.on('stream-started', () => {
        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');
        void initMediasoup().then(() => {
            if (consumerTransport && !consumerTransport.closed) return getProducers();
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
    // Sunucu düzgün kapanıyor: "bağlantı koptu" yerine ne olduğunu söyle.
    // Socket.io yeniden bağlanma zaten açık, sayfayı terk etmeye gerek yok.
    socket.on('server-restarting', ({ reason }) => {
        showToast(reason || 'Sunucu güncelleniyor, yeniden bağlanılıyor...', 'warning', 8000);
    });

    // Aynı token başka bir sekmede/cihazda kullanıldı: bu oturum yöneticiliği bıraktı.
    socket.on('admin-superseded', () => {
        isAdmin = false;
        showToast('Yöneticilik başka bir oturuma devredildi', 'warning', 5000);
        setTimeout(() => window.location.href = 'index.html', 2500);
    });

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

    // Yayıncı içerik türünü değiştirdi: oynatma tamponunu yeniden ayarla.
    socket.on('content-type', ({ contentType }) => {
        roomContentType = ['motion', 'interactive'].includes(contentType) ? contentType : 'detail';
        playoutBufferMs = playoutTarget(roomContentType);
        applyPlayoutBuffer();
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

async function attemptJoinRoom(password, nickname) {
    const epoch = mediaEpoch;
    try {
        const result = await signal('join-room', { roomId, password, nickname }, epoch);
        if (result.error) {
            if (result.needPassword) showPasswordModal(nickname);
            else { showToast(result.error, 'error', 8000); setMediaStatus(result.error); }
            return;
        }
        lastRoomPassword = password || null;
        sessionStorage.removeItem('room_password_' + roomId);
        roomName.textContent = result.roomName; userCount.textContent = result.userCount || 1;
        viewerMicEnabled = result.viewerMicEnabled ?? true; chatEnabled = result.chatEnabled ?? true;
        roomContentType = ['motion', 'interactive'].includes(result.contentType) ? result.contentType : 'detail';
        playoutBufferMs = playoutTarget(roomContentType);
        isAdmin = false; roomJoined = true;
        setupViewerUI(); updateViewerMicButton(); updateChatUI();
        await initMediasoup();
        if (epoch !== mediaEpoch) return;
        if (viewerMicTrack?.readyState === 'live') await republishViewerMic();
        setMediaStatus('');
    } catch (err) { mediaError(err); setMediaStatus('Medya bağlantısı kurulamadı. Yeniden bağlanmayı deneyin.', true); }
}

function showPasswordModal(nickname) {
    const modal = document.getElementById('passwordModal');
    const input = document.getElementById('passwordInput');
    const error = document.getElementById('passwordModalError');
    modal.classList.remove('hidden'); modal.classList.add('flex'); input.value = ''; input.focus();
    error.textContent = 'Şifreyi kontrol edip tekrar deneyin.'; error.classList.remove('hidden');
    const submit = async () => {
        if (!input.value) return;
        const password = input.value; modal.classList.add('hidden'); modal.classList.remove('flex');
        await attemptJoinRoom(password, nickname);
    };
    document.getElementById('btnSubmitPassword').onclick = () => void submit();
    input.onkeydown = e => { if (e.key === 'Enter') void submit(); };
    document.getElementById('btnCancelPassword').onclick = () => { window.location.href = 'index.html'; };
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
                    <button type="button" data-action="kick" title="Odadan At"
                        class="p-1.5 text-orange-400 hover:bg-orange-500/20 rounded-lg transition-colors">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                        </button>
                    <button type="button" data-action="ban" title="Banla"
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

// Moderasyon: satır içi onclick yerine tek bir delege dinleyici.
// Böylece işaretlemeye hiç kullanıcı verisi gömülmüyor (escapeHtml tırnak
// kaçırmıyordu) ve sayfa 'unsafe-inline' olmadan katı bir CSP altında çalışıyor.
userListContainer.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const socketId = button.closest('[data-socket-id]')?.dataset.socketId;
    if (!socketId) return;

    if (button.dataset.action === 'kick') kickUser(socketId);
    else if (button.dataset.action === 'ban') banUser(socketId);
});

function kickUser(targetSocketId) {
    if (!isAdmin) return;
    if (!confirm('Bu kullanıcıyı odadan atmak istiyor musunuz? (Tekrar girebilir)')) return;
    socket.emit('kick-user', { targetSocketId }, (result) => {
        if (result?.error) showToast(result.error);
        else showToast('Kullanıcı odadan atıldı', 'success');
    });
}

function banUser(targetSocketId) {
    if (!isAdmin) return;
    if (!confirm('Bu kullanıcıyı BAN\'lamak istiyor musunuz? (Bu sunucu oturumunda odaya giremez)')) return;
    socket.emit('ban-user', { targetSocketId }, (result) => {
        if (result?.error) showToast(result.error);
        else showToast('Kullanıcı banlandı', 'success');
    });
}

// ==================== MEDIASOUP ====================

/**
 * Tüm mediasoup state'ini (consumer, transport, audio element, device) temizler.
 * Yeniden bağlanma (reconnect) ve yeniden init durumlarında eski/çift element
 * birikmesini önler (V4/U5).
 */
function resetMediaState() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = null; statsSampler = null;
    pendingAudioElements.clear(); consumerByProducerId.clear(); consumingProducerIds.clear();
    for (const consumer of [...consumers.values()]) closeAndRemoveConsumer(consumer);
    consumers.clear(); videoConsumer = null;
    // Producers use stopTracks:false. Captured tracks survive signaling recovery.
    for (const transport of [producerTransport, adminMicTransport, consumerTransport, viewerSendTransport]) transport?.close();
    producerTransport = adminMicTransport = consumerTransport = viewerSendTransport = null;
    producerTransportPromise = adminMicTransportPromise = consumerTransportPromise = viewerSendTransportPromise = null;
    initMediasoupPromise = screenPublishPromise = adminMicPublishPromise = null;
    videoProducer = systemAudioProducer = mixedAudioProducer = micProducer = viewerMicProducer = null;
    device = null; remoteVideo.srcObject = null;
    videoContainer.classList.remove('speaking-ring');
}

async function signal(event, payload, epoch = mediaEpoch) {
    if (!socket?.connected) throw new Error('Sunucu bağlantısı bekleniyor');
    const args = payload === undefined ? [] : [payload];
    const result = await socket.timeout(10000).emitWithAck(event, ...args);
    if (epoch !== mediaEpoch) throw new Error('Eski medya oturumu');
    return result;
}

function mediaError(err) {
    if (err.message === 'Eski medya oturumu' || !roomJoined) return;
    console.warn('Media:', err);
    showToast(err.message || 'Medya bağlantısı kurulamadı', 'warning', 6000);
    setMediaStatus('Medya bağlantısı kurulamadı. Yeniden bağlantı kurabilirsiniz.', true);
}

async function refreshIceConfig(force = false) {
    if (!force && iceConfig && Date.now() < iceConfig.expiresAt - 60000) return iceConfig;
    const epoch = mediaEpoch;
    let result = await signal('get-ice-config', undefined, epoch);
    if (result.error) throw new Error(result.error);
    // An existing Vercel TURN setup can also be used when the backend has none.
    if (!result.iceServers?.length) {
        try {
            const response = await fetch('/api/ice-config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            const fallback = response.ok ? await response.json() : null;
            if (fallback?.iceServers?.length) result = fallback;
        } catch { /* direct ICE candidates remain available */ }
    }
    if (epoch !== mediaEpoch) throw new Error('Eski medya oturumu');
    iceConfig = { iceServers: result.iceServers || [], expiresAt: result.expiresAt || Date.now() + 900000 };
    clearTimeout(iceRefreshTimer);
    const refresh = async () => {
        if (!roomJoined || epoch !== mediaEpoch) return;
        try {
            const fresh = await refreshIceConfig(true);
            await Promise.all([producerTransport, consumerTransport, adminMicTransport, viewerSendTransport]
                .filter(t => t && !t.closed).map(t => t.updateIceServers({ iceServers: fresh.iceServers })));
        } catch (err) {
            console.warn('TURN bilgileri yeniden yenilenecek:', err.message);
            if (roomJoined && epoch === mediaEpoch) iceRefreshTimer = setTimeout(refresh, 60000);
        }
    };
    iceRefreshTimer = setTimeout(refresh, Math.max(60000, iceConfig.expiresAt - Date.now() - 120000));
    return iceConfig;
}

async function initMediasoup() {
    if (initMediasoupPromise) return initMediasoupPromise;
    if (!roomJoined) throw new Error('Odaya bağlantı bekleniyor');
    if (device && consumerTransport && !consumerTransport.closed && consumerTransport.appData.epoch === mediaEpoch) return device;
    const epoch = mediaEpoch;
    const pending = (async () => {
        const capabilities = await signal('getRouterRtpCapabilities', undefined, epoch);
        if (capabilities.error) throw new Error(capabilities.error);
        const nextDevice = new Device();
        await nextDevice.load({ routerRtpCapabilities: capabilities });
        await refreshIceConfig();
        if (epoch !== mediaEpoch) throw new Error('Eski medya oturumu');
        device = nextDevice;
        const available = await signal('video-capabilities', { codecs: device.rtpCapabilities.codecs.filter(c => c.kind === 'video').map(c => c.mimeType.toLowerCase()) }, epoch);
        if (isAdmin) commonCodecs = available.codecs;
        await createRecvTransportAsync();
        if (isAdmin) await createSendTransportAsync();
        await getProducers();
        return device;
    })();
    initMediasoupPromise = pending;
    try { return await pending; }
    finally { if (initMediasoupPromise === pending) initMediasoupPromise = null; }
}

async function makeTransport(sender) {
    const epoch = mediaEpoch;
    const result = await signal('createWebRtcTransport', { sender }, epoch);
    if (result.params?.error || !result.params) throw new Error(result.params?.error || 'Transport yanıtı alınamadı');
    const options = { ...result.params, iceServers: iceConfig?.iceServers || [],
        iceTransportPolicy: urlParams.get('relay') === '1' ? 'relay' : 'all', appData: { epoch } };
    const transport = sender ? device.createSendTransport(options) : device.createRecvTransport(options);
    attachTransportHandlers(transport);
    transport.on('connect', ({ dtlsParameters }, cb, errback) => {
        signal('transport-connect', { transportId: transport.id, dtlsParameters }, epoch)
            .then(result => { if (result.error) throw new Error(result.error); cb(); }).catch(errback);
    });
    if (sender) transport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
        signal('transport-produce', { transportId: transport.id, kind, rtpParameters, appData }, epoch)
            .then(result => { if (result.error) throw new Error(result.error); cb({ id: result.id }); }).catch(errback);
    });
    return transport;
}

async function createSendTransportAsync() {
    if (producerTransport && !producerTransport.closed) return producerTransport;
    if (producerTransportPromise) return producerTransportPromise;
    const pending = makeTransport(true).then(t => (producerTransport = t));
    producerTransportPromise = pending;
    try { return await pending; } finally { if (producerTransportPromise === pending) producerTransportPromise = null; }
}

async function createRecvTransportAsync() {
    if (consumerTransport && !consumerTransport.closed) return consumerTransport;
    if (consumerTransportPromise) return consumerTransportPromise;
    const pending = makeTransport(false).then(t => (consumerTransport = t));
    consumerTransportPromise = pending;
    try { return await pending; } finally { if (consumerTransportPromise === pending) consumerTransportPromise = null; }
}

async function createAdminMicTransportAsync() {
    if (adminMicTransport && !adminMicTransport.closed) return adminMicTransport;
    if (adminMicTransportPromise) return adminMicTransportPromise;
    const pending = makeTransport(true).then(t => (adminMicTransport = t));
    adminMicTransportPromise = pending;
    try { return await pending; } finally { if (adminMicTransportPromise === pending) adminMicTransportPromise = null; }
}

async function createViewerSendTransportAsync() {
    if (viewerSendTransport && !viewerSendTransport.closed) return viewerSendTransport;
    if (viewerSendTransportPromise) return viewerSendTransportPromise;
    const pending = makeTransport(true).then(t => (viewerSendTransport = t));
    viewerSendTransportPromise = pending;
    try { return await pending; } finally { if (viewerSendTransportPromise === pending) viewerSendTransportPromise = null; }
}

function attachTransportHandlers(transport) {
    let timer;
    transport.on('connectionstatechange', state => {
        clearTimeout(timer);
        if (state === 'connected') iceRestartState.delete(transport);
        if (state === 'failed' || state === 'disconnected') timer = setTimeout(() => attemptIceRestart(transport), state === 'failed' ? 0 : 2500);
    });
    transport.observer.on('close', () => {
        clearTimeout(timer);
        if (roomJoined && socket?.connected && transport.appData.epoch === mediaEpoch) socket.emit('close-transport', { transportId: transport.id });
    });
}

async function attemptIceRestart(transport) {
    if (!roomJoined || transport.closed || transport.appData.epoch !== mediaEpoch) return;
    const state = iceRestartState.get(transport) || { inProgress: false, attempts: 0 };
    if (state.inProgress) return;
    state.inProgress = true; state.attempts++; iceRestartState.set(transport, state);
    try {
        const fresh = await refreshIceConfig(true);
        await transport.updateIceServers({ iceServers: fresh.iceServers });
        const result = await signal('restartIce', { transportId: transport.id });
        if (result.error) throw new Error(result.error);
        await transport.restartIce({ iceParameters: result.iceParameters });
        setTimeout(() => {
            if (transport.closed || !roomJoined || transport.appData.epoch !== mediaEpoch || transport.connectionState === 'connected') return;
            if (state.attempts < 2) void attemptIceRestart(transport);
            else void recoverMedia();
        }, 6000);
    } catch (err) { mediaError(err); void recoverMedia(); }
    finally { state.inProgress = false; }
}

async function recoverMedia() {
    if (mediaRecovery || !socket) return;
    mediaRecovery = (async () => {
        // A new socket session lets the server clean up all old media ownership.
        socket.disconnect(); socket.connect();
    })();
    try { await mediaRecovery; } finally { mediaRecovery = null; }
}

async function getProducers() {
    const producers = await signal('getProducers', { metadata: true });
    await Promise.all(producers.map(p => consumeProducer(typeof p === 'string' ? p : p.id, typeof p === 'string' ? null : p)));
}

async function consumeProducer(producerId, meta = null) {
    if (!roomJoined || !device || !consumerTransport || consumerTransport.closed) return;
    if (consumerByProducerId.has(producerId) || consumingProducerIds.has(producerId)) return;
    const epoch = mediaEpoch, transport = consumerTransport;
    consumingProducerIds.add(producerId);
    let consumer;
    const consumeStartedAt = performance.now();
    try {
        const { params } = await signal('consume', { transportId: transport.id, producerId, rtpCapabilities: device.rtpCapabilities }, epoch);
        if (params.error) {
            if (params.code === 'CODEC_UNSUPPORTED') { showToast(params.error, 'warning', 12000); setMediaStatus(params.error); }
            return;
        }
        const source = params.source || meta?.source || (params.kind === 'video' ? 'screen' : 'voice');
        consumer = await transport.consume({ id: params.id, producerId: params.producerId, kind: params.kind,
            rtpParameters: params.rtpParameters, appData: { source } });
        if (epoch !== mediaEpoch || transport.closed) { consumer.close(); return; }
        consumers.set(consumer.id, consumer); consumerByProducerId.set(producerId, consumer);
        attachConsumerCleanup(consumer);
        if (params.kind === 'video') {
            videoConsumer = consumer;
            streamJoinedAt = consumeStartedAt; firstFrameMs = null;
            remoteVideo.srcObject = new MediaStream([consumer.track]);
            remoteVideo.playsInline = true;
            remoteVideo.addEventListener('loadeddata', () => {
                if (videoConsumer !== consumer) return;
                firstFrameMs = Math.round(performance.now() - streamJoinedAt);
                if (!userPaused) void autoPlayVideo();
            }, { once: true });
            await setConsumerQuality(consumer, currentQuality);
            startStatsLoop(false);
        } else {
            const audioEl = document.createElement('audio');
            audioEl.id = 'audio-consumer-' + consumer.id;
            audioEl.autoplay = true; audioEl.playsInline = true; audioEl.setAttribute('playsinline', '');
            audioEl.srcObject = new MediaStream([consumer.track]);
            consumer.appData.audioEl = audioEl;
            document.body.appendChild(audioEl);
            if (mobileDuplexAudioActive) await attachConsumerToMobileAudio(consumer);
            syncAllAudioElements();
            if (!(userPaused && source === 'admin-sys-audio')) playAudioElement(audioEl);
        }
        applyPlayoutBuffer();
        const resumed = await signal('resume', { consumerId: consumer.id }, epoch);
        if (resumed?.error) throw new Error(resumed.error);
        if (params.kind === 'video') { waitingOverlay.classList.add('hidden'); pausedOverlay.classList.add('hidden'); if (!userPaused) setMediaStatus(''); }
        updateAudioUnlockButton();
    } catch (err) { if (consumer) closeAndRemoveConsumer(consumer); mediaError(err); }
    finally { if (epoch === mediaEpoch) consumingProducerIds.delete(producerId); }
}

/**
 * Bir audio elementini güvenli şekilde çalmaya çalışır.
 * Tarayıcı autoplay politikası reddederse: sessiz modda çal, sonra ilk kullanıcı
 * etkileşiminde gerçek (sesli) oynatmaya geç. (B2a düzeltmesi)
 */
function playAudioElement(el) {
    if (!el || (userPaused && el.dataset.source === 'admin-sys-audio')) return;
    el.play().then(() => { pendingAudioElements.delete(el); updateAudioUnlockButton(); })
        .catch(() => { pendingAudioElements.add(el); updateAudioUnlockButton(); });
}

/**
 * İlk kullanıcı etkileşiminde bekleyen tüm audio elementlerini sesli çalmaya geç.
 * (autoplay politikasını aşmanın resmi yöntemi)
 */
function resumePendingAudio() {
    for (const el of pendingAudioElements) {
        if (audioMutedState || (userPaused && el.dataset.source === 'admin-sys-audio')) continue;
        el.muted = el.dataset.mobileDuplexRouted === 'true';
        playAudioElement(el);
    }
}

// İlk etkileşimde (click/touch/keydown) bekleyen sesleri aç
function unlockRemoteAudioPlayback() {
    resumeMobileRemoteAudioOutput(); syncAllAudioElements(); resumePendingAudio();
    if (!userPaused && remoteVideo?.srcObject && remoteVideo.paused) void autoPlayVideo();
    updateAudioUnlockButton();
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
    const speech = Number(document.getElementById('speechVolumeSlider')?.value ?? 1);
    updateMobileRemoteAudioGain();
    for (const consumer of consumers.values()) {
        const el = consumer.appData?.audioEl;
        if (!el) continue;
        const source = consumer.appData.source;
        el.dataset.source = source;
        const level = audioLevel(source, { muted: audioMutedState, paused: userPaused, master: source === 'admin-sys-audio' ? getSelectedPlaybackVolume() : 1, speech });
        const routed = remoteAudioSources.get(consumer.id);
        el.dataset.mobileDuplexRouted = String(!!routed);
        el.muted = !!routed || level === 0; el.volume = level;
        if (routed?.gain) routed.gain.gain.setTargetAtTime(level, remoteAudioContext.currentTime, 0.015);
        if (userPaused && source === 'admin-sys-audio') el.pause();
        else if (el.paused) playAudioElement(el);
    }
    updateAudioUnlockButton();
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

function updateMobileRemoteAudioGain() {
    if (!remoteAudioContext || !remoteAudioMasterGain) return;
    const target = mobileDuplexAudioActive ? MOBILE_DUPLEX_OUTPUT_GAIN : 1;
    remoteAudioMasterGain.gain.setTargetAtTime(target, remoteAudioContext.currentTime, 0.015);
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
        const gain = context.createGain();
        gain.gain.value = 0; source.connect(gain); gain.connect(remoteAudioMasterGain);
        remoteAudioSources.set(consumer.id, { source, stream, gain });
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
        try { routed.source.disconnect(); routed.gain?.disconnect(); } catch (e) { /* already disconnected */ }
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
    markSettingsPending();
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

// Son seçilen içerik türünü hatırla: film izleyen biri her oturumda yeniden
// seçmek zorunda kalmasın.
try {
    const saved = localStorage.getItem('velo_content_type');
    if (['detail', 'motion', 'interactive'].includes(saved) && contentTypeSelect) contentTypeSelect.value = saved;
} catch (e) { /* yoksay */ }

contentTypeSelect?.addEventListener('change', () => {
    publishContentType();
    // Yayın sürerken de anında geçerli olsun: kodlayıcının neyi feda edeceğini
    // yeniden yayın açmadan değiştirebiliyoruz.
    void applyDegradationPreference();
    const track = localVideo.srcObject?.getVideoTracks?.()[0];
    if (track && track.contentHint !== undefined) track.contentHint = pickContentHint();
});

btnStartStream.addEventListener('click', () => { void startStream(); });

async function startStream() {
    if (!canUseDisplayCapture() || btnStartStream.disabled) return;
    btnStartStream.disabled = true;
    const revision = ++screenRevision;
    let stream;
    try {
        const settings = screenSettings(resSelect.value, fpsSelect.value, bitrateInput.value);
        // Capture starts within the click gesture, before signaling awaits.
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: settings.width, max: 1920 }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } },
            // Excluding this tab must not also ask Chrome to prefer this tab.
            audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
        });
        if (revision !== screenRevision) { stream.getTracks().forEach(t => t.stop()); return; }
        systemAudioWanted = true; simulcastFallback = false;
        localVideo.srcObject = stream;
        stream.getVideoTracks()[0].onended = stopStream;
        await publishScreen(stream);
        if (videoProducer) startStreamTimer();
    } catch (err) {
        if (stream && !videoProducer && err.message !== 'Eski medya oturumu' && roomJoined) { stream.getTracks().forEach(t => t.stop()); localVideo.srcObject = null; }
        showToast('Yayın başlatılamadı: ' + err.message, 'error', 8000);
    } finally { btnStartStream.disabled = false; }
}

async function publishScreen(stream) {
    if (screenPublishPromise) return screenPublishPromise;
    const epoch = mediaEpoch, revision = screenRevision;
    const pending = (async () => {
        await initMediasoup();
        const track = stream?.getVideoTracks()[0];
        if (!track || track.readyState !== 'live' || epoch !== mediaEpoch || revision !== screenRevision) return;
        const settings = screenSettings(resSelect.value, fpsSelect.value, bitrateInput.value);
        let codec = pickScreenCodec();
        if (!codec) throw new Error('Odadaki cihazlar için ortak görüntü biçimi bulunamadı');
        await track.applyConstraints({ width: { ideal: settings.width, max: 1920 }, height: { ideal: settings.height, max: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
        if (epoch !== mediaEpoch || revision !== screenRevision) return;
        for (const p of [videoProducer, systemAudioProducer, mixedAudioProducer]) {
            if (p) { socket.emit('producer-closing', { producerId: p.id }); p.close(); }
        }
        videoProducer = systemAudioProducer = mixedAudioProducer = null;
        // A fresh sender avoids reusing an inactive simulcast SDP media section.
        producerTransport?.close(); producerTransport = null; producerTransportPromise = null;
        await createSendTransportAsync();
        if (track.contentHint !== undefined) track.contentHint = pickContentHint();
        const adaptive = document.getElementById('adaptiveLayersToggle')?.checked !== false && !simulcastFallback;
        let encodings = screenEncodings(settings, codec.mimeType, adaptive);
        const produce = () => producerTransport.produce({ track, stopTracks: false, streamId: 'screen-' + roomId,
            encodings, codec, codecOptions: { videoGoogleStartBitrate: Math.min(1000, Math.round(settings.bitrateBps / 2000)) },
            appData: { source: 'screen', resolution: track.getSettings().height || settings.height } });
        let next;
        try { next = await produce(); }
        catch (err) {
            if (epoch !== mediaEpoch || revision !== screenRevision) throw new Error('Eski medya oturumu');
            const fallback = device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === 'video/vp8' && (!commonCodecs || commonCodecs.includes('video/vp8')));
            if (!fallback) throw err;
            producerTransport?.close(); producerTransport = null; producerTransportPromise = null;
            await createSendTransportAsync();
            codec = fallback; simulcastFallback = true; encodings = screenEncodings(settings, codec.mimeType, false);
            next = await produce();
            showToast('Bu cihaz için tek katmanlı uyumlu yayın kullanılıyor', 'warning', 6000);
        }
        if (epoch !== mediaEpoch || revision !== screenRevision) { if (epoch === mediaEpoch) socket.emit('producer-closing', { producerId: next.id }); next.close(); return; }
        videoProducer = next; appliedScreenSettings = settings;
        startStreamTimer();
        localVideo.srcObject = stream;
        systemAudioTrack = stream.getAudioTracks()[0] || systemAudioTrack;
        if (systemAudioWanted && systemAudioTrack?.readyState === 'live') await republishSystemAudio();
        updateAdminAudioButton(!!systemAudioProducer);
        btnStartStream.classList.add('hidden'); btnStopStream.classList.remove('hidden');
        await applyDegradationPreference(); publishContentType();
        void warnIfEncoderStalled(); startStatsLoop(true);
        await republishAdminMic();
        if (epoch !== mediaEpoch || revision !== screenRevision) return;
        document.getElementById('btnApplySettings').classList.add('hidden');
        document.getElementById('settingsStatus').textContent = 'Uygulandı · ' + settings.height + 'p / ' + settings.fps + ' FPS · ' + (encodings.length > 1 ? 'uyarlanabilir yayın' : 'tek görüntü katmanı');
        showToast('Yayın hazır', 'success');
    })();
    screenPublishPromise = pending;
    try { return await pending; } finally { if (screenPublishPromise === pending) screenPublishPromise = null; }
}

/**
 * Kodlayıcının gerçekten kare ürettiğini yayın başladıktan sonra doğrula.
 *
 * Kodlayıcı sessizce durursa yayıncı bunu KENDİ ekranından anlayamaz: önizleme
 * yerel track'i gösterir ve kusursuz görünür, "Yayını Durdur" düğmesi çıkar,
 * sunucu hata döndürmez. Yalnızca izleyiciler siyah ekran görür ve kimse
 * sebebini bilmez — bu hata tam olarak böyle uzun süre fark edilmedi. Burada
 * tek yaptığımız o sessiz durumu yayıncıya söylemek.
 */
async function warnIfEncoderStalled() {
    const producer = videoProducer, epoch = mediaEpoch;
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (epoch !== mediaEpoch || producer !== videoProducer || !producer || producer.closed) return;
    const stats = await producer.getStats().catch(() => null);
    if (!stats) return;
    const rows = [...stats.values()].filter(r => r.type === 'outbound-rtp' && r.kind === 'video');
    if (rows.some(r => r.framesEncoded > 0)) return;
    if (!simulcastFallback && producer.rtpParameters.encodings.length > 1) {
        simulcastFallback = true;
        showToast('Kodlayıcı için uyumlu yayın moduna geçiliyor', 'warning', 6000);
        await publishScreen(localVideo.srcObject).catch(mediaError);
    } else showToast('Görüntü kodlanamıyor. Daha düşük kalite veya farklı codec seçin.', 'warning', 12000);
}

btnStopStream.addEventListener('click', stopStream);

function stopStream() {
    screenRevision++; screenPublishPromise = null;
    for (const p of [videoProducer, systemAudioProducer, mixedAudioProducer]) {
        if (p) { socket?.emit('producer-closing', { producerId: p.id }); p.close(); }
    }
    videoProducer = systemAudioProducer = mixedAudioProducer = null;
    if (localVideo.srcObject) localVideo.srcObject.getTracks().forEach(t => t.stop());
    localVideo.srcObject = null;
    systemAudioTrack?.stop(); systemAudioTrack = null; appliedScreenSettings = null;
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = null;
    btnStartStream.classList.remove('hidden'); btnStopStream.classList.add('hidden');
    updateAdminAudioButton(false); stopStreamTimer();
    showToast('Yayın durduruldu', 'success');
}

/**
 * Admin mikrofon producer'ını (gerekirse) oluştur/yeniden yayınla.
 * B1 DÜZELTMESİ: Mikrofon yayın başlamadan önce açıldıysa producerTransport henüz
 * yoktu ve micProducer hiç oluşmuyordu. Bu fonksiyon, transport hazır olduktan
 * sonra (startStream sonunda veya transport gelince) eksik producer'ı kurar.
 */
async function republishAdminMic() {
    if (adminMicPublishPromise) return adminMicPublishPromise;
    const pending = republishAdminMicUnlocked(); adminMicPublishPromise = pending;
    try { return await pending; } finally { if (adminMicPublishPromise === pending) adminMicPublishPromise = null; }
}

async function republishAdminMicUnlocked() {
    if (!roomJoined || micTrack?.readyState !== 'live' || micProducer) return;
    const epoch = mediaEpoch, track = micTrack;
    const transport = await createAdminMicTransportAsync();
    const producer = await transport.produce({ track, stopTracks: false,
        codecOptions: { opusStereo: 0, opusFec: 1, opusDtx: 0, opusNack: 1, opusMaxAverageBitrate: 64000 }, appData: { source: 'admin-mic' } });
    if (epoch !== mediaEpoch || track !== micTrack || track.readyState !== 'live') { if (epoch === mediaEpoch) socket.emit('producer-closing', { producerId: producer.id }); producer.close(); return; }
    micProducer = producer;
    producer.on('transportclose', () => { if (micProducer === producer) micProducer = null; });
    producer.on('trackended', () => { if (micProducer === producer) { micProducer = null; updateAdminMicButton(false); } });
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
        return { role: 'admin', track: micTrack,
            stopTracks: false, producer: micProducer };
    }
    if (viewerMicTrack?.readyState === 'live') {
        return { role: 'viewer', track: viewerMicTrack,
            stopTracks: false, producer: viewerMicProducer };
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
    if (!roomJoined || !systemAudioWanted || systemAudioTrack?.readyState !== 'live' || systemAudioProducer) return;
    const epoch = mediaEpoch, track = systemAudioTrack;
    const transport = await createSendTransportAsync();
    const producer = await transport.produce({ track, stopTracks: false, streamId: 'screen-' + roomId,
        codecOptions: { opusStereo: 1, opusFec: 1, opusDtx: 0, opusNack: 1, opusMaxAverageBitrate: 128000 }, appData: { source: 'admin-sys-audio' } });
    if (epoch !== mediaEpoch || track !== systemAudioTrack || !systemAudioWanted || track.readyState !== 'live') { if (epoch === mediaEpoch) socket.emit('producer-closing', { producerId: producer.id }); producer.close(); return; }
    if (systemAudioProducer) { socket.emit('producer-closing', { producerId: producer.id }); producer.close(); return; }
    systemAudioProducer = producer;
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
        systemAudioWanted = false;
        // --- Sistem sesini KAPAT ---
        // U3: track'i durdurma — sadece producer'ı kapat. Böylece tekrar açarken
        // yeniden getDisplayMedia çağrılmaz (kullanıcıyı tekrar prompt etmez).
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        try { systemAudioProducer.close(); } catch(e) { /* yoksay */ }
        systemAudioProducer = null;
        updateAdminAudioButton(false);
    } else {
        systemAudioWanted = true;
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

        await republishViewerMic();

        viewerMicTrack.onended = () => closeViewerMic();
    } catch (err) {
        if (err.message === 'Eski medya oturumu' || !roomJoined) return;
        console.error('Viewer mic error:', err);
        if (viewerMicProducer) { try { viewerMicProducer.close(); } catch (e) { /* yoksay */ } viewerMicProducer = null; }
        if (viewerMicTrack) { try { viewerMicTrack.stop(); } catch (e) { /* yoksay */ } viewerMicTrack = null; }
        deactivateMobileDuplexAudioSession();
        updateViewerMicButton(false);
        showToast('Mikrofon açılamadı: ' + (err.message || 'İzin reddedildi'));
    }
}

async function republishViewerMic() {
    if (!roomJoined || !viewerMicEnabled || viewerMicTrack?.readyState !== 'live' || viewerMicProducer) return;
    const epoch = mediaEpoch, track = viewerMicTrack;
    await activateMobileDuplexAudioSession(); await initMediasoup();
    const transport = await createViewerSendTransportAsync();
    const producer = await transport.produce({ track, stopTracks: false,
        codecOptions: { opusStereo: 0, opusFec: 1, opusDtx: 0, opusNack: 1, opusMaxAverageBitrate: 64000 }, appData: { source: 'viewer-mic' } });
    if (epoch !== mediaEpoch || track !== viewerMicTrack || !viewerMicEnabled || track.readyState !== 'live' || viewerMicProducer) { if (epoch === mediaEpoch) socket.emit('producer-closing', { producerId: producer.id }); producer.close(); return; }
    viewerMicProducer = producer;
    producer.on('transportclose', () => { if (viewerMicProducer === producer) { viewerMicProducer = null; updateViewerMicButton(false); } });
    producer.on('trackended', () => { if (viewerMicProducer === producer) closeViewerMic(); });
    setupVAD(new MediaStream([track])); updateViewerMicButton(true); unlockRemoteAudioPlayback();
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

async function togglePlayback() {
    userPaused = !userPaused;
    if (userPaused) { remoteVideo.pause(); updatePlayPauseIcon(false); }
    else { if (videoConsumer) socket.emit('requestKeyFrame', { consumerId: videoConsumer.id }); await autoPlayVideo(); }
    syncAllAudioElements();
    setMediaStatus(userPaused ? 'Duraklatıldı · devam ettiğinizde canlı yayına dönersiniz. Sohbet sesleri açık kalır.' : '');
}
btnPlayPause?.addEventListener('click', () => void togglePlayback());
btnMute?.addEventListener('click', () => {
    audioMutedState = !audioMutedState;
    iconVolumeOn.classList.toggle('hidden', audioMutedState); iconVolumeOff.classList.toggle('hidden', !audioMutedState);
    btnMute.setAttribute('aria-pressed', String(audioMutedState));
    syncAllAudioElements(); if (!audioMutedState) resumePendingAudio();
});
volumeSlider?.addEventListener('input', () => {
    try { localStorage.setItem('velo_volume', volumeSlider.value); } catch { /* storage unavailable */ }
    syncAllAudioElements();
});
document.getElementById('speechVolumeSlider')?.addEventListener('input', syncAllAudioElements);
async function toggleFullscreen() {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.getElementById('playerShell').requestFullscreen) await document.getElementById('playerShell').requestFullscreen();
        else if (remoteVideo.webkitEnterFullscreen) remoteVideo.webkitEnterFullscreen();
        else { toggleCinema(); showToast('Bu tarayıcıda sinema görünümü açıldı.', 'warning'); }
    } catch { toggleCinema(); showToast('Tam ekran açılamadı; sinema görünümü kullanılabilir.', 'warning'); }
}
btnFullscreen?.addEventListener('click', () => void toggleFullscreen());

qualitySelect?.addEventListener('change', async () => {
    currentQuality = qualitySelect.value;
    if (videoConsumer) await setConsumerQuality(videoConsumer, currentQuality).catch(mediaError);
});

// ==================== INVITE ====================

btnInvite.addEventListener('click', () => {
    const url = `${window.location.origin}/room.html?roomId=${roomId}`;
    navigator.clipboard.writeText(url).then(() => showToast('Davet linki kopyalandı!', 'success'));
});

// ==================== STATS ====================

btnStats?.addEventListener('click', () => statsPanel.classList.toggle('hidden'));

function startStatsLoop(isSender) {
    if (statsInterval) clearInterval(statsInterval);
    const epoch = mediaEpoch, sampler = new RtcSampler(); statsSampler = sampler;
    let busy = false, cpuWindows = 0;
    statsInterval = setInterval(async () => {
        if (busy || epoch !== mediaEpoch) return; busy = true;
        try {
            const transports = isSender ? [producerTransport, adminMicTransport] : [consumerTransport];
            const reports = new Map();
            for (const transport of transports.filter(t => t && !t.closed)) {
                const rows = await transport.getStats();
                for (const [id, row] of rows) {
                    const copy = { ...row, id: transport.id + '/' + id };
                    for (const field of ['codecId', 'remoteId', 'localId', 'selectedCandidatePairId', 'localCandidateId', 'remoteCandidateId']) if (copy[field]) copy[field] = transport.id + '/' + copy[field];
                    reports.set(copy.id, copy);
                }
            }
            if (epoch !== mediaEpoch || statsSampler !== sampler) return;
            const m = sampler.sample(reports, isSender); lastQualityMetrics = m;
            if (!userPaused) { freezeTotal += m.freezes; freezeSecondsTotal += m.freezeSeconds; }
            const show = (id, value, unit = '') => { const el = document.getElementById(id); if (el) el.textContent = value == null ? 'Ölçülemiyor' : value + unit; };
            const rounded = value => value == null ? null : Math.round(value);
            show('statsBitrate', m.videoKbps, ' kbps'); show('statsFps', rounded(m.fps), ' FPS');
            show('statsRtt', rounded(m.rttMs), ' ms'); show('statsLoss', m.lossPct?.toFixed(1), '%');
            show('statsJitter', rounded(m.jitterMs), ' ms'); show('statsAudioBitrate', m.audioKbps, ' kbps');
            show('statsAudioLoss', m.audioLossPct?.toFixed(1), '%'); show('statsAudioJitter', rounded(m.audioJitterMs), ' ms');
            show('statsResolution', m.width ? m.width + ' × ' + m.height : null); show('statsCodec', m.codec);
            show('statsBuffer', rounded(m.bufferMs), ' ms'); show('statsBufferTarget', isSender ? null : playoutBufferMs, ' ms');
            show('statsFirstFrame', rounded(firstFrameMs), ' ms'); show('statsFreezes', isSender ? null : freezeTotal + ' / ' + freezeSecondsTotal.toFixed(1) + ' sn');
            show('statsProcessing', m.processingMs?.toFixed(1), ' ms/kare'); show('statsRoute', m.route ? m.route + (m.relayProtocol ? ' · ' + m.relayProtocol.toUpperCase() : '') : null);
            show('statsConcealed', m.concealedSamples); show('statsSelected', appliedScreenSettings ? appliedScreenSettings.height + 'p / ' + appliedScreenSettings.fps + ' FPS' : null);
            let health = 'Akış normal';
            if (m.qualityReason === 'cpu') health = 'Yayıncı kodlama yükü yüksek';
            else if (m.lossPct > 2 || m.rttMs > 300 || m.qualityReason === 'bandwidth') health = 'Ağ bağlantısı yayını sınırlıyor';
            else if (!isSender && m.processingMs > 1000 / (m.fps || 30)) health = 'Bu cihaz görüntüyü çözmekte zorlanıyor';
            else if (m.videoKbps == null) health = 'Ölçüm bekleniyor';
            show('statsHealth', health);
            connText.textContent = health === 'Akış normal' ? 'İyi' : health === 'Ölçüm bekleniyor' ? 'Bağlanıyor' : 'Sınırlı';
            connDot.className = 'w-2 h-2 rounded-full ' + (health === 'Akış normal' ? 'conn-excellent' : 'conn-good');
            if (!isSender && Date.now() - lastBufferChange > 10000) {
                const target = playoutTarget(roomContentType, m);
                if (Math.abs(target - playoutBufferMs) >= 100) { playoutBufferMs = target; lastBufferChange = Date.now(); applyPlayoutBuffer(); }
            }
            cpuWindows = m.qualityReason === 'cpu' ? cpuWindows + 1 : 0;
            if (isSender && cpuWindows >= 3 && videoProducer?.rtpParameters.encodings.length > 1 && !simulcastFallback && !screenPublishPromise) {
                simulcastFallback = true; cpuWindows = 0;
                showToast('Kodlama yükü arttı; tek görüntü katmanına geçiliyor.', 'warning');
                void publishScreen(localVideo.srcObject).catch(mediaError);
            }
        } catch (err) { console.debug('Kalite ölçümü bekliyor:', err.message); }
        finally { busy = false; }
    }, 2000);
}

// ==================== QUALITY ====================

async function setConsumerQuality(consumer, quality) {
    if (!consumer || consumer.kind !== 'video') return;
    const encodings = consumer.rtpParameters?.encodings || [];
    const limits = layerLimits(encodings);
    qualitySelect.disabled = limits.spatial === 0 && limits.temporal === 0;
    qualitySelect.title = qualitySelect.disabled ? 'Bu yayın tek kalite katmanı içeriyor' : 'Alınan kalite';
    if (qualitySelect.disabled) return;
    const result = quality === 'auto'
        ? await signal('setAutoLayers', { consumerId: consumer.id })
        : await signal('setPreferredLayers', { consumerId: consumer.id, ...preferredLayers(encodings, quality) });
    if (result?.error) throw new Error(result.error);
}

// ==================== HELPERS ====================

// Receiver buffer values are preferences; observed delay is shown separately.
let roomContentType = 'detail';
function applyPlayoutBuffer() {
    for (const consumer of consumers.values()) {
        const receiver = consumer.rtpReceiver;
        const target = consumer.kind === 'video' || consumer.appData.source === 'admin-sys-audio' ? playoutBufferMs : 80;
        try { if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = target; }
        catch (err) { console.debug('Oynatma tamponu desteklenmiyor:', err.message); }
    }
}

async function applyDegradationPreference() {
    const sender = videoProducer?.rtpSender;
    if (!sender) return;
    try {
        const params = sender.getParameters();
        params.degradationPreference = pickContentHint() === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
        await sender.setParameters(params);
    } catch (err) { console.warn('Kodlama tercihi uygulanamadı:', err.message); }
}

/** Yayıncı: içerik türünü sunucuya bildir, sunucu izleyicilere dağıtsın. */
function publishContentType() {
    const value = ['motion', 'interactive'].includes(contentTypeSelect?.value) ? contentTypeSelect.value : 'detail';
    roomContentType = value; playoutBufferMs = playoutTarget(value);
    try { localStorage.setItem('velo_content_type', value); } catch { /* storage unavailable */ }
    if (socket?.connected && roomJoined) socket.emit('set-content-type', { contentType: value });
}

// Prefer VP8, subject to the codecs supported by connected viewers.
const CODEC_ORDER = {
    vp8:  ['video/vp8',  'video/h264', 'video/av1',  'video/vp9'],
    av1:  ['video/av1',  'video/vp8',  'video/h264', 'video/vp9'],
    h264: ['video/h264', 'video/vp8',  'video/av1',  'video/vp9'],
    vp9:  ['video/vp9',  'video/vp8',  'video/h264', 'video/av1']
};

/** Kullanıcının seçtiği codec'i, cihazın gerçekten desteklediğiyle kesiştir. */
function pickScreenCodec() {
    const codecs = device?.rtpCapabilities?.codecs || [];
    const wanted = CODEC_ORDER[codecSelect?.value] || CODEC_ORDER.vp8;
    for (const mime of wanted) {
        if (commonCodecs && !commonCodecs.includes(mime)) continue;
        const codec = codecs.find(c => c.mimeType?.toLowerCase() === mime);
        if (codec) return codec;
    }
    return null;
}

/** Seçilen içerik türü: netlik mi (metin) akıcılık mı (video) korunsun. */
function pickContentHint() { return contentTypeSelect?.value === 'detail' ? 'detail' : 'motion'; }

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
    if (userPaused || !remoteVideo.srcObject) return;
    remoteVideo.muted = true;
    try { await remoteVideo.play(); if (userPaused) remoteVideo.pause(); else updatePlayPauseIcon(true); }
    catch { updatePlayPauseIcon(false); setMediaStatus('Görüntüyü başlatmak için oynat düğmesine dokunun.'); }
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

    // Yönetici bağlantısı paylaşılmış ya da sekmede sır yoksa: lobiye geri
    // atmak yerine izleyici olarak devam et. Yetki zaten token'a bağlı,
    // dolayısıyla bu yalnızca bir bilgilendirme.
    if (wantsAdmin && !isAdminMode) {
        showToast('Bu sekmede odanın yönetici oturumu yok — izleyici olarak katılıyorsunuz', 'warning', 5000);
    }

    initMicNoiseSuppressionControls();
    const nickname = await showNicknameModal();
    await initSocket(nickname);
})();

// ==================== EXPERIENCE CONTROLS ====================
function setMediaStatus(message, retry = false) {
    const el = document.getElementById('mediaStatus');
    el.textContent = message; el.classList.toggle('hidden', !message);
    document.getElementById('btnRetryMedia').classList.toggle('hidden', !retry);
}
function updateAudioUnlockButton() {
    const needsGesture = !audioMutedState && ([...pendingAudioElements].some(el => !(userPaused && el.dataset.source === 'admin-sys-audio')) || (mobileDuplexAudioActive && remoteAudioContext?.state === 'suspended'));
    document.getElementById('btnUnlockAudio')?.classList.toggle('hidden', !needsGesture);
}
function markSettingsPending() {
    document.getElementById('settingsStatus').textContent = videoProducer ? 'Değişiklikler henüz uygulanmadı.' : 'Seçilen ayarlar yayını başlatınca uygulanır.';
    document.getElementById('btnApplySettings').classList.toggle('hidden', !videoProducer);
}
function toggleCinema() {
    const active = document.body.classList.toggle('cinema-mode');
    const button = document.getElementById('btnCinema');
    button.setAttribute('aria-pressed', String(active)); button.textContent = active ? 'Sohbeti göster' : 'Sinema';
}
document.getElementById('btnCinema').addEventListener('click', toggleCinema);
document.getElementById('btnUnlockAudio').addEventListener('click', unlockRemoteAudioPlayback);
document.getElementById('btnRetryMedia').addEventListener('click', () => void recoverMedia());
for (const el of [resSelect, fpsSelect, bitrateInput, codecSelect, document.getElementById('adaptiveLayersToggle')]) el.addEventListener('change', markSettingsPending);
document.getElementById('btnApplySettings').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { screenSettings(resSelect.value, fpsSelect.value, bitrateInput.value); simulcastFallback = false; await publishScreen(localVideo.srcObject); button.classList.add('hidden'); }
    catch (err) { mediaError(err); }
    finally { button.disabled = false; }
});
const pipButton = document.getElementById('btnPip');
pipButton.classList.toggle('hidden', !document.pictureInPictureEnabled);
pipButton.addEventListener('click', async () => {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await remoteVideo.requestPictureInPicture(); }
    catch { showToast('Küçük pencere için oynayan bir yayın gerekli.', 'warning'); }
});
let wakeLock = null;
const awakeToggle = document.getElementById('keepAwakeToggle');
awakeToggle.disabled = !navigator.wakeLock;
if (awakeToggle.disabled) awakeToggle.parentElement.title = 'Bu tarayıcı desteklemiyor';
async function syncWakeLock() {
    if (!awakeToggle.checked || document.visibilityState !== 'visible') { await wakeLock?.release().catch(() => {}); wakeLock = null; return; }
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { awakeToggle.checked = false; showToast('Ekranı açık tutma etkinleştirilemedi.', 'warning'); }
}
awakeToggle.addEventListener('change', () => void syncWakeLock());
document.addEventListener('visibilitychange', () => void syncWakeLock());
document.addEventListener('keydown', event => {
    if (isAdmin || event.repeat || event.altKey || event.ctrlKey || event.metaKey || !canUseShortcut(event.target)) return;
    if ([...document.querySelectorAll('[role="dialog"]')].some(el => !el.classList.contains('hidden'))) return;
    if (event.code === 'Space') { event.preventDefault(); void togglePlayback(); }
    if (event.code === 'KeyM') btnMute.click();
    if (event.code === 'KeyF') void toggleFullscreen();
    if (event.code === 'Escape' && !document.fullscreenElement && document.body.classList.contains('cinema-mode')) toggleCinema();
});
let controlsTimer;
const playerShell = document.getElementById('playerShell');
function revealControls() {
    playerShell.classList.remove('controls-idle'); clearTimeout(controlsTimer);
    if (document.fullscreenElement && !userPaused) controlsTimer = setTimeout(() => playerShell.classList.add('controls-idle'), 4000);
}
for (const event of ['pointermove', 'pointerdown', 'focusin', 'keydown']) playerShell.addEventListener(event, revealControls);
document.addEventListener('fullscreenchange', revealControls);
document.getElementById('btnExportStats').addEventListener('click', () => {
    const summary = { capturedAt: new Date().toISOString(), role: isAdmin ? 'publisher' : 'viewer', firstFrameMs, freezeTotal, freezeSecondsTotal, bufferTargetMs: playoutBufferMs, selected: appliedScreenSettings, measured: lastQualityMetrics };
    const url = URL.createObjectURL(new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'velostream-kalite.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
