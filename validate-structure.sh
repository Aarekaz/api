#!/bin/bash

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

API_URL="https://api.anuragd.me"
PASSED=0
FAILED=0

echo "=========================================="
echo "API Structure Validation"
echo "=========================================="

# Test public endpoints
echo -e "\n${YELLOW}Testing Public Endpoints...${NC}"

# Root endpoint
response=$(curl -s -w "\n%{http_code}" "$API_URL/")
status=$(echo "$response" | tail -n1)
if [ "$status" = "200" ]; then
    echo -e "${GREEN}✓${NC} Root endpoint (/) - Status: 200"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗${NC} Root endpoint (/) - Status: $status"
    FAILED=$((FAILED + 1))
fi

# OpenAPI spec
response=$(curl -s -w "\n%{http_code}" "$API_URL/openapi.json")
status=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
if [ "$status" = "200" ]; then
    # Check if it has the base URL
    if echo "$body" | grep -q "api.anuragd.me"; then
        echo -e "${GREEN}✓${NC} OpenAPI spec (/openapi.json) - Status: 200, Base URL configured"
        PASSED=$((PASSED + 1))
    else
        echo -e "${YELLOW}⚠${NC} OpenAPI spec (/openapi.json) - Status: 200, but base URL might be missing"
        PASSED=$((PASSED + 1))
    fi
else
    echo -e "${RED}✗${NC} OpenAPI spec (/openapi.json) - Status: $status"
    FAILED=$((FAILED + 1))
fi

# Test authentication on protected endpoints
echo -e "\n${YELLOW}Testing Authentication...${NC}"

endpoints=(
    "/health"
    "/v1/profile"
    "/v1/projects"
    "/v1/shelf"
    "/v1/uses"
    "/v1/wakatime"
    "/v1/github"
    "/v1/health"
)

for endpoint in "${endpoints[@]}"; do
    response=$(curl -s -w "\n%{http_code}" "$API_URL$endpoint")
    status=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    # Should return 401 (missing auth) or 403 (invalid token)
    if [ "$status" = "401" ] || [ "$status" = "403" ]; then
        echo -e "${GREEN}✓${NC} $endpoint - Auth required (Status: $status)"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} $endpoint - Unexpected status: $status"
        echo "  Response: $body"
        FAILED=$((FAILED + 1))
    fi
done

# Test TypeScript compilation
echo -e "\n${YELLOW}Testing TypeScript Compilation...${NC}"
cd /Users/aarekaz/Development/api
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
    echo -e "${RED}✗${NC} TypeScript compilation has errors"
    FAILED=$((FAILED + 1))
else
    echo -e "${GREEN}✓${NC} TypeScript compilation successful"
    PASSED=$((PASSED + 1))
fi

# Check file structure
echo -e "\n${YELLOW}Checking File Structure...${NC}"

required_files=(
    "src/index.ts"
    "src/types/env.ts"
    "src/types/common.ts"
    "src/middleware/auth.ts"
    "src/utils/date.ts"
    "src/utils/json.ts"
    "src/utils/response.ts"
    "src/utils/validation.ts"
    "src/utils/normalizers.ts"
    "src/schemas/common.ts"
    "src/schemas/profile.ts"
    "src/schemas/content.ts"
    "src/schemas/health.ts"
    "src/schemas/openapi.ts"
    "src/services/wakatime.ts"
    "src/services/github.ts"
    "src/services/lanyard.ts"
    "src/routes/profile.ts"
    "src/routes/shelf.ts"
    "src/routes/uses.ts"
    "src/routes/wakatime.ts"
    "src/routes/github.ts"
    "src/routes/health-data.ts"
    "src/scheduled.ts"
)

for file in "${required_files[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file exists"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} $file missing"
        FAILED=$((FAILED + 1))
    fi
done

# Summary
TOTAL=$((PASSED + FAILED))
SUCCESS_RATE=$(awk "BEGIN {printf \"%.1f\", ($PASSED/$TOTAL)*100}")

echo -e "\n=========================================="
echo -e "VALIDATION SUMMARY"
echo -e "=========================================="
echo -e "Total Checks: $TOTAL"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo -e "Success Rate: ${SUCCESS_RATE}%"
echo -e "=========================================="

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All validation checks passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some validation checks failed${NC}"
    exit 1
fi
