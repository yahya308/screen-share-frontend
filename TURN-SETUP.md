# TURN Server Configuration

## Overview
This application has been configured to use a TURN server at `78.47.162.63:3478` to improve WebRTC connectivity, especially for users behind restrictive firewalls or NATs.

## Configuration Details

### TURN Server Settings
- **Server**: `78.47.162.63:3478`
- **Username**: `turnuser`
- **Password**: `turnpass`
- **Protocols**: UDP and TCP

### WebRTC Configuration
The TURN server has been added to the ICE servers list in both:
- `public/broadcaster.html`
- `public/viewer.html`

```javascript
const configuration = {
    iceServers: [
        // STUN servers (for NAT traversal)
        { urls: 'stun:stun.l.google.com:19302' },
        // ... other STUN servers
        
        // TURN servers (for relay when direct connection fails)
        { 
            urls: 'turn:78.47.162.63:3478',
            username: 'turnuser',
            credential: 'turnpass'
        },
        { 
            urls: 'turn:78.47.162.63:3478?transport=tcp',
            username: 'turnuser',
            credential: 'turnpass'
        }
    ],
    iceCandidatePoolSize: 10
};
```

## Testing TURN Server

### Browser-Based Test
The easiest way to test the TURN server is through the browser:

1. **Start the server:**
   ```bash
   npm start
   ```

2. **Open the test page:**
   ```
   http://localhost:3000/test-turn
   ```

3. **View results:**
   - ✅ **Success**: TURN server candidate found
   - ⚠️ **Warning**: No TURN candidates (may be normal if STUN is sufficient)
   - ❌ **Error**: TURN server unreachable

### What the Test Does
- Creates a WebRTC peer connection with TURN server configuration
- Gathers ICE candidates (STUN and TURN)
- Displays all candidates in real-time
- Identifies TURN server candidates specifically
- Shows connection success/failure status

## How It Works

1. **STUN First**: The application tries to establish direct peer-to-peer connections using STUN servers
2. **TURN Fallback**: If direct connection fails (due to firewalls, NATs, etc.), it uses the TURN server as a relay
3. **Automatic Selection**: WebRTC automatically chooses the best connection method

## Benefits

- **Improved Connectivity**: Works behind corporate firewalls and restrictive NATs
- **Better Reliability**: Reduces connection failures in challenging network environments
- **Global Access**: Enables connections between users in different networks

## Troubleshooting

### If TURN Server is Unreachable
1. Check if the TURN server is running and accessible
2. Verify firewall settings allow connections to port 3478
3. Test with `npm run test-turn`

### If Connections Still Fail
1. Check browser console for WebRTC errors
2. Verify HTTPS is enabled (required for WebRTC)
3. Test with different browsers
4. Check network connectivity

## Security Notes

- TURN credentials are included in the client-side code
- For production, consider:
  - Using temporary credentials
  - Implementing server-side credential generation
  - Using authentication tokens

## Server Requirements

The TURN server should be configured with:
- **Port**: 3478 (standard TURN port)
- **Protocols**: UDP and TCP
- **Authentication**: Username/password or token-based
- **Relay**: Enabled for media traffic
