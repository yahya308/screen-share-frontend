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
const btnFullscreen = document.getElementById('btnFullscreen');

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

        if (remoteVideo.srcObject) {
            remoteVideo.srcObject.addTrack(consumer.track);
        } else {
            remoteVideo.srcObject = new MediaStream([consumer.track]);
        }

        // Hide waiting overlay
        waitingOverlay.classList.add('hidden');
        pausedOverlay.classList.add('hidden');

        socket.emit('resume');

        remoteVideo.play().catch(e => console.error('Play error:', e));
    });
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
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { height: { ideal: height }, frameRate: { ideal: fps } },
            audio: true
        });

        localVideo.srcObject = stream;

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack.contentHint !== undefined) {
            videoTrack.contentHint = 'detail';
        }

        videoProducer = await producerTransport.produce({
            track: videoTrack,
            encodings: [{ maxBitrate: bitrate, networkPriority: 'high', priority: 'high' }],
            codecOptions: { videoGoogleStartBitrate: bitrate / 2 }
        });

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

btnPlayPause?.addEventListener('click', () => {
    if (remoteVideo.paused) {
        remoteVideo.play();
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
    } else {
        remoteVideo.pause();
        iconPlay.classList.remove('hidden');
        iconPause.classList.add('hidden');
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

socket.on('room-closed', ({ reason }) => {
    showToast(reason);
    setTimeout(() => window.location.href = 'index.html', 2000);
});

// ==================== HELPERS ====================

function showToast(message, type = 'error') {
    toastMessage.textContent = message;
    toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg ${type === 'success' ? 'bg-green-600' : 'bg-red-500'
        } text-white`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}
