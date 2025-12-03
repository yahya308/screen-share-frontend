const express = require('express');
const app = express();
const https = require('https');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');

let webServer;

// Try to create HTTPS server if certs exist
try {
    console.log('Checking SSL files...');
    console.log('Cert path:', config.https.cert);
    console.log('Key path:', config.https.key);

    const certExists = fs.existsSync(config.https.cert);
    const keyExists = fs.existsSync(config.https.key);

    console.log('Cert exists:', certExists);
    console.log('Key exists:', keyExists);

    if (certExists && keyExists) {
        const options = {
            cert: fs.readFileSync(config.https.cert),
            key: fs.readFileSync(config.https.key)
        };
        webServer = https.createServer(options, app);
        console.log('Running in HTTPS mode');
    } else {
        console.log('SSL files not found, falling back to HTTP');
        webServer = http.createServer(app);
    }
} catch (err) {
    console.log('Error checking SSL files, falling back to HTTP', err);
    webServer = http.createServer(app);
}

const io = new Server(webServer, {
    cors: {
        origin: "*",
    }
});

// --- Global Variables ---
let worker;
let router;
// let producer; // REMOVED: Single producer is not enough
const producers = new Map(); // Store all producers: producer.id -> producer
let consumer;
// We need to store transports to find them later
const transports = [];

// --- Mediasoup Worker & Router ---
async function startMediasoup() {
    worker = await mediasoup.createWorker(config.mediasoup.worker);

    worker.on('died', () => {
        console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
        setTimeout(() => process.exit(1), 2000);
    });

    router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
    console.log('Mediasoup Router created');
}

startMediasoup();

// --- Socket.io Handling ---
io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

    // Helper function to emit viewer count
    const emitViewerCount = () => {
        const count = io.engine.clientsCount;
        console.log("SERVER: İzleyici sayısı gönderiliyor:", count);
        io.emit('viewer-count-update', count);
    };

    // Emit on connection
    emitViewerCount();

    // Handle manual request
    socket.on('request-viewer-count', () => {
        console.log(`SERVER: Client ${socket.id} requested viewer count`);
        emitViewerCount();
    });

    socket.emit('connection-success', {
        socketId: socket.id,
    });

    // 1. Get Router RTP Capabilities
    socket.on('getRouterRtpCapabilities', (callback) => {
        callback(router.rtpCapabilities);
    });

    // 2. Create Transport
    socket.on('createWebRtcTransport', async ({ sender }, callback) => {
        try {
            const webRtcTransport_options = {
                ...config.mediasoup.webRtcTransport
            };

            let transport = await router.createWebRtcTransport(webRtcTransport_options);

            transport.on('dtlsstatechange', dtlsState => {
                if (dtlsState === 'closed') {
                    transport.close();
                }
            });

            transport.on('close', () => {
                console.log('Transport closed');
            });

            // Store transport
            transports.push({ socketId: socket.id, transport, sender });

            callback({
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                }
            });
        } catch (error) {
            console.error(error);
            callback({
                params: {
                    error: error
                }
            });
        }
    });

    // 3. Connect Transport
    socket.on('transport-connect', async ({ transportId, dtlsParameters }) => {
        const item = transports.find(t => t.transport.id === transportId);
        if (item) {
            await item.transport.connect({ dtlsParameters });
        }
    });

    // 4. Produce
    socket.on('transport-produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
        const item = transports.find(t => t.transport.id === transportId);
        if (item) {
            const producer = await item.transport.produce({
                kind,
                rtpParameters,
            });

            producers.set(producer.id, producer);

            producer.on('transportclose', () => {
                console.log('transport for this producer closed');
                producer.close();
                producers.delete(producer.id);
            });

            console.log('Producer created with ID:', producer.id);

            // Notify all other clients about the new producer
            socket.broadcast.emit('new-producer', producer.id);

            callback({
                id: producer.id,
                producersExist: true
            });
        }
    });

    // 5. Consume
    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        try {
            const producer = producers.get(producerId);

            if (!producer) {
                return callback({ params: { error: 'No producer exists' } });
            }

            if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
                return callback({ params: { error: 'Cannot consume' } });
            }

            const item = transports.find(t => t.transport.id === transportId);
            if (!item) return;

            const consumer = await item.transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true,
            });

            consumer.on('transportclose', () => {
                console.log('Consumer transport closed');
            });

            consumer.on('producerclose', () => {
                console.log('Producer closed');
                socket.emit('producer-closed', { remoteProducerId: producer.id });
                consumer.close();
            });

            const params = {
                id: consumer.id,
                producerId: producer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            };

            callback({ params });
            await consumer.resume();

        } catch (error) {
            console.error('Consume error:', error);
            callback({ params: { error: error } });
        }
    });

    socket.on('resume', async (data, callback) => {
        // Resume all consumers for this socket? 
        // For now, client handles resume logic per consumer if needed.
        // But we can keep this for backward compatibility or simple resume.
        callback();
    });

    socket.on('getProducers', (callback) => {
        // Return array of producer IDs
        callback(Array.from(producers.keys()));
    });

    socket.on('producer-closing', ({ producerId }) => {
        const producer = producers.get(producerId);
        if (producer) {
            console.log('Producer closing requested by client:', producerId);
            producer.close();
            producers.delete(producerId);
            // We DO NOT broadcast 'producer-closed' here anymore.
            // Closing the producer triggers 'producerclose' on all consumers,
            // which then emits 'producer-closed' to their respective clients.
            // This prevents duplicate events.
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        emitViewerCount();

        // 1. Find and close all transports associated with this socket
        const userTransports = transports.filter(t => t.socketId === socket.id);
        userTransports.forEach(t => {
            console.log('Closing transport for disconnected user:', t.transport.id);
            t.transport.close(); // This will trigger 'transportclose' on producers/consumers
        });

        // Remove from transports array
        for (let i = transports.length - 1; i >= 0; i--) {
            if (transports[i].socketId === socket.id) {
                transports.splice(i, 1);
            }
        }

        // 2. Clean up producers (if any were not closed by transport close)
        // (Actually, closing transport closes producers, but good to be safe)
        for (const [producerId, producer] of producers) {
            // We don't easily know which socket owns which producer unless we stored it.
            // But since we closed the transport, the producer should have emitted 'transportclose'
            // and removed itself from the map via the listener we added in 'transport-produce'.
        }
    });
});

const PORT = 3000;
webServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
