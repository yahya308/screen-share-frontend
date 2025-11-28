import { Device } from "mediasoup-client";

const socket = io("https://yahya-sfu.duckdns.org:3000");
const btnConsume = document.getElementById('btnConsume');
const status = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');

let device;
let consumerTransport;
const consumers = new Map(); // Store consumers: consumer.id -> consumer

btnConsume.addEventListener('click', joinStream);

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

        // Once transport is ready, get existing producers
        getProducers();
    });
}

function getProducers() {
    socket.emit('getProducers', (producerIds) => {
        console.log('Discovered producers:', producerIds);
        producerIds.forEach(id => consumeProducer(id));
    });
}

// Listen for new producers (e.g. when broadcaster toggles mic)
socket.on('new-producer', (producerId) => {
    console.log('New producer signal received:', producerId);
    consumeProducer(producerId);
});

async function consumeProducer(producerId) {
    if (!consumerTransport) {
        console.log('Consumer transport not ready, ignoring producer:', producerId);
        return;
    }

    console.log('Attempting to consume producer:', producerId);

    socket.emit('consume', {
        transportId: consumerTransport.id,
        producerId: producerId,
        rtpCapabilities: device.rtpCapabilities,
    }, async ({ params }) => {
        if (params.error) {
            console.error('Consume error for producer', producerId, ':', params.error);
            return;
        }

        console.log('Consume success for producer:', producerId, 'Kind:', params.kind);

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
        });

        consumers.set(consumer.id, consumer);

        const { track } = consumer;

        if (params.kind === 'video') {
            // If we already have a stream, add the track to it
            if (remoteVideo.srcObject) {
                remoteVideo.srcObject.addTrack(track);
            } else {
                remoteVideo.srcObject = new MediaStream([track]);
            }
        } else if (params.kind === 'audio') {
            console.log('Adding audio track for producer:', producerId);

            // If we already have a stream, add the track to it
            if (remoteVideo.srcObject) {
                remoteVideo.srcObject.addTrack(track);
            } else {
                remoteVideo.srcObject = new MediaStream([track]);
            }
        }

        // Debounce the stream refresh to prevent "AbortError" from rapid updates
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
            console.log("Refreshing media stream to ensure all tracks play...");
            const newStream = new MediaStream(remoteVideo.srcObject.getTracks());
            remoteVideo.srcObject = newStream;
            remoteVideo.play().catch(e => {
                if (e.name !== 'AbortError') {
                    console.error("Error playing video:", e);
                }
            });
        }
    }, 200); // Wait 200ms for other tracks to arrive
}

socket.on('producer-closed', ({ remoteProducerId }) => {
    console.log('Producer closed:', remoteProducerId);

    // Find the consumer associated with this producer
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

        // Remove track from stream
        if (remoteVideo.srcObject) {
            remoteVideo.srcObject.removeTrack(consumer.track);
            // Refresh stream to reflect removal
            updateMediaStream();
        }
        console.log('Removed consumer and track for producer:', remoteProducerId);
    }
});
