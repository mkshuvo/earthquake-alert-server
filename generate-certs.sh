#!/bin/bash

# Generate self-signed certificates for EMQX TLS/SSL
# This script is easily replaceable - just swap the cert files with production certs

set -e

CERT_DIR="./certs"
DAYS_VALID=365

echo "🔐 Generating self-signed certificates for EMQX..."

# Create certs directory if it doesn't exist
mkdir -p "$CERT_DIR"

# 1. Generate CA private key
echo "  1. Generating CA private key..."
openssl genrsa -out "$CERT_DIR/ca-key.pem" 2048

# 2. Generate CA certificate
echo "  2. Generating CA certificate..."
openssl req -x509 -new -nodes -key "$CERT_DIR/ca-key.pem" \
  -days $DAYS_VALID -out "$CERT_DIR/ca-cert.pem" \
  -subj "/CN=earthquake-detection-ca/O=Earthquake Detection/C=US"

# 3. Generate Server private key
echo "  3. Generating server private key..."
openssl genrsa -out "$CERT_DIR/server-key.pem" 2048

# 4. Generate Server certificate signing request
echo "  4. Generating server CSR..."
openssl req -new -key "$CERT_DIR/server-key.pem" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=emqx/O=Earthquake Detection/C=US"

# 5. Sign server certificate with CA
echo "  5. Signing server certificate..."
openssl x509 -req -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca-cert.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/server-cert.pem" \
  -days $DAYS_VALID -sha256

# 6. Generate Client private key (for sensor authentication)
echo "  6. Generating client private key..."
openssl genrsa -out "$CERT_DIR/client-key.pem" 2048

# 7. Generate Client certificate signing request
echo "  7. Generating client CSR..."
openssl req -new -key "$CERT_DIR/client-key.pem" \
  -out "$CERT_DIR/client.csr" \
  -subj "/CN=earthquake-sensor/O=Earthquake Detection/C=US"

# 8. Sign client certificate with CA
echo "  8. Signing client certificate..."
openssl x509 -req -in "$CERT_DIR/client.csr" \
  -CA "$CERT_DIR/ca-cert.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/client-cert.pem" \
  -days $DAYS_VALID -sha256

# Clean up CSR files
rm -f "$CERT_DIR/server.csr" "$CERT_DIR/client.csr"

# Set proper permissions
chmod 400 "$CERT_DIR"/*-key.pem
chmod 444 "$CERT_DIR"/*-cert.pem

echo ""
echo "✅ Certificates generated successfully!"
echo ""
echo "📁 Certificate files created:"
echo "  - ca-cert.pem          (CA certificate - share with clients)"
echo "  - ca-key.pem           (CA private key - KEEP SECURE)"
echo "  - server-cert.pem      (Server certificate - for EMQX TLS listener)"
echo "  - server-key.pem       (Server private key - KEEP SECURE)"
echo "  - client-cert.pem      (Client certificate - for sensor authentication)"
echo "  - client-key.pem       (Client private key - for sensor authentication)"
echo ""
echo "🔄 To replace with production certificates:"
echo "   1. Replace server-cert.pem and server-key.pem with your production certs"
echo "   2. Replace client-cert.pem and client-key.pem with your client certs"
echo "   3. Update ca-cert.pem with your production CA certificate"
echo "   4. No changes needed to EMQX configuration - it will use the new files"
echo ""
