import { Device } from "mediasoup-client";

const socket = io("https://yahya-sfu.duckdns.org:3000"); // Connect to Backend
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleAudio = document.getElementById('btnToggleAudio');
const status = document.getElementById('status');
const localVideo = document.getElementById('localVideo');

// Viewer Count Logic - Safe DOM Element Check
const updateViewerCountUI = (count) => {
    const el = document.getElementById('viewer-count-display');
    // Fallback: Try alternative ID if primary not found
    const targetEl = el || document.getElementById('viewerCount');

    if (targetEl) {
        targetEl.innerText = count;
        targetEl.textContent = count; // Fallback for older browsers
        console.log("✅ UI Updated with count:", count);
    } else {
        console.warn("⚠️ Viewer Count Element NOT FOUND in DOM. Check HTML IDs.");
    }
};

// UI Elements
const resSelect = document.getElementById('resSelect');
const fpsSelect = document.getElementById('fpsSelect');
const bitrateInput = document.getElementById('bitrateInput');

let device;
let producerTransport;
let videoProducer;
let micProducer;
let systemAudioProducer;

btnStart.addEventListener('click', startShare);
btnStop.addEventListener('click', () => stopShare("Stop Button Clicked"));
btnToggleMic.addEventListener('click', toggleMic);
btnToggleAudio.addEventListener('click', toggleSystemAudio);

// Viewer Count: Request current count on socket connect
socket.on('connect', () => {
    console.log('Socket connected, requesting viewer count');
    socket.emit('get-viewer-count');
});

// Viewer Count: Listen for viewer count updates (broadcast to all)
socket.on('viewer-count-update', (count) => updateViewerCountUI(count));

// Viewer Count: Listen for viewer count response (direct response)
socket.on('viewer-count-response', (count) => updateViewerCountUI(count));

async function startShare() {
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnToggleMic.disabled = false;
    btnToggleAudio.disabled = false;

    // Get User Settings
    const height = parseInt(resSelect.value);
    const fps = parseInt(fpsSelect.value);
    const bitrate = parseInt(bitrateInput.value) * 1000;

    try {
        // 1. Get Router Capabilities
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
            if (!device) {
                device = new Device();
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }

            // 2. Create Transport
            socket.emit('createWebRtcTransport', { sender: true }, async ({ params }) => {
                if (params.error) {
                    console.error(params.error);
                    return;
                }

                producerTransport = device.createSendTransport(params);

                producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                    socket.emit('transport-connect', {
                        transportId: producerTransport.id,
                        dtlsParameters
                    });
                    callback();
                });

                producerTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
                    socket.emit('transport-produce', {
                        transportId: producerTransport.id,
                        kind,
                        rtpParameters,
                        appData
                    }, ({ id }) => {
                        callback({ id });
                    });
                });

                // 3. Capture Screen (Video + System Audio)
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        height: { ideal: height },
                        frameRate: { ideal: fps },
                        width: { ideal: height * (16 / 9) }
                    },
                    audio: true // Request system audio
                });

                localVideo.srcObject = stream;

                // Video Track (Simple encoding - temporarily reverted)
                const videoTrack = stream.getVideoTracks()[0];
                videoProducer = await producerTransport.produce({
                    track: videoTrack,
                    encodings: [{ maxBitrate: bitrate }]
                });

                videoTrack.onended = () => stopShare("Video Track Ended (Browser UI)");

                // System Audio Track (if available)
                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    systemAudioProducer = await producerTransport.produce({ track: audioTrack });
                    btnToggleAudio.innerText = "Toggle System Audio (On)";
                } else {
                    btnToggleAudio.innerText = "System Audio Not Available";
                    btnToggleAudio.disabled = true;
                }

                status.innerText = `Status: Broadcasting`;
            });
        });

    } catch (err) {
        console.error('Error starting share:', err);
        status.innerText = 'Error: ' + err.message;
        stopShare();
    }
}

async function toggleMic() {
    if (micProducer) {
        // If mic exists, close it (or pause it)
        socket.emit('producer-closing', { producerId: micProducer.id });
        micProducer.close();
        micProducer = null;
        btnToggleMic.innerText = "Toggle Mic (Off)";
        document.getElementById('micVolume').value = 0;
    } else {
        // ... (rest of enable mic logic)
        // Enable Mic
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const track = stream.getAudioTracks()[0];
            micProducer = await producerTransport.produce({ track });
            btnToggleMic.innerText = "Toggle Mic (On)";

            // Audio Level Analysis
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            function updateVolume() {
                if (!micProducer) return; // Stop if mic is closed
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                document.getElementById('micVolume').value = average;
                requestAnimationFrame(updateVolume);
            }
            updateVolume();

        } catch (err) {
            console.error('Mic error:', err);
            alert('Could not access microphone: ' + err.message);
        }
    }
}

async function toggleSystemAudio() {
    if (systemAudioProducer) {
        if (systemAudioProducer.paused) {
            systemAudioProducer.resume();
            btnToggleAudio.innerText = "Toggle System Audio (On)";
        } else {
            // Option 1: Pause (Keep producer, just silence)
            // systemAudioProducer.pause();
            // btnToggleAudio.innerText = "Toggle System Audio (Off)";

            // Option 2: Close (Remove producer) - Better for "removing" the track
            socket.emit('producer-closing', { producerId: systemAudioProducer.id });
            systemAudioProducer.close();
            systemAudioProducer = null;
            btnToggleAudio.innerText = "Toggle System Audio (Off)";
        }
    } else {
        // Enable System Audio
        try {
            // We need to ask for display media again to get system audio
            const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            const audioTrack = stream.getAudioTracks()[0];

            // We only want audio, so stop the video track immediately
            stream.getVideoTracks().forEach(track => track.stop());

            if (audioTrack) {
                systemAudioProducer = await producerTransport.produce({ track: audioTrack });
                btnToggleAudio.innerText = "Toggle System Audio (On)";
            } else {
                alert("System audio not selected. Please try again and check 'Share system audio'.");
            }
        } catch (err) {
            console.error('System audio error:', err);
            // alert('Could not access system audio: ' + err.message);
        }
    }
}

function stopShare(reason = "Unknown") {
    console.log(`stopShare called. Reason: ${reason}`);
    if (videoProducer) {
        socket.emit('producer-closing', { producerId: videoProducer.id });
        videoProducer.close();
        videoProducer = null;
    }
    if (micProducer) {
        socket.emit('producer-closing', { producerId: micProducer.id });
        micProducer.close();
        micProducer = null;
    }
    if (systemAudioProducer) {
        socket.emit('producer-closing', { producerId: systemAudioProducer.id });
        systemAudioProducer.close();
        systemAudioProducer = null;
    }

    if (producerTransport) { producerTransport.close(); producerTransport = null; }

    if (localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(track => track.stop());
        localVideo.srcObject = null;
    }

    btnStart.disabled = false;
    btnStop.disabled = true;
    btnToggleMic.disabled = true;
    btnToggleAudio.disabled = true;

    btnToggleMic.innerText = "Toggle Mic (Off)";
    btnToggleAudio.innerText = "Toggle System Audio (Off)";

    status.innerText = 'Status: Disconnected';
}
