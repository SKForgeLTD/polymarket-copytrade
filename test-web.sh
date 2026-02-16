#!/bin/bash

# Test script for web interface

echo "Starting bot with web interface..."
WEB_ENABLED=true WEB_PORT=3001 pnpm dev start &
PID=$!

echo "Bot PID: $PID"
echo "Waiting 5 seconds for startup..."
sleep 5

echo "Testing web endpoints..."

# Test dashboard HTML
echo -n "Testing / (dashboard): "
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ && echo " ✓" || echo " ✗"

# Test API status
echo -n "Testing /api/status: "
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/status && echo " ✓" || echo " ✗"

# Test API trades
echo -n "Testing /api/trades/recent: "
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/trades/recent && echo " ✓" || echo " ✗"

# Test health check
echo -n "Testing /health: "
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health && echo " ✓" || echo " ✗"

echo ""
echo "Stopping bot..."
kill $PID
wait $PID 2>/dev/null

echo "Test complete!"
