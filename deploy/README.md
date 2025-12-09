# Earthquake Alert API Server Deployment

## Prerequisites
- Docker & Docker Compose
- Nginx
- External Docker network `earthquake_network`

## Setup

1. **Nginx Configuration**:
   - Copy `deploy/nginx/api.quakenow.ovh.conf` to `/etc/nginx/sites-available/`.
   - Symlink to `/etc/nginx/sites-enabled/`.
   - Reload Nginx: `sudo nginx -t && sudo systemctl reload nginx`.

2. **Run Services**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

3. **Verify**:
   - API should be accessible at `http://api.quakenow.ovh`.
   - Socket.IO at `http://api.quakenow.ovh/socket.io/`.
