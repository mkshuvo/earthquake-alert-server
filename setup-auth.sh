#!/bin/bash

# Setup EMQX Authentication and Authorization
# This script configures built-in users and ACLs for different services

set -e

EMQX_CLI="docker exec ea-emqx emqx_ctl"

echo "🔐 Setting up EMQX Authentication and Authorization..."
echo ""

# Function to add user
add_user() {
  local username=$1
  local password=$2
  local description=$3
  
  echo "  Adding user: $username ($description)..."
  
  # Add user to built-in database
  $EMQX_CLI users add "$username" "$password" || true
}

# Function to set ACL
set_acl() {
  local username=$1
  local topic=$2
  local action=$3  # publish, subscribe, pubsub
  
  echo "    Setting ACL: $username - $action on $topic"
  
  # Note: ACL setup via CLI varies by EMQX version
  # For this setup, use the Dashboard to add ACLs or create an ACL file
}

# ============================================
# 1. BACKEND CONSUMER (RabbitMQ Integration)
# ============================================
echo "📌 Configuring users for services..."
add_user "earthquake-consumer" "consumer-secure-pass-123" "RabbitMQ Consumer Service"

# Consumer needs to:
# - Subscribe to earthquake.alert.* topics
# - Publish to earthquake/processed topics

# ============================================
# 2. FRONTEND APPLICATION
# ============================================
add_user "earthquake-frontend" "frontend-secure-pass-456" "Next.js Frontend App"

# Frontend needs to:
# - Subscribe to earthquake.alert.* for real-time updates
# - Subscribe to earthquake/statistics for stats
# - Publish to earthquake/requests for manual fetch requests

# ============================================
# 3. MOBILE APP
# ============================================
add_user "earthquake-mobile" "mobile-secure-pass-789" "Mobile Alert App"

# Mobile needs to:
# - Subscribe to earthquake.alert.* for push notifications
# - Publish to earthquake/mobile/* for client-specific channels

# ============================================
# 4. SENSOR/IoT DEVICES (Certificate-based auth)
# ============================================
# Note: Sensors should use certificate authentication via TLS
# The following is for fallback username/password authentication
add_user "earthquake-sensor-001" "sensor-secure-pass-001" "Seismic Sensor Node 1"
add_user "earthquake-sensor-002" "sensor-secure-pass-002" "Seismic Sensor Node 2"

# Sensors need to:
# - Publish to earthquake/sensors/[sensor_id]/data
# - Subscribe to earthquake/sensors/[sensor_id]/commands for control messages

# ============================================
# 5. MONITORING & ADMIN
# ============================================
add_user "earthquake-admin" "admin-secure-pass-admin" "System Administrator"
add_user "earthquake-monitor" "monitor-secure-pass-mon" "Monitoring System"

# Admin needs full access
# Monitor needs read-only access to all topics

echo ""
echo "✅ Users created successfully!"
echo ""
echo "📋 Authentication Summary:"
echo ""
echo "Service Accounts:"
echo "  • earthquake-consumer (RabbitMQ Consumer)"
echo "  • earthquake-frontend (Web Application)"
echo "  • earthquake-mobile (Mobile App)"
echo ""
echo "Sensor Accounts:"
echo "  • earthquake-sensor-001 (Sensor 1)"
echo "  • earthquake-sensor-002 (Sensor 2)"
echo "  • (Add more sensors as needed)"
echo ""
echo "Administrative Accounts:"
echo "  • earthquake-admin (Full access)"
echo "  • earthquake-monitor (Read-only monitoring)"
echo ""
echo "🔄 To add more users/sensors:"
echo "   Run: $EMQX_CLI users add <username> <password>"
echo ""
echo "🔐 To configure ACLs via Dashboard:"
echo "   1. Visit http://localhost:18083"
echo "   2. Go to Access Control > ACL"
echo "   3. Add rules for each user"
echo ""
echo "📌 Recommended ACL Configuration:"
echo ""
cat << 'EOF'
Consumer Service (earthquake-consumer):
  ALLOW:
    - subscribe: earthquake/alert/+
    - publish: earthquake/processed/+

Frontend (earthquake-frontend):
  ALLOW:
    - subscribe: earthquake/alert/+
    - subscribe: earthquake/statistics
    - publish: earthquake/requests/manual-fetch

Mobile (earthquake-mobile):
  ALLOW:
    - subscribe: earthquake/alert/+
    - publish: earthquake/mobile/+

Sensors (earthquake-sensor-*):
  ALLOW:
    - publish: earthquake/sensors/+/data
    - subscribe: earthquake/sensors/+/commands

Monitor (earthquake-monitor):
  ALLOW:
    - subscribe: $SYS/brokers/+/clients/+
    - subscribe: $SYS/brokers/+/metrics/conn.+

Admin (earthquake-admin):
  ALLOW:
    - all (all access)
EOF

echo ""
echo "🔗 Connection Examples:"
echo ""
echo "JavaScript (Frontend):"
echo "  mqtt://earthquake-frontend:frontend-secure-pass-456@localhost:45329"
echo "  mqtts://earthquake-frontend:frontend-secure-pass-456@localhost:47754"
echo ""
echo "Python (RabbitMQ Consumer):"
echo "  mqtt://earthquake-consumer:consumer-secure-pass-123@emqx:1883"
echo "  (internal Docker network, no TLS needed)"
echo ""
echo "Arduino/IoT Sensor (Certificate-based):"
echo "  mqtts://earthquake-sensor-001:sensor-secure-pass-001@localhost:47754"
echo "  (with ca-cert.pem for certificate verification)"
echo ""
