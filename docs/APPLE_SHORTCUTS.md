# Apple Shortcuts Quick Start Guide

A practical guide to creating iOS Shortcuts that export your Apple Health data to your personal API.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start Templates](#quick-start-templates)
- [Available Endpoints](#available-endpoints)
- [Step-by-Step Tutorials](#step-by-step-tutorials)
- [Automation Setup](#automation-setup)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Requirements
- iPhone with iOS 16+ (for sleep stages)
- Apple Watch (recommended for comprehensive data)
- iOS Shortcuts app (pre-installed)
- Your API endpoint: `https://api.anuragd.me`
- Your API token: `c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2`

### Enable Health Data Access

1. Open **Health** app on your iPhone
2. Tap your profile picture → **Privacy** → **Apps**
3. Find **Shortcuts** and enable **read access** for all desired metrics

> **Note:** The first time Shortcuts tries to read a metric, you'll be prompted to grant permission.

---

## Quick Start Templates

### Template 1: Daily Health Summary (Recommended)

**What it does:** Exports your daily activity, heart rate, and body measurements.

**When to run:** Once per day (e.g., 8:00 AM)

**Shortcut Steps:**

```
1. Format Date
   - Date: Current Date
   - Format: Custom → yyyy-MM-dd
   → Variable: TodayDate

2. Find Health Samples
   - Type: Steps
   - Start Date: Start of Today
   - End Date: Now
   → Variable: StepsData

3. Calculate Statistics
   - Input: StepsData
   - Operation: Sum
   → Variable: TotalSteps

4. Find Health Samples
   - Type: Resting Heart Rate
   - Start Date: Start of Today
   - End Date: Now
   → Variable: RestingHRData

5. Calculate Statistics
   - Input: RestingHRData
   - Operation: Average
   → Variable: AvgRestingHR

6. Find Health Samples
   - Type: Active Energy
   - Start Date: Start of Today
   - End Date: Now
   → Variable: ActiveEnergyData

7. Calculate Statistics
   - Input: ActiveEnergyData
   - Operation: Sum
   → Variable: TotalActiveEnergy

8. Find Health Samples
   - Type: Exercise Minutes
   - Start Date: Start of Today
   - End Date: Now
   → Variable: ExerciseData

9. Calculate Statistics
   - Input: ExerciseData
   - Operation: Sum
   → Variable: TotalExerciseMinutes

10. Find Health Samples
    - Type: Weight
    - Start Date: Start of Today
    - End Date: Now
    - Sort By: Latest First
    - Limit: 1
    → Variable: WeightData

11. Get Details of Health Sample
    - Input: WeightData
    - Get: Value
    → Variable: CurrentWeight

12. Dictionary
    {
      "date": TodayDate,
      "steps": TotalSteps,
      "resting_heart_rate": AvgRestingHR,
      "active_energy": TotalActiveEnergy,
      "exercise_minutes": TotalExerciseMinutes,
      "weight": CurrentWeight,
      "source": "apple_watch"
    }
    → Variable: HealthPayload

13. Get Contents of URL
    - URL: https://api.anuragd.me/v1/health
    - Method: POST
    - Headers:
      * Content-Type: application/json
      * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
    - Request Body: JSON
    - Body: HealthPayload
    → Variable: Response

14. Show Notification
    - Title: "Health Data Exported"
    - Body: "✓ Daily health data saved successfully!"
```

---

### Template 2: Sleep Data Export

**What it does:** Exports your sleep data from the previous night.

**When to run:** Morning (e.g., 9:00 AM, after you wake up)

**Shortcut Steps:**

```
1. Format Date
   - Date: Current Date
   - Subtract: 1 day
   - Format: Custom → yyyy-MM-dd
   → Variable: YesterdayDate

2. Find Health Samples
   - Type: Sleep Analysis
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   → Variable: SleepData

3. Calculate Statistics
   - Input: SleepData
   - Operation: Sum
   → Variable: TotalSleepMinutes

4. Find Health Samples
   - Type: Sleep Deep (iOS 16+)
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   → Variable: DeepSleepData

5. Calculate Statistics
   - Input: DeepSleepData
   - Operation: Sum
   → Variable: DeepSleepMinutes

6. Find Health Samples
   - Type: Sleep Core (iOS 16+)
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   → Variable: CoreSleepData

7. Calculate Statistics
   - Input: CoreSleepData
   - Operation: Sum
   → Variable: CoreSleepMinutes

8. Find Health Samples
   - Type: Sleep REM (iOS 16+)
   - Start Date: Yesterday at 6:00 PM
   - End Date: Today at 12:00 PM
   → Variable: REMSleepData

9. Calculate Statistics
   - Input: REMSleepData
   - Operation: Sum
   → Variable: REMSleepMinutes

10. Dictionary
    {
      "date": YesterdayDate,
      "sleep_duration_minutes": TotalSleepMinutes,
      "sleep_deep_minutes": DeepSleepMinutes,
      "sleep_core_minutes": CoreSleepMinutes,
      "sleep_rem_minutes": REMSleepMinutes,
      "source": "apple_watch"
    }
    → Variable: SleepPayload

11. Get Contents of URL
    - URL: https://api.anuragd.me/v1/health
    - Method: POST
    - Headers:
      * Content-Type: application/json
      * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
    - Request Body: JSON
    - Body: SleepPayload

12. Show Notification
    - Title: "Sleep Data Exported"
    - Body: "✓ Sleep data from last night saved!"
```

---

### Template 3: Workout Export (After Exercise)

**What it does:** Exports your most recent workout.

**When to run:** Manually after a workout, or automatically when workout ends.

**Shortcut Steps:**

```
1. Find Health Samples
   - Type: Workouts
   - Start Date: Start of Today
   - End Date: Now
   - Sort By: Latest First
   - Limit: 1
   → Variable: LatestWorkout

2. Get Details of Health Sample
   - Input: LatestWorkout
   - Get: Workout Type
   → Variable: WorkoutType

3. Get Details of Health Sample
   - Input: LatestWorkout
   - Get: Start Date
   → Variable: WorkoutStart

4. Get Details of Health Sample
   - Input: LatestWorkout
   - Get: End Date
   → Variable: WorkoutEnd

5. Get Details of Health Sample
   - Input: LatestWorkout
   - Get: Duration
   → Variable: WorkoutDuration

6. Get Details of Health Sample
   - Input: LatestWorkout
   - Get: Active Energy
   → Variable: WorkoutEnergy

7. Format Date
   - Date: WorkoutStart
   - Format: ISO 8601
   → Variable: StartISO

8. Format Date
   - Date: WorkoutEnd
   - Format: ISO 8601
   → Variable: EndISO

9. Calculate
   - WorkoutDuration / 60
   → Variable: DurationMinutes

10. Dictionary
    {
      "workout_type": WorkoutType,
      "start_at": StartISO,
      "end_at": EndISO,
      "duration_minutes": DurationMinutes,
      "active_energy": WorkoutEnergy,
      "source": "apple_watch"
    }
    → Variable: WorkoutPayload

11. Get Contents of URL
    - URL: https://api.anuragd.me/v1/health/workouts
    - Method: POST
    - Headers:
      * Content-Type: application/json
      * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
    - Request Body: JSON
    - Body: WorkoutPayload

12. Show Notification
    - Title: "Workout Saved"
    - Body: "✓ Workout data exported!"
```

---

## Available Endpoints

### 1. Daily Health Data - `POST /v1/health`

**Best for:** Daily aggregated metrics (activity, heart rate, body measurements, sleep summary)

**Required fields:**
- `date` (YYYY-MM-DD format)

**Optional fields (35+ metrics):**

#### Heart & Cardiovascular
- `resting_heart_rate` (bpm)
- `heart_rate_avg` (bpm)
- `heart_rate_min` (bpm)
- `heart_rate_max` (bpm)
- `hrv_avg` (ms - Heart Rate Variability)
- `vo2_max` (mL/kg/min)
- `blood_oxygen_avg` (%)
- `blood_oxygen_min` (%)

#### Body Measurements
- `weight` (kg)
- `body_fat_percentage` (%)
- `body_mass_index` (BMI)
- `wrist_temperature` (°C - deviation from baseline)

#### Activity
- `steps` (count)
- `active_energy` (kcal)
- `resting_energy` (kcal)
- `exercise_minutes` (minutes)
- `stand_hours` (hours, max 24)
- `flights_climbed` (count)
- `distance_walking_running` (km)

#### Sleep (from previous night)
- `sleep_duration_minutes` (minutes)
- `sleep_deep_minutes` (minutes)
- `sleep_core_minutes` (minutes)
- `sleep_rem_minutes` (minutes)
- `sleep_awake_minutes` (minutes)
- `respiratory_rate_avg` (breaths/min)

#### Other
- `mindful_minutes` (minutes)
- `blood_pressure_systolic` (mmHg)
- `blood_pressure_diastolic` (mmHg)
- `water_intake_ml` (ml)
- `caffeine_mg` (mg)

#### Metadata
- `source` (string - e.g., "apple_watch", "manual")
- `notes` (string - any notes)

**Example:**
```json
{
  "date": "2026-01-11",
  "steps": 8500,
  "resting_heart_rate": 58,
  "weight": 75.5,
  "active_energy": 450,
  "exercise_minutes": 32,
  "source": "apple_watch"
}
```

**Key Feature:** Uses UPSERT logic - you can run this multiple times per day with different metrics and they'll merge (not overwrite)!

---

### 2. Heart Rate Samples - `POST /v1/health/heart-rate`

**Best for:** Detailed heart rate tracking throughout the day

**Single sample:**
```json
{
  "recorded_at": "2026-01-11T10:30:00Z",  // Required (ISO 8601)
  "heart_rate": 72,                        // Required (bpm)
  "context": "rest",                       // Optional
  "source": "apple_watch"                  // Optional
}
```

**Batch (up to 1000 samples):**
```json
{
  "samples": [
    {"recorded_at": "2026-01-11T10:30:00Z", "heart_rate": 72},
    {"recorded_at": "2026-01-11T10:35:00Z", "heart_rate": 75},
    {"recorded_at": "2026-01-11T10:40:00Z", "heart_rate": 78}
  ]
}
```

---

### 3. Sleep Sessions - `POST /v1/health/sleep`

**Best for:** Detailed sleep session tracking (separate from daily summary)

**Required fields:**
- `start_at` (ISO 8601 timestamp)
- `end_at` (ISO 8601 timestamp)

**Optional fields:**
- `duration_minutes` (integer)
- `deep_minutes` (integer)
- `core_minutes` (integer)
- `rem_minutes` (integer)
- `awake_minutes` (integer)
- `sleep_quality_score` (0-100)
- `respiratory_rate_avg` (breaths/min)
- `heart_rate_avg` (bpm)
- `hrv_avg` (ms)

**Example:**
```json
{
  "start_at": "2026-01-10T23:00:00Z",
  "end_at": "2026-01-11T07:00:00Z",
  "duration_minutes": 480,
  "deep_minutes": 70,
  "core_minutes": 220,
  "rem_minutes": 100,
  "awake_minutes": 30
}
```

---

### 4. Workouts - `POST /v1/health/workouts`

**Best for:** Individual workout sessions

**Required fields:**
- `workout_type` (string - e.g., "running", "cycling", "strength")
- `start_at` (ISO 8601 timestamp)
- `end_at` (ISO 8601 timestamp)

**Optional fields:**
- `duration_minutes` (integer)
- `active_energy` (kcal)
- `heart_rate_avg` (bpm)
- `heart_rate_max` (bpm)
- `distance` (km)
- `elevation_gain` (meters)
- `source` (string)
- `notes` (string)

**Example:**
```json
{
  "workout_type": "running",
  "start_at": "2026-01-11T07:00:00Z",
  "end_at": "2026-01-11T07:45:00Z",
  "duration_minutes": 45,
  "active_energy": 380,
  "heart_rate_avg": 145,
  "heart_rate_max": 172,
  "distance": 6.2,
  "source": "apple_watch"
}
```

---

## Step-by-Step Tutorials

### Tutorial 1: Create Your First Health Export Shortcut

#### Step 1: Create New Shortcut
1. Open **Shortcuts** app
2. Tap **+** (top right)
3. Tap **Add Action**

#### Step 2: Get Today's Date
1. Search for "Format Date"
2. Tap "Format Date"
3. Set:
   - Date: **Current Date**
   - Format: **Custom**
   - Custom Format: `yyyy-MM-dd`
4. Long-press the action → Rename → "TodayDate"

#### Step 3: Get Steps Data
1. Search for "Find Health Samples"
2. Tap "Find Health Samples"
3. Configure:
   - Type: **Steps**
   - Start Date: **Start of Today**
   - End Date: **Now**
4. Rename → "StepsData"

#### Step 4: Calculate Total Steps
1. Search for "Calculate Statistics"
2. Tap "Calculate Statistics"
3. Set:
   - Input: **StepsData**
   - Operation: **Sum**
4. Rename → "TotalSteps"

#### Step 5: Build JSON Payload
1. Search for "Dictionary"
2. Tap "Dictionary"
3. Add keys:
   - Key: `date`, Value: Tap and select **TodayDate** variable
   - Key: `steps`, Value: Tap and select **TotalSteps** variable
   - Key: `source`, Value: Type `apple_watch` (as text)
4. Rename → "HealthPayload"

#### Step 6: Send to API
1. Search for "Get Contents of URL"
2. Tap "Get Contents of URL"
3. Configure:
   - URL: `https://api.anuragd.me/v1/health`
   - Tap "Show More"
   - Method: **POST**
   - Headers: Tap "Add new field"
     - Key: `Content-Type`, Value: `application/json`
     - Key: `Authorization`, Value: `Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2`
   - Request Body: **JSON**
   - Body: Tap and select **HealthPayload** variable

#### Step 7: Add Confirmation
1. Search for "Show Notification"
2. Tap "Show Notification"
3. Set:
   - Title: `Health Data Exported`
   - Body: `✓ Data saved successfully!`

#### Step 8: Test It!
1. Tap "Done" (top right)
2. Name your shortcut: "Export Health Data"
3. Tap the shortcut to run it
4. Grant Health permissions when prompted
5. You should see "Health Data Exported" notification!

---

### Tutorial 2: Add More Metrics to Your Shortcut

Want to track more than just steps? Here's how to add additional metrics:

#### Adding Heart Rate:
**After Step 4 (Calculate Total Steps), add:**

```
5a. Find Health Samples
    - Type: Resting Heart Rate
    - Start Date: Start of Today
    - End Date: Now
    → Rename: RestingHRData

5b. Calculate Statistics
    - Input: RestingHRData
    - Operation: Average
    → Rename: AvgRestingHR
```

**Then update your Dictionary (Step 5):**
```
Add new key:
- Key: resting_heart_rate
- Value: AvgRestingHR variable
```

#### Adding Weight:
```
Find Health Samples
- Type: Weight
- Start Date: Start of Today
- End Date: Now
- Sort By: Latest First
- Limit: 1
→ Rename: WeightData

Get Details of Health Sample
- Input: WeightData
- Get: Value
→ Rename: CurrentWeight
```

**Add to Dictionary:**
```
- Key: weight
- Value: CurrentWeight variable
```

#### Adding Active Energy:
```
Find Health Samples
- Type: Active Energy
- Start Date: Start of Today
- End Date: Now
→ Rename: ActiveEnergyData

Calculate Statistics
- Input: ActiveEnergyData
- Operation: Sum
→ Rename: TotalActiveEnergy
```

**Add to Dictionary:**
```
- Key: active_energy
- Value: TotalActiveEnergy variable
```

---

## Automation Setup

### Option 1: Time-Based Automation (Recommended)

**Best for:** Daily health summary

1. Open **Shortcuts** app
2. Tap **Automation** tab (bottom)
3. Tap **+** (top right)
4. Tap **Create Personal Automation**
5. Choose **Time of Day**
6. Set time (e.g., 8:00 AM)
7. Set frequency: **Daily**
8. Tap **Next**
9. Tap **Add Action**
10. Search for your shortcut name
11. Select **Run Shortcut**
12. Choose your "Export Health Data" shortcut
13. Tap **Next**
14. **IMPORTANT:** Toggle OFF "Ask Before Running"
15. Tap **Done**

> **Note:** Your iPhone must be unlocked for the automation to access Health data.

---

### Option 2: Charger-Based Automation

**Best for:** Morning routine (when you unplug your phone)

1. Create Personal Automation
2. Choose **Charger**
3. Select **Is Disconnected**
4. Add time condition (optional): Between 7:00 AM - 10:00 AM
5. Add your shortcut
6. Disable "Ask Before Running"

---

### Option 3: Workout-Based Automation

**Best for:** Automatic workout export

1. Create Personal Automation
2. Choose **Workout**
3. Select workout types (or "Any Workout")
4. Choose **When Workout Ends**
5. Add your workout export shortcut
6. Disable "Ask Before Running"

---

## Troubleshooting

### Common Issues

#### "Cannot read Health data"
**Solution:**
1. Open **Health** app
2. Tap profile → **Privacy** → **Apps** → **Shortcuts**
3. Enable read access for all metrics you're trying to export

---

#### "Shortcut doesn't run automatically"
**Possible causes:**
- iPhone is locked (Health data requires unlocked phone)
- Automation has "Ask Before Running" enabled
- Low Power Mode is on (can delay automations)

**Solution:**
- Use "Charger Disconnected" trigger (usually unlocked)
- Ensure "Ask Before Running" is OFF
- Disable Low Power Mode during automation times

---

#### "Invalid JSON" error
**Solution:**
- Ensure you're using the **Dictionary** action, not Text
- Check that date format is `yyyy-MM-dd` (not `MM/dd/yyyy`)
- Verify all number values are actual numbers (not text)

---

#### "Invalid date format" error
**Solution:**
- For `date` field: Use `yyyy-MM-dd` format
- For `recorded_at`, `start_at`, `end_at`: Use ISO 8601 format
  - Use "Format Date" action with "ISO 8601" format

---

#### "Missing authorization header"
**Solution:**
- Verify Authorization header is set correctly:
  - Key: `Authorization`
  - Value: `Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2`
- Check for typos in the token

---

#### "Validation error" or "Invalid value"
**Common causes:**
- Heart rate values must be positive numbers
- SpO2 (blood oxygen) must be 0-100
- Stand hours must be 0-24
- Date must be YYYY-MM-DD format

**Solution:**
- Check the [Available Endpoints](#available-endpoints) section for valid ranges
- Use "Calculate Statistics" for aggregated values
- Use "Get Details" for single values

---

#### No data showing up in API
**Solution:**
1. Test manually first (tap shortcut to run)
2. Check notification appears
3. Verify Health permissions are granted
4. Test with a simple shortcut (just date + steps)
5. Add metrics one at a time to identify issues

---

### Tips for Reliable Data Collection

1. **Start simple** - Begin with just steps and date, then add more metrics
2. **Test manually first** - Run shortcut manually before setting up automation
3. **Use consistent times** - Run automation at the same time daily
4. **Check permissions** - Verify Health access for each metric
5. **Monitor notifications** - Enable notifications to confirm successful exports
6. **Use multiple shortcuts** - Separate daily data, sleep, and workouts
7. **Handle missing data** - Some metrics may not have data every day (that's okay!)

---

## Health Sample Types Reference

### iOS Shortcuts "Find Health Samples" Types

| Shortcuts Name | API Field | Operation | Notes |
|----------------|-----------|-----------|-------|
| Steps | `steps` | Sum | Daily total |
| Resting Heart Rate | `resting_heart_rate` | Average | Daily average |
| Heart Rate | `heart_rate_avg` | Average | All readings |
| Heart Rate Variability SDNN | `hrv_avg` | Average | In milliseconds |
| VO2 Max | `vo2_max` | Latest | Cardio fitness |
| Blood Oxygen | `blood_oxygen_avg` | Average | SpO2 percentage |
| Active Energy | `active_energy` | Sum | Calories burned |
| Basal Energy Burned | `resting_energy` | Sum | Resting calories |
| Exercise Minutes | `exercise_minutes` | Sum | Ring progress |
| Stand Hours | `stand_hours` | Sum | Max 24 |
| Flights Climbed | `flights_climbed` | Sum | Elevation |
| Walking + Running Distance | `distance_walking_running` | Sum | In kilometers |
| Sleep Analysis | `sleep_duration_minutes` | Sum | Total sleep |
| Sleep Deep | `sleep_deep_minutes` | Sum | iOS 16+ |
| Sleep Core | `sleep_core_minutes` | Sum | iOS 16+ |
| Sleep REM | `sleep_rem_minutes` | Sum | iOS 16+ |
| Sleep Awake | `sleep_awake_minutes` | Sum | Time awake |
| Respiratory Rate | `respiratory_rate_avg` | Average | During sleep |
| Weight | `weight` | Latest | In kilograms |
| Body Fat Percentage | `body_fat_percentage` | Latest | Percentage |
| Body Mass Index | `body_mass_index` | Latest | BMI value |
| Wrist Temperature | `wrist_temperature` | Latest | Deviation in °C |
| Mindful Minutes | `mindful_minutes` | Sum | Meditation |
| Blood Pressure Systolic | `blood_pressure_systolic` | Latest | mmHg |
| Blood Pressure Diastolic | `blood_pressure_diastolic` | Latest | mmHg |
| Dietary Water | `water_intake_ml` | Sum | Milliliters |
| Caffeine | `caffeine_mg` | Sum | Milligrams |

---

## Advanced Tips

### Batch Export Multiple Days

If you miss a day, you can create a shortcut that exports multiple days:

```
1. Repeat with Each (number from 0 to 6)
   
   2. Get date from "Current Date" minus "Repeat Index" days
   
   3. Format date as yyyy-MM-dd
   
   4. Find Health Samples for that date
   
   5. Build dictionary and POST to API
   
   6. Wait 1 second (to avoid rate limiting)
```

---

### Error Handling

Add error handling to your shortcut:

```
After "Get Contents of URL":

1. Get Dictionary Value
   - Key: "ok"
   - Get Value for: ok
   
2. If "ok" equals true
   - Show Notification: "Success!"
   
3. Otherwise
   - Show Notification: "Failed to export"
   - Show Alert with Response content
```

---

### Logging for Debugging

Save responses to Files app for debugging:

```
After "Get Contents of URL":

1. Set Variable
   - Variable: Response
   - Value: Contents of URL result

2. Save File
   - File: Response
   - Destination: iCloud Drive/Shortcuts/Logs/
   - Filename: health-export-{Current Date}.json
```

---

## Security Notes

1. **Keep your API token secret** - Never share it publicly
2. **Use HTTPS** - Your API automatically uses HTTPS
3. **Health data is sensitive** - Be careful who has access to your API
4. **Token rotation** - Consider changing your API token periodically
5. **Backup shortcuts** - Export your shortcuts to iCloud for backup

---

## Next Steps

1. **Start with Template 1** - Daily Health Summary
2. **Test manually** - Run it a few times to verify it works
3. **Set up automation** - Configure time-based automation
4. **Add more metrics** - Gradually add more health metrics
5. **Create additional shortcuts** - Sleep data, workouts, etc.
6. **Monitor your data** - Use the API GET endpoints to view your data

---

## Support

If you encounter issues:
1. Check the [Troubleshooting](#troubleshooting) section
2. Test with a minimal shortcut (just date + steps)
3. Verify Health permissions are granted
4. Check API token is correct
5. Review the full documentation: `APPLE_HEALTH_EXPORT.md`

---

**Happy tracking! 🎉**
