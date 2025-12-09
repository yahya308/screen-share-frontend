/**
 * Room - Admin/Viewer streaming logic
 */

import { Device } from 'mediasoup-client';

const socket = io('https://yahya-oracle.duckdns.org');

// Get room ID from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
const isAdminMode = urlParams.get('admin') === 'true';

if (!roomId) {
    window.location.href = 'index.html';
}

// DOM Elements
const roomName = document.getElementById('roomName');
const userCount = document.getElementById('userCount');
const btnInvite = document.getElementById('btnInvite');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const pausedOverlay = document.getElementById('pausedOverlay');
const waitingOverlay = document.getElementById('waitingOverlay');
const videoContainer = document.getElementById('videoContainer');

// Admin elements
const adminPanel = document.getElementById('adminPanel');
const viewerInfo = document.getElementById('viewerInfo');
const viewerControls = document.getElementById('viewerControls');
const btnStartStream = document.getElementById('btnStartStream');
const btnStopStream = document.getElementById('btnStopStream');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleAudio = document.getElementById('btnToggleAudio');
const btnCloseRoom = document.getElementById('btnCloseRoom');
const btnUpdateMaxUsers = document.getElementById('btnUpdateMaxUsers');
const maxUsersInput = document.getElementById('maxUsersInput');

const resSelect = document.getElementById('resSelect');
const fpsSelect = document.getElementById('fpsSelect');
const bitrateInput = document.getElementById('bitrateInput');

// Viewer controls
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnMute = document.getElementById('btnMute');
const iconVolumeOn = document.getElementById('iconVolumeOn');
const iconVolumeOff = document.getElementById('iconVolumeOff');
const volumeSlider = document.getElementById('volumeSlider');
const qualitySelect = document.getElementById('qualitySelect');
const btnFullscreen = document.getElementById('btnFullscreen');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');

const leaveModal = document.getElementById('leaveModal');
const btnCancelLeave = document.getElementById('btnCancelLeave');
const btnConfirmLeave = document.getElementById('btnConfirmLeave');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// State
let device;
let producerTransport;
let consumerTransport;
let videoProducer;
let micProducer;
let systemAudioProducer;
const consumers = new Map();
let isAdmin = false;
let currentQuality = 'auto';
let videoConsumer = null;

// ==================== INIT ====================

socket.on('connect', () => {
    console.log('Connected to server');

    if (isAdminMode) {
        // Admin rejoining after redirect from lobby
        socket.emit('admin-rejoin', { roomId }, (result) => {
            if (result.error) {
                showToast(result.error);
                setTimeout(() => window.location.href = 'index.html', 2000);
                return;
            }

            roomName.textContent = result.roomName;
            userCount.textContent = result.userCount || 1;
            maxUsersInput.value = result.maxUsers || 100;

            isAdmin = true;
            setupAdminUI();
            initMediasoup();
        });
    } else {
        // Try to get stored password from lobby
        const storedPassword = sessionStorage.getItem(`room_password_${roomId}`);

        // Join room as viewer
        attemptJoinRoom(storedPassword);
    }
});

function attemptJoinRoom(password) {
    socket.emit('join-room', { roomId, password }, (result) => {
        if (result.error) {
            if (result.needPassword) {
                // Show password modal
                showPasswordModal();
            } else if (result.blocked) {
                showToast(`${result.error}`);
                setTimeout(() => window.location.href = 'index.html', 3000);
            } else {
                showToast(result.error);
                setTimeout(() => window.location.href = 'index.html', 2000);
            }
            return;
        }

        // Success - clear stored password
        sessionStorage.removeItem(`room_password_${roomId}`);

        roomName.textContent = result.roomName;
        userCount.textContent = result.userCount || 1;
        maxUsersInput.value = result.maxUsers || 100;

        isAdmin = false;
        setupViewerUI();

        if (result.isStreaming) {
            initMediasoup();
        }
    });
}

function showPasswordModal() {
    const modal = document.getElementById('passwordModal');
    const input = document.getElementById('passwordInput');
    const btnSubmit = document.getElementById('btnSubmitPassword');
    const btnCancel = document.getElementById('btnCancelPassword');
    const errorEl = document.getElementById('passwordModalError');

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    input.value = '';
    input.focus();
    errorEl.classList.add('hidden');

    const handleSubmit = () => {
        const password = input.value;
        if (!password) {
            errorEl.textContent = 'Şifre girin';
            errorEl.classList.remove('hidden');
            return;
        }

        socket.emit('join-room', { roomId, password }, (result) => {
            if (result.error) {
                if (result.needPassword) {
                    errorEl.textContent = `Yanlış şifre (${result.remainingAttempts} deneme kaldı)`;
                    errorEl.classList.remove('hidden');
                } else if (result.blocked) {
                    modal.classList.add('hidden');
                    showToast(`${result.error}`);
                    setTimeout(() => window.location.href = 'index.html', 3000);
                } else {
                    errorEl.textContent = result.error;
                    errorEl.classList.remove('hidden');
                }
                return;
            }

            // Success
            modal.classList.add('hidden');
            roomName.textContent = result.roomName;
            userCount.textContent = result.userCount || 1;
            maxUsersInput.value = result.maxUsers || 100;
            isAdmin = false;
            setupViewerUI();
            if (result.isStreaming) {
                initMediasoup();
            }
        });
    };

    btnSubmit.onclick = handleSubmit;
    input.onkeypress = (e) => { if (e.key === 'Enter') handleSubmit(); };
    btnCancel.onclick = () => {
        modal.classList.add('hidden');
        window.location.href = 'index.html';
    };
}

function setupAdminUI() {
    adminPanel.classList.remove('hidden');
    viewerInfo.classList.add('hidden');
    localVideo.classList.remove('hidden');
    remoteVideo.classList.add('hidden');
    waitingOverlay.classList.add('hidden');

    // Warn before closing tab
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

// ==================== MEDIASOUP ====================

async function initMediasoup() {
    socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
        if (rtpCapabilities.error) {
            showToast(rtpCapabilities.error);
            return;
        }

        device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });

        if (isAdmin) {
            createSendTransport();
        } else {
            createRecvTransport();
        }
    });
}

function createSendTransport() {
    socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
        if (params.error) {
            console.error(params.error);
            return;
        }

        producerTransport = device.createSendTransport(params);

        producerTransport.on('connect', ({ dtlsParameters }, callback) => {
            socket.emit('transport-connect', { transportId: producerTransport.id, dtlsParameters });
            callback();
        });

        producerTransport.on('produce', ({ kind, rtpParameters, appData }, callback) => {
            socket.emit('transport-produce', {
                transportId: producerTransport.id,
                kind,
                rtpParameters,
                appData
            }, ({ id, error }) => {
                if (error) console.error(error);
                callback({ id });
            });
        });
    });
}

function createRecvTransport() {
    socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
        if (params.error) {
            console.error(params.error);
            return;
        }

        consumerTransport = device.createRecvTransport(params);

        consumerTransport.on('connect', ({ dtlsParameters }, callback) => {
            socket.emit('transport-connect', { transportId: consumerTransport.id, dtlsParameters });
            callback();
        });

        // Transport ready, now get producers
        getProducers();
    });
}

function getProducers() {
    socket.emit('getProducers', (producerIds) => {
        if (producerIds.length === 0) {
            // No stream yet
            return;
        }
        producerIds.forEach(id => consumeProducer(id));
    });
}

async function consumeProducer(producerId) {
    if (!consumerTransport) return;

    socket.emit('consume', {
        transportId: consumerTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities
    }, async ({ params }) => {
        if (params.error) {
            console.error(params.error);
            return;
        }

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        });

        consumers.set(consumer.id, consumer);

        console.log(`📺 Consumed ${params.kind} track`);

        // Save video consumer for quality control
        if (params.kind === 'video') {
            videoConsumer = consumer;
            // ALWAYS force HIGH quality immediately to override BWE throttling
            // This ensures best quality from the start
            setTimeout(() => {
                setConsumerQuality(consumer, currentQuality === 'auto' ? 'high' : currentQuality);
            }, 500); // Small delay to ensure consumer is fully set up

            // ⭐ Jitter Buffer Target - Lower latency (100ms instead of ~150ms default)
            try {
                const receivers = consumerTransport.handler._pc.getReceivers();
                const videoReceiver = receivers.find(r => r.track?.kind === 'video');
                if (videoReceiver && 'jitterBufferTarget' in videoReceiver) {
                    videoReceiver.jitterBufferTarget = 100; // 100ms target
                    console.log('📉 Jitter buffer target set to 100ms');
                }
            } catch (e) {
                console.log('Jitter buffer optimization not available');
            }

            // ⭐ Periodic keyframe request every 10 seconds (prevent stale decoder)
            setInterval(() => {
                if (videoConsumer && !videoConsumer.closed) {
                    socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
                }
            }, 10000);
        }

        if (remoteVideo.srcObject) {
            remoteVideo.srcObject.addTrack(consumer.track);
        } else {
            remoteVideo.srcObject = new MediaStream([consumer.track]);
        }

        // ⭐ Video element optimizations for smoother playback
        remoteVideo.playsInline = true;
        remoteVideo.disablePictureInPicture = true;

        // Low latency mode hint (if supported)
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            console.log('📺 Low-latency video callback supported');
        }

        // ⭐ Freeze detection and auto-recovery
        remoteVideo.addEventListener('stalled', () => {
            console.warn('⚠️ Video stalled - requesting keyframe');
            if (videoConsumer) {
                socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
            }
        });

        remoteVideo.addEventListener('waiting', () => {
            console.warn('⚠️ Video waiting for data');
        });

        // Hide waiting overlay
        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');

        // Resume consumer with the consumer ID
        socket.emit('resume', { consumerId: consumer.id });

        // ⭐ Auto-play with retry and proper icon state
        autoPlayVideo();
    });
}

// ⭐ Robust auto-play function
async function autoPlayVideo() {
    try {
        await remoteVideo.play();
        updatePlayPauseIcon(true); // Playing
        console.log('▶️ Video playing');
    } catch (e) {
        console.warn('⚠️ Auto-play blocked, trying muted:', e.message);
        // Browser may block autoplay with sound
        remoteVideo.muted = true;
        try {
            await remoteVideo.play();
            updatePlayPauseIcon(true);
            showToast('Ses kapatılarak başlatıldı. Sesi manuel açın.', 'warning');
        } catch (e2) {
            console.error('❌ Play failed:', e2.message);
            updatePlayPauseIcon(false);
        }
    }
}

// ⭐ Update play/pause icon
function updatePlayPauseIcon(isPlaying) {
    if (iconPlay && iconPause) {
        iconPlay.classList.toggle('hidden', isPlaying);
        iconPause.classList.toggle('hidden', !isPlaying);
    }
}

// ==================== ADMIN CONTROLS ====================

btnStartStream.addEventListener('click', async () => {
    if (!producerTransport) {
        await initMediasoup();
        // Wait for transport to be ready
        setTimeout(startStream, 500);
    } else {
        startStream();
    }
});

async function startStream() {
    const height = parseInt(resSelect.value);
    const fps = parseInt(fpsSelect.value);
    const bitrate = parseInt(bitrateInput.value) * 1000;

    try {
        // Calculate width for 16:9 aspect ratio
        const width = Math.round(height * (16 / 9));

        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: width, max: 1920 },
                height: { ideal: height, max: 1080 },
                frameRate: { ideal: fps, max: 60 }
            },
            audio: true
        });

        localVideo.srcObject = stream;

        const videoTrack = stream.getVideoTracks()[0];

        // Get actual captured resolution
        const settings = videoTrack.getSettings();
        const actualHeight = settings.height || height;
        const actualFps = settings.frameRate || fps;
        console.log(`🎥 Captured: ${settings.width}x${actualHeight} @ ${actualFps}fps`);

        // Content hint: 'motion' for video/games, 'detail' for general screen
        // 'motion' prioritizes smooth playback over sharpness
        if (videoTrack.contentHint !== undefined) {
            videoTrack.contentHint = 'motion';
        }

        // VP9 SVC Mode - L1T3 for smooth gaming/video
        // L1T3 = 1 spatial layer (full res), 3 temporal layers (fps priority)
        // This ensures consistent resolution without quality drops
        const encodings = [{
            maxBitrate: bitrate,
            maxFramerate: actualFps,
            scalabilityMode: 'L1T3'  // VP9 SVC: Full resolution + 3 temporal layers
        }];

        videoProducer = await producerTransport.produce({
            track: videoTrack,
            encodings,
            codecOptions: {
                // High start bitrate for immediate quality
                videoGoogleStartBitrate: Math.floor(bitrate * 0.8),
                videoGoogleMaxBitrate: bitrate,
                // High minimum to prevent quality drops
                videoGoogleMinBitrate: Math.floor(bitrate / 2)
            },
            appData: {
                source: 'screen',
                resolution: actualHeight
            }
        });

        console.log(`📡 VP9 SVC mode: ${actualHeight}p @ ${actualFps}fps, ${bitrate / 1000}kbps (L1T3)`);

        videoTrack.onended = stopStream;

        // System audio
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            systemAudioProducer = await producerTransport.produce({ track: audioTrack });
            btnToggleAudio.textContent = '🔊 Sistem Sesi (Açık)';
        }

        btnStartStream.classList.add('hidden');
        btnStopStream.classList.remove('hidden');
        showToast('Yayın başladı', 'success');

    } catch (err) {
        console.error('Stream error:', err);
        showToast('Yayın başlatılamadı: ' + err.message);
    }
}

function generateSimulcastEncodings(sourceHeight, maxBitrate, fps = 30) {
    // Simulcast layers based on source resolution
    const layers = [];

    // High layer (source quality)
    layers.push({
        rid: 'h',
        maxBitrate: maxBitrate,
        scalabilityMode: 'L1T3',
        scaleResolutionDownBy: 1.0,
        maxFramerate: fps  // ⭐ FPS limit for bandwidth control
    });

    // Mid layer (proportional to source)
    if (sourceHeight >= 720) {
        const midScale = sourceHeight / 720;
        layers.push({
            rid: 'm',
            maxBitrate: Math.floor(maxBitrate * 0.4),  // 0.5 → 0.4 for better efficiency
            scalabilityMode: 'L1T3',
            scaleResolutionDownBy: midScale,
            maxFramerate: Math.min(fps, 30)  // ⭐ Cap at 30fps for mid
        });
    }

    // Low layer (proportional to source)
    if (sourceHeight >= 480) {
        const lowScale = sourceHeight / 480;
        layers.push({
            rid: 'l',
            maxBitrate: Math.floor(maxBitrate * 0.15),  // 0.25 → 0.15 for bandwidth saving
            scalabilityMode: 'L1T2',  // ⭐ 2 temporal layers sufficient for low quality
            scaleResolutionDownBy: lowScale,
            maxFramerate: 15  // ⭐ Low FPS for low quality layer
        });
    }

    return layers;
}

btnStopStream.addEventListener('click', stopStream);

function stopStream() {
    if (videoProducer) {
        socket.emit('producer-closing', { producerId: videoProducer.id });
        videoProducer.close();
        videoProducer = null;
    }
    if (systemAudioProducer) {
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        systemAudioProducer.close();
        systemAudioProducer = null;
        btnToggleAudio.textContent = '🔊 Sistem Sesi (Kapalı)';
    }
    if (micProducer) {
        socket.emit('producer-closing', { producerId: micProducer.id });
        micProducer.close();
        micProducer = null;
        btnToggleMic.textContent = '🎤 Mikrofon (Kapalı)';
    }

    if (localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(t => t.stop());
        localVideo.srcObject = null;
    }

    btnStartStream.classList.remove('hidden');
    btnStopStream.classList.add('hidden');
    showToast('Yayın durduruldu');
}

btnToggleMic.addEventListener('click', async () => {
    if (micProducer) {
        socket.emit('producer-closing', { producerId: micProducer.id });
        micProducer.close();
        micProducer = null;
        btnToggleMic.textContent = '🎤 Mikrofon (Kapalı)';
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const track = stream.getAudioTracks()[0];
            micProducer = await producerTransport.produce({ track });
            btnToggleMic.textContent = '🎤 Mikrofon (Açık)';
        } catch (err) {
            showToast('Mikrofon erişimi başarısız');
        }
    }
});

btnToggleAudio.addEventListener('click', async () => {
    if (systemAudioProducer) {
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        systemAudioProducer.close();
        systemAudioProducer = null;
        btnToggleAudio.textContent = '🔊 Sistem Sesi (Kapalı)';
    } else {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            stream.getVideoTracks().forEach(t => t.stop());
            const track = stream.getAudioTracks()[0];
            if (track) {
                systemAudioProducer = await producerTransport.produce({ track });
                btnToggleAudio.textContent = '🔊 Sistem Sesi (Açık)';
            }
        } catch (err) {
            console.error(err);
        }
    }
});

btnCloseRoom.addEventListener('click', () => {
    if (confirm('Odayı kapatmak istediğinize emin misiniz?')) {
        socket.emit('close-room');
    }
});

btnUpdateMaxUsers.addEventListener('click', () => {
    socket.emit('update-max-users', { maxUsers: parseInt(maxUsersInput.value) }, (result) => {
        if (result.success) {
            showToast('Limit güncellendi', 'success');
        }
    });
});

// ==================== VIEWER CONTROLS ====================

btnPlayPause?.addEventListener('click', async () => {
    if (remoteVideo.paused) {
        // ⭐ Request keyframe before resuming to prevent black screen
        if (videoConsumer) {
            socket.emit('requestKeyFrame', { consumerId: videoConsumer.id });
        }

        try {
            await remoteVideo.play();
            updatePlayPauseIcon(true);
            console.log('▶️ Video resumed');
        } catch (e) {
            console.error('Resume failed:', e);
            // Try again with muted
            remoteVideo.muted = true;
            await remoteVideo.play();
            updatePlayPauseIcon(true);
        }
    } else {
        remoteVideo.pause();
        updatePlayPauseIcon(false);
        console.log('⏸️ Video paused');
    }
});

btnMute?.addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    iconVolumeOn.classList.toggle('hidden', remoteVideo.muted);
    iconVolumeOff.classList.toggle('hidden', !remoteVideo.muted);
});

volumeSlider?.addEventListener('input', (e) => {
    remoteVideo.volume = e.target.value;
});

btnFullscreen?.addEventListener('click', () => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        videoContainer.requestFullscreen();
    }
});

// ==================== INVITE ====================

btnInvite.addEventListener('click', () => {
    const url = `${window.location.origin}/room.html?roomId=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Davet linki kopyalandı', 'success');
    });
});

// ==================== SOCKET EVENTS ====================

socket.on('user-joined', ({ userCount: count }) => {
    userCount.textContent = count;
});

socket.on('user-left', ({ userCount: count }) => {
    userCount.textContent = count;
});

socket.on('new-producer', (producerId) => {
    consumeProducer(producerId);
});

socket.on('stream-started', () => {
    waitingOverlay.classList.add('hidden');
    pausedOverlay.classList.add('hidden');
    if (!device) {
        initMediasoup();
    } else {
        getProducers();
    }
});

socket.on('stream-paused', () => {
    pausedOverlay.classList.remove('hidden');
});

socket.on('producer-closed', ({ remoteProducerId }) => {
    for (const [id, consumer] of consumers) {
        if (consumer.producerId === remoteProducerId) {
            consumer.close();
            consumers.delete(id);
            if (remoteVideo.srcObject) {
                remoteVideo.srcObject.removeTrack(consumer.track);
            }
        }
    }
});

// Real-time user count updates
socket.on('user-joined', ({ userCount: count }) => {
    userCount.textContent = count;
});

socket.on('user-left', ({ userCount: count }) => {
    userCount.textContent = count;
});

socket.on('room-closed', ({ reason }) => {
    showToast(reason);
    setTimeout(() => window.location.href = 'index.html', 2000);
});

// ==================== QUALITY SELECTOR ====================

if (qualitySelect) {
    qualitySelect.addEventListener('change', async () => {
        currentQuality = qualitySelect.value;
        if (videoConsumer) {
            await setConsumerQuality(videoConsumer, currentQuality);
        }
    });
}

async function setConsumerQuality(consumer, quality) {
    if (!consumer || consumer.kind !== 'video') return;

    // ⭐ L1T3 SVC Mode: 1 spatial layer (always 0), 3 temporal layers
    // spatialLayer: always 0 (single resolution)
    // temporalLayer: 0=15fps, 1=30fps, 2=60fps
    let spatialLayer = 0;
    let temporalLayer;

    switch (quality) {
        case 'high':
            temporalLayer = 2; // 60fps
            break;
        case 'mid':
            temporalLayer = 1; // 30fps
            break;
        case 'low':
            temporalLayer = 0; // 15fps
            break;
        case 'auto':
        default:
            temporalLayer = 2; // Default to max
            break;
    }

    // Send to server
    socket.emit('setPreferredLayers', {
        consumerId: consumer.id,
        spatialLayer,
        temporalLayer
    }, (response) => {
        if (response?.error) {
            console.error('Failed to set quality:', response.error);
        } else {
            const fpsLabels = ['15fps', '30fps', '60fps'];
            console.log(`🎬 Quality set to: ${quality} (${fpsLabels[temporalLayer]})`);
        }
    });
}

// ==================== VIEWER LEAVE ====================

if (btnLeaveRoom) {
    btnLeaveRoom.addEventListener('click', () => {
        leaveModal.classList.remove('hidden');
        leaveModal.classList.add('flex');
    });
}

if (btnCancelLeave) {
    btnCancelLeave.addEventListener('click', () => {
        leaveModal.classList.add('hidden');
        leaveModal.classList.remove('flex');
    });
}

if (btnConfirmLeave) {
    btnConfirmLeave.addEventListener('click', () => {
        window.location.href = 'index.html';
    });
}

// ==================== HELPERS ====================

function showToast(message, type = 'error') {
    toastMessage.textContent = message;
    toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg ${type === 'success' ? 'bg-green-600' : 'bg-red-500'
        } text-white`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}
