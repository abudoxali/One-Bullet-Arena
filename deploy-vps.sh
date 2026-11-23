#!/bin/bash
# One Bullet Arena — VPS Deploy Script
# Usage: ./deploy.sh [commit_sha]
# Run from Windows: ssh root@5.189.151.43 "bash /var/www/onebulletarena/deploy.sh"

set -e

DEPLOY_DIR="/var/www/onebulletarena"
REPO_URL="https://github.com/abudoxali/One-Bullet-Arena.git"
BACKUP_DIR="/var/www/onebulletarena-backup"

echo "[$(date)] Starting One Bullet Arena deploy..."

# Backup current
if [ -d "$DEPLOY_DIR" ]; then
    rm -rf "$BACKUP_DIR"
    cp -r "$DEPLOY_DIR" "$BACKUP_DIR"
    echo "Backup created at $BACKUP_DIR"
fi

# Pull latest from GitHub
cd "$DEPLOY_DIR"
if [ -d ".git" ]; then
    git fetch origin main
    git reset --hard origin/main
    echo "Git pull complete: $(git rev-parse --short HEAD)"
else
    echo "No .git dir — cloning fresh..."
    cd /var/www
    rm -rf "$DEPLOY_DIR"
    git clone "$REPO_URL" onebulletarena
    echo "Clone complete"
fi

# Fix permissions
chmod -R 755 "$DEPLOY_DIR"

# Reload nginx (config already set)
nginx -t && systemctl reload nginx

echo "[$(date)] Deploy complete! Version: $(grep -o '3\.[0-9]*\.[0-9]*[^\"]*' "$DEPLOY_DIR/src/release-config.js" | head -1)"
