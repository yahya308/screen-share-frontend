import { Device } from "mediasoup-client";

const socket = io("https://yahya-oracle.duckdns.org");
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleAudio = document.getElementById('btnToggleAudio');
const status = document.getElementById('status');
const localVideo = document.getElementById('localVideo');

const updateViewerCountUI = (count) => {
    const el = document.getElementById('viewer-count-display');
    const targetEl = el || document.getElementById('viewerCount');
    if (targetEl) {
        targetEl.innerText = count;
        console.log("✅ UI Updated with count:", count);
    }
};

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

socket.on('connect', () => {
    console.log('Socket connected, requesting viewer count');
    socket.emit('get-viewer-count');
});

socket.on('viewer-count-update', (count) => updateViewerCountUI(count));
socket.on('viewer-count-response', (count) => updateViewerCountUI(count));

async function startShare() {
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnToggleMic.disabled = false;
    btnToggleAudio.disabled = false;

    const height = parseInt(resSelect.value);
    const fps = parseInt(fpsSelect.value);
    const bitrate = parseInt(bitrateInput.value) * 1000;

    try {
        socket.emit('getRouterRtpCapabilities', async (rtpCapabilities) => {
            if (!device) {
                device = new Device();
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }

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

                // Capture Screen
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        height: { ideal: height },
                        frameRate: { ideal: fps },
                        width: { ideal: height * (16 / 9) }
                    },
                    audio: true
                });

                localVideo.srcObject = stream;

                const videoTrack = stream.getVideoTracks()[0];

                // Optimize for screen content
                if (videoTrack.contentHint !== undefined) {
                    videoTrack.contentHint = 'detail'; // Optimize for text/detail (screen sharing)
                }

                // Performance-optimized encoding
                videoProducer = await producerTransport.produce({
                    track: videoTrack,
                    encodings: [
                        {
                            maxBitrate: bitrate,
                            networkPriority: 'high',
                            priority: 'high'
                        }
                    ],
                    codecOptions: {
                        videoGoogleStartBitrate: bitrate / 2 // Start at 50% of max for faster ramp-up
                    },
                    appData: {
                        source: 'screen'
                    }
                });

                // Send stream info to server for viewers
                socket.emit('broadcaster-settings', {
                    resolution: height,
                    fps: fps,
                    maxBitrate: bitrate
                });

                videoTrack.onended = () => stopShare("Video Track Ended (Browser UI)");

                // System Audio Track
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
        socket.emit('producer-closing', { producerId: micProducer.id });
        micProducer.close();
        micProducer = null;
        btnToggleMic.innerText = "Toggle Mic (Off)";
        document.getElementById('micVolume').value = 0;
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const track = stream.getAudioTracks()[0];
            micProducer = await producerTransport.produce({ track });
            btnToggleMic.innerText = "Toggle Mic (On)";

            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            function updateVolume() {
                if (!micProducer) return;
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
            socket.emit('producer-closing', { producerId: systemAudioProducer.id });
            systemAudioProducer.close();
            systemAudioProducer = null;
            btnToggleAudio.innerText = "Toggle System Audio (Off)";
        }
    } else {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            const audioTrack = stream.getAudioTracks()[0];
            stream.getVideoTracks().forEach(track => track.stop());

            if (audioTrack) {
                systemAudioProducer = await producerTransport.produce({ track: audioTrack });
                btnToggleAudio.innerText = "Toggle System Audio (On)";
            } else {
                alert("System audio not selected. Please try again and check 'Share system audio'.");
            }
        } catch (err) {
            console.error('System audio error:', err);
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
