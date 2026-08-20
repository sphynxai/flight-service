#!/bin/bash

# Test the Flight Service API

BASE_URL="http://localhost:3003"

# Test 1: Health check
echo "=== Test 1: Health Check ==="
curl -s "$BASE_URL/health" | jq .

# Test 2: Briefing (fallback mode — no API key)
echo -e "\n=== Test 2: Briefing (Fallback Mode) ==="
curl -s -X POST "$BASE_URL/api/briefing" \
  -H "Content-Type: application/json" \
  -d '{
    "departure": "KJFK",
    "arrival": "KLAX",
    "altitude": 8000,
    "latitude": 40.7128,
    "longitude": -74.0060
  }' | jq .

# Test 3: Briefing with missing params (should error)
echo -e "\n=== Test 3: Missing Params (Error Expected) ==="
curl -s -X POST "$BASE_URL/api/briefing" \
  -H "Content-Type: application/json" \
  -d '{
    "altitude": 8000,
    "latitude": 40.7128,
    "longitude": -74.0060
  }' | jq .

echo -e "\n=== Tests Complete ==="
