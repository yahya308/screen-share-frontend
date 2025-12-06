import { Device } from "mediasoup-client";

const socket = io("https://yahya-oracle.duckdns.org");
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

btnConsume.addEventListener('click', joinStream);

socket.on('connect', () => {
    console.log('Socket connected, requesting viewer count');
    socket.emit('get-viewer-count');
});

socket.on('viewer-count-update', (count) => updateViewerCountUI(count));
socket.on('viewer-count-response', (count) => updateViewerCountUI(count));

// ==================== VIDEO CONTROLS ====================

// Play/Pause
if (btnPlayPause) {
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
}

remoteVideo.addEventListener('play', () => {
    if (iconPlay) iconPlay.classList.add('hidden');
    if (iconPause) iconPause.classList.remove('hidden');
});

remoteVideo.addEventListener('pause', () => {
    if (iconPlay) iconPlay.classList.remove('hidden');
    if (iconPause) iconPause.classList.add('hidden');
});

// Volume
if (btnMute) {
    btnMute.addEventListener('click', () => {
        remoteVideo.muted = !remoteVideo.muted;
        updateVolumeUI();
    });
}

if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
        remoteVideo.volume = e.target.value;
        remoteVideo.muted = remoteVideo.volume === 0;
        updateVolumeUI();
    });
}

function updateVolumeUI() {
    if (!iconVolumeOn || !iconVolumeOff) return;
    if (remoteVideo.muted || remoteVideo.volume === 0) {
        iconVolumeOn.classList.add('hidden');
        iconVolumeOff.classList.remove('hidden');
    } else {
        iconVolumeOn.classList.remove('hidden');
        iconVolumeOff.classList.add('hidden');
    }
    if (volumeSlider) volumeSlider.value = remoteVideo.muted ? 0 : remoteVideo.volume;
}

// Fullscreen
if (btnFullscreen && videoContainer) {
    btnFullscreen.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            videoContainer.requestFullscreen();
        }
    });
}

document.addEventListener('fullscreenchange', () => {
    if (!iconFullscreenEnter || !iconFullscreenExit) return;
    if (document.fullscreenElement) {
        iconFullscreenEnter.classList.add('hidden');
        iconFullscreenExit.classList.remove('hidden');
    } else {
        iconFullscreenEnter.classList.remove('hidden');
        iconFullscreenExit.classList.add('hidden');
    }
});

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
