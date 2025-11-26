# Deployment Guide for Hetzner VPS (Ubuntu)

This guide helps you deploy the SFU Screen Sharing backend to your Hetzner server.

## 1. Connect to your Server
Open your terminal (PowerShell or CMD on Windows) and SSH into your server:
```bash
ssh root@167.235.53.246
```
*(Enter your password when prompted)*

## 2. Install Node.js (v18) using NVM
We will use NVM (Node Version Manager) which is more reliable than the system package manager.

1. Install NVM:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```

2. Activate NVM (run this command so you don't need to restart terminal):
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

3. Install and Use Node.js v18:
```bash
nvm install 18
nvm use 18
```

4. Verify installation:
Back in your **SSH session** on the server:
```bash
cd /root/sfu-backend
npm install
```
*Note: This might take a few minutes as it compiles mediasoup.*

Start the server:

## Troubleshooting Firewall
If you cannot connect, ensure ports are open.
```bash
ufw allow 3000/tcp
ufw allow 2000:2020/udp
ufw allow 2000:2020/tcp
```
