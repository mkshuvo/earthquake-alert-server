@echo off
REM Generate self-signed certificates for EMQX TLS/SSL (Windows Batch Script)
REM This script creates easily replaceable certificates
REM Requires: OpenSSL installed and in PATH

setlocal enabledelayedexpansion

set CERT_DIR=certs
set DAYS_VALID=365

echo.
echo ==========================================
echo  EMQX TLS/SSL Certificate Generator
echo ==========================================
echo.

REM Create certs directory if it doesn't exist
if not exist "%CERT_DIR%" mkdir "%CERT_DIR%"

REM Check if OpenSSL is available
where openssl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: OpenSSL not found in PATH
    echo Please install OpenSSL: https://slproweb.com/products/Win32OpenSSL.html
    echo After installation, add OpenSSL to your PATH environment variable
    echo.
    pause
    exit /b 1
)

echo.
echo Generating self-signed certificates for EMQX...
echo.

REM 1. Generate CA private key
echo [1/8] Generating CA private key...
openssl genrsa -out "%CERT_DIR%\ca-key.pem" 2048
if %ERRORLEVEL% NEQ 0 goto error

REM 2. Generate CA certificate
echo [2/8] Generating CA certificate...
openssl req -x509 -new -nodes -key "%CERT_DIR%\ca-key.pem" ^
  -days %DAYS_VALID% -out "%CERT_DIR%\ca-cert.pem" ^
  -subj "/CN=earthquake-detection-ca/O=Earthquake Detection/C=US"
if %ERRORLEVEL% NEQ 0 goto error

REM 3. Generate Server private key
echo [3/8] Generating server private key...
openssl genrsa -out "%CERT_DIR%\server-key.pem" 2048
if %ERRORLEVEL% NEQ 0 goto error

REM 4. Generate Server certificate signing request
echo [4/8] Generating server CSR...
openssl req -new -key "%CERT_DIR%\server-key.pem" ^
  -out "%CERT_DIR%\server.csr" ^
  -subj "/CN=emqx/O=Earthquake Detection/C=US"
if %ERRORLEVEL% NEQ 0 goto error

REM 5. Sign server certificate with CA
echo [5/8] Signing server certificate...
openssl x509 -req -in "%CERT_DIR%\server.csr" ^
  -CA "%CERT_DIR%\ca-cert.pem" -CAkey "%CERT_DIR%\ca-key.pem" ^
  -CAcreateserial -out "%CERT_DIR%\server-cert.pem" ^
  -days %DAYS_VALID% -sha256
if %ERRORLEVEL% NEQ 0 goto error

REM 6. Generate Client private key
echo [6/8] Generating client private key...
openssl genrsa -out "%CERT_DIR%\client-key.pem" 2048
if %ERRORLEVEL% NEQ 0 goto error

REM 7. Generate Client certificate signing request
echo [7/8] Generating client CSR...
openssl req -new -key "%CERT_DIR%\client-key.pem" ^
  -out "%CERT_DIR%\client.csr" ^
  -subj "/CN=earthquake-sensor/O=Earthquake Detection/C=US"
if %ERRORLEVEL% NEQ 0 goto error

REM 8. Sign client certificate with CA
echo [8/8] Signing client certificate...
openssl x509 -req -in "%CERT_DIR%\client.csr" ^
  -CA "%CERT_DIR%\ca-cert.pem" -CAkey "%CERT_DIR%\ca-key.pem" ^
  -CAcreateserial -out "%CERT_DIR%\client-cert.pem" ^
  -days %DAYS_VALID% -sha256
if %ERRORLEVEL% NEQ 0 goto error

REM Clean up CSR files
del "%CERT_DIR%\server.csr" 2>nul
del "%CERT_DIR%\client.csr" 2>nul
del "%CERT_DIR%\ca-cert.srl" 2>nul

echo.
echo ============================================
echo  SUCCESS: Certificates generated!
echo ============================================
echo.
echo Certificate files created:
echo   - ca-cert.pem          (CA certificate)
echo   - ca-key.pem           (CA private key - KEEP SECURE)
echo   - server-cert.pem      (Server certificate)
echo   - server-key.pem       (Server private key - KEEP SECURE)
echo   - client-cert.pem      (Client certificate)
echo   - client-key.pem       (Client private key - KEEP SECURE)
echo.
echo To verify certificate:
echo   openssl x509 -in certs\server-cert.pem -text -noout
echo.
echo To replace with production certificates:
echo   1. Obtain certificates from trusted CA
echo   2. Replace files in certs\ directory
echo   3. Run: docker-compose restart ea-emqx
echo.
echo No configuration changes needed - EMQX will use new files!
echo.
pause
exit /b 0

:error
echo.
echo ERROR: Certificate generation failed!
echo Please check the error message above.
echo.
pause
exit /b 1
