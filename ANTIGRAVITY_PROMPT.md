# PROJECT SPECIFICATION: SFU Screen Sharing App (Migration from P2P)

## 1. Objective
Create a robust "One-to-Many" screen sharing application from scratch.
The current P2P (Mesh) architecture failed due to bandwidth limits.
We need a **mediasoup (SFU)** architecture where the broadcaster sends **one stream** to the server, and the server replicates it to multiple viewers.

## 2. Infrastructure & Architecture
* **Architecture:** Hybrid WebRTC (SFU).
* **Backend Server:** Hetzner Cloud VPS (Ubuntu).
    * **Public IPv4:** 37.27.202.251
    * **Public IPv6:** 2a01:4f9:c012:84b9::1
    * **Role:** Hosts the Node.js Signaling Server + Mediasoup Media Server + Coturn (TURN).
* **Frontend:** Vercel (Serverless hosting).
    * **Role:** Serves static files (HTML, CSS, JS) to users. Connects to the Backend via WebSocket.

## 3. Tech Stack Requirements
* **Backend:** Node.js, Express, Socket.io, mediasoup (library).
* **Frontend:** Vanilla JavaScript (simple & fast), HTML5, CSS3.
* **Protocol:** WebRTC (using mediasoup-client).

## 4. Detailed Instructions for the AI (You)

### A. Backend Code (Folder: `/backend`)
Create a `server.js` that handles:
1.  **Socket.io Connection:** Handle signaling (connect, disconnect).
2.  **Mediasoup Router:** Create a router on startup.
3.  **RTP Capabilities:** Send router capabilities to the client on connect.
4.  **WebRtcTransport:** Create transports for Producers (Broadcaster) and Consumers (Viewers).
    * **IMPORTANT:** Configure `listenIps` correctly using the public IP `37.27.202.251`.
5.  **Produce/Consume Logic:**
    * Allow one client to `produce` (Broadcaster).
    * Allow multiple clients to `consume` (Viewers) that producer ID.

### B. Frontend Code (Folder: `/frontend`)
Create two distinct pages:
1.  `broadcaster.html` & `broadcaster.js`:
    * Get user media (`getDisplayMedia` for screen share).
    * Connect to Socket.io server (`http://37.27.202.251:3000`).
    * Initialize `mediasoup-client`.
    * Create a producer transport and send video.
2.  `viewer.html` & `viewer.js`:
    * Connect to Socket.io server.
    * Initialize `mediasoup-client`.
    * Create a consumer transport.
    * Receive the stream and play it in a `<video>` tag.

### C. Server Configuration Guide
Provide specific Linux terminal commands to:
1.  Install Node.js (v18+) on the Ubuntu server.
2.  Install necessary build tools for mediasoup (build-essential, python3, pip).
3.  Install and configure `Coturn` (TURN server) on port 3478 with a static user/pass for simplicity (to fix firewall issues).
4.  Commands to run the server continuously (e.g., using `pm2`).

## 5. Deliverables
Please generate:
1.  Full project structure.
2.  Code for `backend/server.js`, `backend/package.json`.
3.  Code for `frontend/broadcaster.html`, `frontend/broadcaster.js`.
4.  Code for `frontend/viewer.html`, `frontend/viewer.js`.
5.  A `DEPLOYMENT_GUIDE.md` specifically for the user to execute on their Hetzner server via SSH.