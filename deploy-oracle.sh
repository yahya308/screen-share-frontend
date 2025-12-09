#!/bin/bash
# Oracle Cloud Deployment Script for Mediasoup Backend
# Run this script on the Oracle Cloud server

set -e

echo "🚀 Starting Oracle Cloud Deployment..."

# Configuration
DOMAIN="yahya-oracle.duckdns.org"
PROJECT_DIR="/opt/screen-share"
EMAIL="your-email@example.com"  # Change this for Let's Encrypt notifications

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${GREEN}[STEP]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Step 1: Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then
    print_error "Please run as root or with sudo"
    exit 1
fi

# Step 2: Install required packages
print_step "Installing required packages..."
apt-get update
apt-get install -y certbot git

# Step 3: Configure firewall (iptables)
print_step "Configuring firewall rules..."
iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
iptables -I INPUT -p udp --dport 40000:49999 -j ACCEPT

# Save iptables rules
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save
else
    apt-get install -y iptables-persistent
    netfilter-persistent save
fi

# Step 4: Get SSL Certificate (standalone mode, before nginx starts)
print_step "Obtaining SSL certificate..."
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos -m $EMAIL
else
    print_warning "SSL certificate already exists for $DOMAIN"
fi

# Step 5: Create project directory
print_step "Setting up project directory..."
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# Step 6: Clone or update repository
print_step "Getting latest code..."
if [ -d ".git" ]; then
    git pull
else
    print_warning "Please copy your project files to $PROJECT_DIR"
    print_warning "Or run: git clone YOUR_REPO_URL ."
fi

# Step 7: Start services with Docker Compose
print_step "Starting Docker containers..."
docker-compose down 2>/dev/null || true
docker-compose up -d --build

# Step 8: Check status
print_step "Checking service status..."
sleep 5
docker-compose ps

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Verify services: docker-compose logs -f"
echo "2. Test HTTPS: curl -I https://$DOMAIN"
echo "3. Open in browser: https://$DOMAIN"
