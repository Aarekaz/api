#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
API_URL="https://api.anuragd.me"
# Get API_TOKEN from environment or prompt
if [ -z "$API_TOKEN" ]; then
    echo "Please set API_TOKEN environment variable"
    exit 1
fi

# Test counter
TOTAL=0
PASSED=0
FAILED=0

# Function to test endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local description=$3
    local expected_status=$4
    local data=$5
    
    TOTAL=$((TOTAL + 1))
    echo -e "\n${YELLOW}Testing: $description${NC}"
    echo "  $method $endpoint"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $API_TOKEN" "$API_URL$endpoint")
    elif [ "$method" = "POST" ]; then
        response=$(curl -s -w "\n%{http_code}" -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" -d "$data" "$API_URL$endpoint")
    fi
    
    status_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$status_code" = "$expected_status" ]; then
        echo -e "  ${GREEN}✓ PASSED${NC} (Status: $status_code)"
        PASSED=$((PASSED + 1))
        # Show first 100 chars of response
        echo "  Response: $(echo $body | cut -c1-100)..."
    else
        echo -e "  ${RED}✗ FAILED${NC} (Expected: $expected_status, Got: $status_code)"
        FAILED=$((FAILED + 1))
        echo "  Response: $body"
    fi
}

echo "=========================================="
echo "API Endpoint Testing"
echo "API URL: $API_URL"
echo "=========================================="

# Public endpoints (no auth)
echo -e "\n${YELLOW}=== PUBLIC ENDPOINTS ===${NC}"
test_endpoint "GET" "/" "Root endpoint" "200"
test_endpoint "GET" "/openapi.json" "OpenAPI spec" "200"

# Protected endpoints
echo -e "\n${YELLOW}=== PROFILE & SETTINGS ===${NC}"
test_endpoint "GET" "/health" "Health check" "200"
test_endpoint "GET" "/v1/profile" "Get profile" "200"
test_endpoint "GET" "/v1/now" "Get now status" "200"
test_endpoint "GET" "/v1/settings" "Get settings" "200"

echo -e "\n${YELLOW}=== CONTENT ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/projects" "List projects" "200"
test_endpoint "GET" "/v1/notes" "List notes" "200"
test_endpoint "GET" "/v1/events" "List events" "200"
test_endpoint "GET" "/v1/posts" "List posts" "200"
test_endpoint "GET" "/v1/uses" "List uses items" "200"
test_endpoint "GET" "/v1/shelf" "List shelf items" "200"

echo -e "\n${YELLOW}=== RESUME ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/experience" "List experience" "200"
test_endpoint "GET" "/v1/education" "List education" "200"
test_endpoint "GET" "/v1/skills" "List skills" "200"

echo -e "\n${YELLOW}=== MEDIA ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/photos" "List photos" "200"

echo -e "\n${YELLOW}=== ACTIVITY ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/status" "Get status" "200"
test_endpoint "GET" "/v1/wakatime" "Get WakaTime data" "200"
test_endpoint "GET" "/v1/wakatime/hourly" "Get WakaTime hourly" "200"
test_endpoint "GET" "/v1/github" "Get GitHub data" "200"

echo -e "\n${YELLOW}=== WRAPPED ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/wrapped/day" "Get day wrapped" "200"
test_endpoint "GET" "/v1/wrapped/week" "Get week wrapped" "200"
test_endpoint "GET" "/v1/wrapped/month" "Get month wrapped" "200"
test_endpoint "GET" "/v1/wrapped/2026" "Get 2026 wrapped" "200"

echo -e "\n${YELLOW}=== HEALTH DATA ENDPOINTS ===${NC}"
test_endpoint "GET" "/v1/health" "Get health daily data" "200"
test_endpoint "GET" "/v1/health/heart-rate" "Get heart rate samples" "200"
test_endpoint "GET" "/v1/health/sleep" "Get sleep sessions" "200"
test_endpoint "GET" "/v1/health/workouts" "Get workouts" "200"
test_endpoint "GET" "/v1/health/summary" "Get health summary" "200"

echo -e "\n${YELLOW}=== EXPORT ENDPOINT ===${NC}"
test_endpoint "GET" "/v1/export" "Export all data" "200"

# Summary
echo -e "\n=========================================="
echo -e "TEST SUMMARY"
echo -e "=========================================="
echo -e "Total Tests: $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo -e "Success Rate: $(awk "BEGIN {printf \"%.2f\", ($PASSED/$TOTAL)*100}")%"
echo -e "=========================================="

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! ✓${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed! ✗${NC}"
    exit 1
fi
