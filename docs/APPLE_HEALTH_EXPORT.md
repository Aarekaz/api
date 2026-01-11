# Apple Health Data Export API

This document explains how to set up iOS Shortcuts to automatically export your Apple Health data (from Apple Watch Series 8) to your personal API.

## Table of Contents

1. [Overview](#overview)
2. [Available Health Metrics](#available-health-metrics)
3. [API Endpoints](#api-endpoints)
4. [iOS Shortcuts Setup](#ios-shortcuts-setup)
5. [Example Shortcuts](#example-shortcuts)
6. [Deployment Steps](#deployment-steps)
7. [Troubleshooting](#troubleshooting)

---

## Overview

This API allows you to push Apple Health data from your iPhone/Apple Watch to your personal Cloudflare Worker using iOS Shortcuts. The data is stored in a D1 database and can be retrieved via REST API.

### Architecture

```
Apple Watch → Apple Health App → iOS Shortcuts → POST Request → Cloudflare Worker → D1 Database
```

### Requirements

- iPhone with iOS 16+ (for sleep stages)
- Apple Watch Series 8 (for wrist temperature)
- iOS Shortcuts app
- Your API endpoint URL and API token

---

## Available Health Metrics

Based on Apple Watch Series 8 capabilities, the following metrics are available:

### Heart & Cardiovascular

| Metric | Field Name | Unit | Notes |
|--------|-----------|------|-------|
| Resting Heart Rate | `resting_heart_rate` | bpm | Daily average |
| Heart Rate Average | `heart_rate_avg` | bpm | Daily average |
| Heart Rate Min | `heart_rate_min` | bpm | Daily minimum |
| Heart Rate Max | `heart_rate_max` | bpm | Daily maximum |
| HRV (Heart Rate Variability) | `hrv_avg` | ms | SDNN average |
| VO2 Max | `vo2_max` | mL/kg/min | Cardio fitness |
| Blood Oxygen (SpO2) | `blood_oxygen_avg` | % | Average |
| Blood Oxygen Min | `blood_oxygen_min` | % | Minimum reading |

### Body Measurements

| Metric | Field Name | Unit | Notes |
|--------|-----------|------|-------|
| Weight | `weight` | kg | Use Health app or scale |
| Body Fat % | `body_fat_percentage` | % | From smart scale |
| BMI | `body_mass_index` | - | Calculated |
| Wrist Temperature | `wrist_temperature` | °C | Deviation from baseline |

### Activity

| Metric | Field Name | Unit | Notes |
|--------|-----------|------|-------|
| Steps | `steps` | count | Daily total |
| Active Energy | `active_energy` | kcal | Burned during activity |
| Resting Energy | `resting_energy` | kcal | Basal metabolic |
| Exercise Minutes | `exercise_minutes` | minutes | Ring progress |
| Stand Hours | `stand_hours` | hours | Ring progress (max 24) |
| Flights Climbed | `flights_climbed` | count | Elevation gain |
| Walking/Running Distance | `distance_walking_running` | km | Daily total |

### Sleep (from previous night)

| Metric | Field Name | Unit | Notes |
|--------|-----------|------|-------|
| Total Sleep Duration | `sleep_duration_minutes` | minutes | Total time in bed |
| Deep Sleep | `sleep_deep_minutes` | minutes | iOS 16+ |
| Core Sleep | `sleep_core_minutes` | minutes | iOS 16+ |
| REM Sleep | `sleep_rem_minutes` | minutes | iOS 16+ |
| Awake Time | `sleep_awake_minutes` | minutes | Time awake |
| Respiratory Rate | `respiratory_rate_avg` | breaths/min | During sleep |

### Other

| Metric | Field Name | Unit | Notes |
|--------|-----------|------|-------|
| Mindful Minutes | `mindful_minutes` | minutes | Breathe/meditation |
| Blood Pressure Systolic | `blood_pressure_systolic` | mmHg | Manual entry |
| Blood Pressure Diastolic | `blood_pressure_diastolic` | mmHg | Manual entry |
| Water Intake | `water_intake_ml` | ml | If logged |
| Caffeine | `caffeine_mg` | mg | If logged |

---

## API Endpoints

All endpoints require Bearer token authentication:

```
Authorization: Bearer YOUR_API_TOKEN
```

### Daily Health Data

#### POST /v1/health
Submit daily health metrics. Existing data for the date will be updated (not overwritten).

**Request:**
```json
{
  "date": "2025-01-15",
  "steps": 8500,
  "resting_heart_rate": 58,
  "hrv_avg": 45,
  "vo2_max": 42.5,
  "blood_oxygen_avg": 98,
  "active_energy": 450,
  "exercise_minutes": 32,
  "stand_hours": 12,
  "sleep_duration_minutes": 420,
  "sleep_deep_minutes": 65,
  "sleep_core_minutes": 210,
  "sleep_rem_minutes": 95,
  "wrist_temperature": 0.3,
  "weight": 75.5,
  "source": "apple_watch"
}
```

**Response:**
```json
{
  "ok": true,
  "date": "2025-01-15",
  "updated_at": "2025-01-15T08:30:00.000Z"
}
```

#### GET /v1/health
Retrieve daily health data for a date range.

**Parameters:**
- `start` (optional): Start date (YYYY-MM-DD), default: 30 days ago
- `end` (optional): End date (YYYY-MM-DD), default: today

**Example:**
```
GET /v1/health?start=2025-01-01&end=2025-01-15
```

#### GET /v1/health/{date}
Get data for a specific date.

```
GET /v1/health/2025-01-15
```

#### DELETE /v1/health/{date}
Delete data for a specific date.

### Heart Rate Samples

#### POST /v1/health/heart-rate
Submit heart rate samples (single or batch).

**Single Sample:**
```json
{
  "recorded_at": "2025-01-15T10:30:00Z",
  "heart_rate": 72,
  "context": "rest",
  "source": "apple_watch"
}
```

**Batch (up to 1000 samples):**
```json
{
  "samples": [
    {"recorded_at": "2025-01-15T10:30:00Z", "heart_rate": 72},
    {"recorded_at": "2025-01-15T10:35:00Z", "heart_rate": 75}
  ]
}
```

#### GET /v1/health/heart-rate
Retrieve heart rate samples.

**Parameters:**
- `start` (optional): Start datetime (ISO 8601)
- `end` (optional): End datetime (ISO 8601)
- `limit` (optional): Max results (default: 1000, max: 10000)

### Sleep Sessions

#### POST /v1/health/sleep
Submit a sleep session.

```json
{
  "start_at": "2025-01-14T23:00:00Z",
  "end_at": "2025-01-15T07:00:00Z",
  "duration_minutes": 480,
  "deep_minutes": 70,
  "core_minutes": 220,
  "rem_minutes": 100,
  "awake_minutes": 30,
  "respiratory_rate_avg": 14.5,
  "heart_rate_avg": 52,
  "hrv_avg": 48
}
```

#### GET /v1/health/sleep
Retrieve sleep sessions.

### Workouts

#### POST /v1/health/workouts
Submit a workout.

```json
{
  "workout_type": "running",
  "start_at": "2025-01-15T07:00:00Z",
  "end_at": "2025-01-15T07:45:00Z",
  "duration_minutes": 45,
  "active_energy": 380,
  "heart_rate_avg": 145,
  "heart_rate_max": 172,
  "distance": 6.2,
  "elevation_gain": 45,
  "source": "apple_watch"
}
```

#### GET /v1/health/workouts
Retrieve workouts.

**Parameters:**
- `type` (optional): Filter by workout type (e.g., "running", "cycling")

### Health Summary

#### GET /v1/health/summary
Get a summary of recent health data including:
- Latest daily metrics
- 7-day averages
- Recent sleep sessions
- Recent workouts

---

## iOS Shortcuts Setup

### Step 1: Enable Health Data Access

1. Open the **Health** app on your iPhone
2. Tap your profile picture → **Privacy** → **Apps**
3. Find **Shortcuts** and enable read access for all desired metrics

> **Important:** The first time Shortcuts tries to read a metric, you'll be prompted to grant permission.

### Step 2: Create the Shortcut

1. Open the **Shortcuts** app
2. Tap **+** to create a new shortcut
3. Name it "Export Health Data"

### Step 3: Add Health Data Actions

For each metric you want to export:

1. Search for "Find Health Samples"
2. Configure:
   - **Type**: Select the metric (e.g., "Steps")
   - **Start Date**: "Start of Today" (for today) or "Start of Yesterday"
   - **End Date**: "Now" or "End of Yesterday"
   - **Unit**: Select appropriate unit
3. Add "Calculate Statistics" action:
   - **Operation**: Sum (for steps), Average (for heart rate)

### Step 4: Build the JSON Payload

1. Add "Dictionary" action
2. Add key-value pairs for each metric
3. Add "Get Contents of URL" action:
   - **URL**: Your API endpoint
   - **Method**: POST
   - **Headers**:
     - `Content-Type`: `application/json`
     - `Authorization`: `Bearer YOUR_API_TOKEN`
   - **Request Body**: JSON (your dictionary)

### Step 5: Set Up Automation

1. Go to **Automation** tab in Shortcuts
2. Tap **+** → **Create Personal Automation**
3. Choose trigger:
   - **Time of Day**: Set to run at a specific time (e.g., 8:00 AM)
   - **Charger**: When connected (good for morning routine)
4. Select your "Export Health Data" shortcut
5. Disable "Ask Before Running" for fully automatic export

> **Note:** The shortcut can only run when your iPhone is unlocked. Health data cannot be accessed when the phone is locked.

---

## Example Shortcuts

### Basic Daily Summary Shortcut

Here's a step-by-step guide to create a shortcut that exports daily health data:

```
1. Find Health Samples
   - Type: Steps
   - Start Date: Start of Today
   - End Date: Now
   → Save as "Steps Data"

2. Calculate Statistics
   - Input: Steps Data
   - Operation: Sum
   → Save as "Total Steps"

3. Find Health Samples
   - Type: Resting Heart Rate
   - Start Date: Start of Today
   - End Date: Now
   → Save as "Resting HR Data"

4. Calculate Statistics
   - Input: Resting HR Data
   - Operation: Average
   → Save as "Avg Resting HR"

5. Find Health Samples
   - Type: Heart Rate Variability SDNN
   - Start Date: Start of Today
   - End Date: Now
   → Save as "HRV Data"

6. Calculate Statistics
   - Input: HRV Data
   - Operation: Average
   → Save as "Avg HRV"

7. Find Health Samples
   - Type: Active Energy
   - Start Date: Start of Today
   - End Date: Now
   → Save as "Active Energy Data"

8. Calculate Statistics
   - Input: Active Energy Data
   - Operation: Sum
   → Save as "Total Active Energy"

9. Find Health Samples
   - Type: Exercise Minutes
   - Start Date: Start of Today
   - End Date: Now
   → Save as "Exercise Data"

10. Calculate Statistics
    - Input: Exercise Data
    - Operation: Sum
    → Save as "Total Exercise Minutes"

11. Format Date
    - Date: Current Date
    - Format: Custom: yyyy-MM-dd
    → Save as "Today Date"

12. Dictionary
    {
      "date": [Today Date],
      "steps": [Total Steps],
      "resting_heart_rate": [Avg Resting HR],
      "hrv_avg": [Avg HRV],
      "active_energy": [Total Active Energy],
      "exercise_minutes": [Total Exercise Minutes],
      "source": "apple_watch"
    }
    → Save as "Health Payload"

13. Get Contents of URL
    - URL: https://your-api.workers.dev/v1/health
    - Method: POST
    - Headers:
      - Content-Type: application/json
      - Authorization: Bearer YOUR_API_TOKEN
    - Request Body: JSON
    - Body: [Health Payload]

14. Show Notification (optional)
    - "Health data exported successfully!"
```

### Sleep Data Export Shortcut

Create a separate shortcut for sleep data (run in the morning):

```
1. Find Health Samples
   - Type: Sleep Analysis
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   - Group By: Day
   → Save as "Sleep Data"

2. Get Details of Health Samples
   - Input: Sleep Data
   - Get: Value
   → Save as "Sleep Duration"

3. Find Health Samples
   - Type: Sleep Deep (iOS 16+)
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   → Save as "Deep Sleep Data"

4. Calculate Statistics
   - Input: Deep Sleep Data
   - Operation: Sum
   → Save as "Deep Sleep Minutes"

... (repeat for Core and REM sleep)

5. Dictionary
    {
      "date": [Yesterday's Date],
      "sleep_duration_minutes": [Sleep Duration],
      "sleep_deep_minutes": [Deep Sleep Minutes],
      "sleep_core_minutes": [Core Sleep Minutes],
      "sleep_rem_minutes": [REM Sleep Minutes]
    }

6. Get Contents of URL
    - URL: https://your-api.workers.dev/v1/health
    - Method: POST
    ...
```

---

## Deployment Steps

### 1. Apply Database Migration

```bash
# Local development
npx wrangler d1 migrations apply personal_api --local

# Production
npx wrangler d1 migrations apply personal_api --remote
```

### 2. Deploy the Worker

```bash
npx wrangler deploy
```

### 3. Test the Endpoint

```bash
# Test POST
curl -X POST https://your-api.workers.dev/v1/health \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2025-01-15",
    "steps": 8500,
    "resting_heart_rate": 58
  }'

# Test GET
curl https://your-api.workers.dev/v1/health \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

### 4. Create iOS Shortcut

Follow the iOS Shortcuts Setup section above to create and test your shortcut.

### 5. Set Up Automation

Configure the shortcut to run automatically at your preferred time.

---

## Troubleshooting

### Common Issues

#### "Cannot read Health data"
- Ensure Shortcuts has permission to read Health data
- Go to Health app → Profile → Privacy → Apps → Shortcuts
- Enable all metrics you want to export

#### "Shortcut doesn't run automatically"
- iOS requires the phone to be unlocked for Health data access
- The shortcut may run but fail silently if locked
- Try using "When Charger is Connected" as trigger (usually unlocked)

#### "Invalid JSON" error
- Ensure all date values are in correct format (YYYY-MM-DD for dates, ISO 8601 for timestamps)
- Check that number values are actual numbers, not strings
- Use the Dictionary action to build JSON, not Text

#### "Missing authorization header"
- Add the Authorization header with `Bearer YOUR_API_TOKEN`
- Check for typos in the token

#### "Validation error"
- Check the field names match exactly (snake_case)
- Ensure numbers are within valid ranges (e.g., SpO2 0-100)
- Date format must be YYYY-MM-DD

### Tips for Reliable Data Collection

1. **Run at consistent times**: Set automation for the same time daily
2. **Use multiple shortcuts**: Separate daily data from sleep data
3. **Add error handling**: Use "If" action to check for empty values
4. **Log results**: Save response to Files app for debugging
5. **Manual fallback**: Run shortcuts manually if automation fails

### Wrist Temperature Notes

Apple Watch Series 8 wrist temperature:
- Takes 5 nights to establish baseline
- Shows **deviation** from baseline (can be negative)
- Only available after sleep tracking
- Stored in Health as "Wrist Temperature"
- Values typically range from -0.5°C to +1.0°C

---

## Field Reference

### Data Types by iOS Shortcuts "Find Health Samples"

| Health Sample Type | API Field | Notes |
|-------------------|-----------|-------|
| Steps | `steps` | Sum for day |
| Resting Heart Rate | `resting_heart_rate` | Average |
| Heart Rate Variability SDNN | `hrv_avg` | Average in ms |
| VO2 Max | `vo2_max` | Latest value |
| Blood Oxygen | `blood_oxygen_avg` | Average % |
| Active Energy | `active_energy` | Sum in kcal |
| Basal Energy Burned | `resting_energy` | Sum in kcal |
| Exercise Minutes | `exercise_minutes` | Sum |
| Stand Hours | `stand_hours` | Sum |
| Flights Climbed | `flights_climbed` | Sum |
| Walking + Running Distance | `distance_walking_running` | Sum in km |
| Sleep Analysis | `sleep_duration_minutes` | Total duration |
| Sleep Deep | `sleep_deep_minutes` | iOS 16+ |
| Sleep Core | `sleep_core_minutes` | iOS 16+ |
| Sleep REM | `sleep_rem_minutes` | iOS 16+ |
| Sleep Awake | `sleep_awake_minutes` | iOS 16+ |
| Respiratory Rate | `respiratory_rate_avg` | Average |
| Weight | `weight` | Latest in kg |
| Body Fat Percentage | `body_fat_percentage` | Latest % |
| Body Mass Index | `body_mass_index` | Latest |
| Wrist Temperature | `wrist_temperature` | Deviation in °C |
| Mindful Minutes | `mindful_minutes` | Sum |
| Blood Pressure Systolic | `blood_pressure_systolic` | Latest |
| Blood Pressure Diastolic | `blood_pressure_diastolic` | Latest |
| Dietary Water | `water_intake_ml` | Sum in ml |
| Caffeine | `caffeine_mg` | Sum in mg |

---

## Security Considerations

1. **Keep your API token secret**: Never share it publicly
2. **Use HTTPS**: The Cloudflare Worker automatically serves over HTTPS
3. **Health data is sensitive**: Consider who has access to your API
4. **Token rotation**: Change your API token periodically

---

## Version History

- **v1.7.0**: Added Apple Health data export endpoints
  - `/v1/health` - Daily health metrics
  - `/v1/health/heart-rate` - Heart rate samples
  - `/v1/health/sleep` - Sleep sessions
  - `/v1/health/workouts` - Workout data
  - `/v1/health/summary` - Health summary
