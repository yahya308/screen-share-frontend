import { Device } from "mediasoup-client";

const socket = io("https://yahya-oracle.duckdns.org"); // Connect to Oracle Cloud Backend
const btnConsume = document.getElementById('btnConsume');
const status = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');

// Video Controls Elements
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnMute = document.getElementById('btnMute');
const iconVolumeOn = document.getElementById('iconVolumeOn');
const iconVolumeOff = document.getElementById('iconVolumeOff');
const volumeSlider = document.getElementById('volumeSlider');
const btnQuality = document.getElementById('btnQuality');
const qualityDropdown = document.getElementById('qualityDropdown');
const qualityOptions = document.getElementById('qualityOptions');
const currentQuality = document.getElementById('currentQuality');
const btnFullscreen = document.getElementById('btnFullscreen');
const iconFullscreenEnter = document.getElementById('iconFullscreenEnter');
const iconFullscreenExit = document.getElementById('iconFullscreenExit');
const videoContainer = document.getElementById('videoContainer');

// Viewer Count Logic
const updateViewerCountUI = (count) => {
    const el = document.getElementById('viewer-count-display');
    const targetEl = el || document.getElementById('viewerCount');
    if (targetEl) {
        targetEl.innerText = count;
        console.log("✅ UI Updated with count:", count);
    }
};

let device;
let consumerTransport;
const consumers = new Map();
let videoConsumerId = null; // Track video consumer for layer switching
let broadcasterSettings = null;
let selectedQuality = 'auto';

btnConsume.addEventListener('click', joinStream);

// Viewer Count: Request current count on socket connect
socket.on('connect', () => {
    console.log('Socket connected, requesting viewer count');
    socket.emit('get-viewer-count');
    socket.emit('get-stream-info', (settings) => {
        if (settings) {
            broadcasterSettings = settings;
            setupQualityOptions(settings);
        }
    });
});

// Listen for stream info from broadcaster
socket.on('stream-info', (settings) => {
    console.log('📺 Stream info received:', settings);
    broadcasterSettings = settings;
    setupQualityOptions(settings);
});

socket.on('viewer-count-update', (count) => updateViewerCountUI(count));
socket.on('viewer-count-response', (count) => updateViewerCountUI(count));

// ==================== VIDEO CONTROLS ====================

// Play/Pause
btnPlayPause.addEventListener('click', () => {
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

remoteVideo.addEventListener('play', () => {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
});

remoteVideo.addEventListener('pause', () => {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
});

// Volume
btnMute.addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    updateVolumeUI();
});

volumeSlider.addEventListener('input', (e) => {
    remoteVideo.volume = e.target.value;
    remoteVideo.muted = remoteVideo.volume === 0;
    updateVolumeUI();
});

function updateVolumeUI() {
    if (remoteVideo.muted || remoteVideo.volume === 0) {
        iconVolumeOn.classList.add('hidden');
        iconVolumeOff.classList.remove('hidden');
    } else {
        iconVolumeOn.classList.remove('hidden');
        iconVolumeOff.classList.add('hidden');
    }
    volumeSlider.value = remoteVideo.muted ? 0 : remoteVideo.volume;
}

// Fullscreen
btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        videoContainer.requestFullscreen();
    }
});

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        iconFullscreenEnter.classList.add('hidden');
        iconFullscreenExit.classList.remove('hidden');
    } else {
        iconFullscreenEnter.classList.remove('hidden');
        iconFullscreenExit.classList.add('hidden');
    }
});

// ==================== QUALITY SELECTOR ====================

// Toggle quality dropdown
btnQuality.addEventListener('click', (e) => {
    e.stopPropagation();
    qualityDropdown.classList.toggle('hidden');
});

// Close dropdown when clicking outside
document.addEventListener('click', () => {
    qualityDropdown.classList.add('hidden');
});

qualityDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
});

function setupQualityOptions(settings) {
    if (!settings) return;

    const sourceHeight = settings.resolution;
    const layerCount = settings.layerCount || 4;

    // Define quality levels
    const qualityLevels = [
        { height: 1080, label: '1080p' },
        { height: 720, label: '720p' },
        { height: 480, label: '480p' },
        { height: 360, label: '360p' },
        { height: 240, label: '240p' },
        { height: 144, label: '144p' }
    ];

    // Filter available levels based on source resolution
    const availableLevels = qualityLevels.filter(q => q.height <= sourceHeight);
    const selectedLevels = availableLevels.slice(0, layerCount);

    // Clear existing options
    qualityOptions.innerHTML = '';

    // Add quality options (highest to lowest for UI)
    selectedLevels.forEach((level, index) => {
        // Calculate layer index (reverse since broadcasters send in reverse order)
        const spatialLayer = selectedLevels.length - 1 - index;

        const btn = document.createElement('button');
        btn.className = 'quality-option w-full px-4 py-2 text-left text-sm text-white hover:bg-white/10 transition-colors flex items-center justify-between';
        btn.dataset.quality = level.height;
        btn.dataset.layer = spatialLayer;
        btn.innerHTML = `
            <span>${level.label}${level.height === sourceHeight ? ' (Kaynak)' : ''}</span>
            <svg class="w-4 h-4 text-brand-500 checkmark hidden" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        `;
        qualityOptions.appendChild(btn);
    });

    // Add click handlers
    document.querySelectorAll('.quality-option').forEach(btn => {
        btn.addEventListener('click', () => selectQuality(btn));
    });

    // Select auto by default
    selectQuality(document.querySelector('[data-quality="auto"]'));

    console.log('🎚️ Quality options set up:', selectedLevels.map(l => l.label));
}

function selectQuality(btn) {
    if (!btn) return;

    const quality = btn.dataset.quality;
    const layer = parseInt(btn.dataset.layer);

    // Update UI
    document.querySelectorAll('.quality-option .checkmark').forEach(c => c.classList.add('hidden'));
    btn.querySelector('.checkmark')?.classList.remove('hidden');

    selectedQuality = quality;
    currentQuality.textContent = quality === 'auto' ? 'Auto' : quality + 'p';

    // Change layer on server
    if (videoConsumerId && quality !== 'auto') {
        socket.emit('set-preferred-layers', {
            consumerId: videoConsumerId,
            spatialLayer: layer,
            temporalLayer: 0
        }, (response) => {
            if (response?.success) {
                console.log(`✅ Quality changed to ${quality}p (layer ${layer})`);
            } else {
                console.error('❌ Quality change failed:', response?.error);
            }
        });
    } else if (videoConsumerId && quality === 'auto') {
        // Reset to highest layer for auto
        const highestLayer = broadcasterSettings?.layerCount ? broadcasterSettings.layerCount - 1 : 3;
        socket.emit('set-preferred-layers', {
            consumerId: videoConsumerId,
            spatialLayer: highestLayer,
            temporalLayer: 0
        });
        console.log('🔄 Auto quality enabled');
    }

    qualityDropdown.classList.add('hidden');
}

// ==================== STREAM LOGIC ====================

async function joinStream() {
    btnConsume.disabled = true;

    socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
        device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        createConsumerTransport();
    });
}

function createConsumerTransport() {
    socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
        if (params.error) {
            console.error(params.error);
            return;
        }

        consumerTransport = device.createRecvTransport(params);

        consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('transport-connect', {
                transportId: consumerTransport.id,
                dtlsParameters,
            });
            callback();
        });

        getProducers();
    });
}

function getProducers() {
    socket.emit('getProducers', (producerIds) => {
        console.log('Discovered producers:', producerIds);
        producerIds.forEach(id => consumeProducer(id));
    });
}

socket.on('new-producer', (producerId) => {
    console.log('New producer signal received:', producerId);
    consumeProducer(producerId);
});

async function consumeProducer(producerId) {
    if (!consumerTransport) {
        console.log('Consumer transport not ready, ignoring producer:', producerId);
        return;
    }

    socket.emit('consume', {
        transportId: consumerTransport.id,
        producerId: producerId,
        rtpCapabilities: device.rtpCapabilities,
    }, async ({ params }) => {
        if (params.error) {
            console.error('Consume error:', params.error);
            return;
        }

        console.log('Consume success:', producerId, 'Kind:', params.kind);

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
        });

        consumers.set(consumer.id, consumer);

        // Store video consumer ID for layer switching
        if (params.kind === 'video') {
            videoConsumerId = consumer.id;
            console.log('📹 Video consumer ID stored:', videoConsumerId);

            // Apply broadcaster settings if received
            if (params.broadcasterSettings) {
                broadcasterSettings = params.broadcasterSettings;
                setupQualityOptions(params.broadcasterSettings);
            }
        }

        const { track } = consumer;

        if (remoteVideo.srcObject) {
            remoteVideo.srcObject.addTrack(track);
        } else {
            remoteVideo.srcObject = new MediaStream([track]);
        }

        updateMediaStream();
        socket.emit('resume');
        status.textContent = 'Watching stream...';
    });
}

let streamUpdateTimeout;
function updateMediaStream() {
    if (streamUpdateTimeout) clearTimeout(streamUpdateTimeout);

    streamUpdateTimeout = setTimeout(() => {
        if (remoteVideo.srcObject) {
            console.log("Refreshing media stream...");
            const newStream = new MediaStream(remoteVideo.srcObject.getTracks());
            remoteVideo.srcObject = newStream;
            remoteVideo.play().catch(e => {
                if (e.name !== 'AbortError') console.error("Play error:", e);
            });
        }
    }, 200);
}

socket.on('producer-closed', ({ remoteProducerId }) => {
    console.log('Producer closed:', remoteProducerId);

    let targetConsumerId = null;
    for (const [key, consumer] of consumers) {
        if (consumer.producerId === remoteProducerId) {
            targetConsumerId = key;
            break;
        }
    }

    if (targetConsumerId) {
        const consumer = consumers.get(targetConsumerId);
        consumer.close();
        consumers.delete(targetConsumerId);

        if (remoteVideo.srcObject) {
            remoteVideo.srcObject.removeTrack(consumer.track);
            updateMediaStream();
        }
        console.log('Removed consumer for producer:', remoteProducerId);
    }
});
