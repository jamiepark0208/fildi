#!/bin/bash
# Run this once on the Oracle Cloud VM after SSH-ing in.
# Usage: bash setup.sh

set -e

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> Installing PM2..."
sudo npm install -g pm2

echo "==> Installing proxy dependencies..."
npm install

echo ""
echo "==> Setup complete."
echo ""
echo "Now start the proxy with your credentials:"
echo ""
echo "  PROXY_SECRET=<random-token> FACTSET_KEY=<base64-user:apikey> pm2 start proxy.js --name factset-proxy"
echo "  pm2 startup   # prints a command — run it to auto-start on reboot"
echo "  pm2 save"
echo ""
echo "Test it:"
echo "  curl http://localhost:3001/health"
