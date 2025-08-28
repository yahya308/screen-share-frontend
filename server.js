const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'broadcaster.html'));
});

app.get('/watch', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle broadcaster joining
    socket.on('broadcaster', () => {
        socket.broadcast.emit('broadcaster');
        console.log('Broadcaster joined');
    });

    // Handle viewer joining
    socket.on('viewer', () => {
        socket.broadcast.emit('viewer');
        console.log('Viewer joined');
    });

    // Handle WebRTC offer
    socket.on('offer', (offer) => {
        socket.broadcast.emit('offer', offer);
        console.log('Offer sent');
    });

    // Handle WebRTC answer
    socket.on('answer', (answer) => {
        socket.broadcast.emit('answer', answer);
        console.log('Answer sent');
    });

    // Handle ICE candidates
    socket.on('ice-candidate', (candidate) => {
        socket.broadcast.emit('ice-candidate', candidate);
        console.log('ICE candidate sent');
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        socket.broadcast.emit('user-disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Broadcaster: http://localhost:${PORT}/`);
    console.log(`Viewer: http://localhost:${PORT}/watch`);
});
