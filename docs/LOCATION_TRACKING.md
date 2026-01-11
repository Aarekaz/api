# Location Tracking with Apple Shortcuts

Track your location history using iOS Shortcuts and your personal API.

## Table of Contents

- [Overview](#overview)
- [API Endpoints](#api-endpoints)
- [iOS Shortcuts Setup](#ios-shortcuts-setup)
- [Quick Start Templates](#quick-start-templates)
- [Use Cases](#use-cases)
- [Privacy & Security](#privacy--security)

---

## Overview

The location tracking endpoint allows you to record your GPS coordinates with timestamps using iOS Shortcuts. This is useful for:

- **Travel logging** - Track where you've been on trips
- **Commute tracking** - Record your daily commute patterns
- **Location-based automation** - Trigger actions based on location
- **Personal analytics** - Analyze your movement patterns
- **Location history** - Build your own location timeline

### Architecture

```
iPhone GPS → iOS Shortcuts → POST /v1/location → Cloudflare Worker → D1 Database
```

---

## API Endpoints

### POST /v1/location

Record a location point.

**Required fields:**
- `latitude` (number, -90 to 90)
- `longitude` (number, -180 to 180)
- `recorded_at` (ISO 8601 timestamp)

**Optional fields:**
- `altitude` (number, meters above sea level)
- `accuracy` (number, horizontal accuracy in meters)
- `speed` (number, meters per second)
- `heading` (number, 0-360 degrees)
- `address` (string, full address)
- `city` (string)
- `state` (string)
- `country` (string)
- `postal_code` (string)
- `label` (string, e.g., "home", "work", "gym", "travel")
- `notes` (string)
- `source` (string, e.g., "ios_shortcuts")

**Example:**
```bash
curl -X POST https://api.anuragd.me/v1/location \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 40.7128,
    "longitude": -74.0060,
    "altitude": 10.5,
    "accuracy": 5.0,
    "recorded_at": "2026-01-11T10:30:00Z",
    "label": "work",
    "source": "ios_shortcuts"
  }'
```

**Response:**
```json
{
  "ok": true,
  "id": 1,
  "recorded_at": "2026-01-11T10:30:00Z",
  "created_at": "2026-01-11T10:30:15.000Z"
}
```

---

### GET /v1/location

Retrieve location history.

**Query parameters:**
- `start` (optional): Start timestamp (ISO 8601), default: 30 days ago
- `end` (optional): End timestamp (ISO 8601), default: now
- `label` (optional): Filter by label (e.g., "work", "home")
- `limit` (optional): Max results (default: 1000, max: 10000)

**Example:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location?label=work&limit=10"
```

**Response:**
```json
{
  "start": "2025-12-12T10:00:00Z",
  "end": "2026-01-11T10:00:00Z",
  "label": "work",
  "count": 10,
  "locations": [
    {
      "id": 1,
      "latitude": 40.7128,
      "longitude": -74.0060,
      "altitude": 10.5,
      "accuracy": 5.0,
      "recorded_at": "2026-01-11T10:30:00Z",
      "label": "work",
      "source": "ios_shortcuts",
      "created_at": "2026-01-11T10:30:15.000Z"
    }
  ]
}
```

---

### GET /v1/location/latest

Get your most recent location.

**Example:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location/latest"
```

**Response:**
```json
{
  "id": 1,
  "latitude": 40.7128,
  "longitude": -74.0060,
  "recorded_at": "2026-01-11T10:30:00Z",
  "label": "work"
}
```

---

### DELETE /v1/location/:id

Delete a specific location record.

**Example:**
```bash
curl -X DELETE -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location/1"
```

---

## iOS Shortcuts Setup

### Prerequisites

1. **Enable Location Services:**
   - Settings → Privacy & Security → Location Services
   - Enable for **Shortcuts** app
   - Set to "While Using" or "Always" (your choice)

2. **Your API credentials:**
   - Endpoint: `https://api.anuragd.me/v1/location`
   - Token: `c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2`

---

## Quick Start Templates

### Template 1: Simple Location Logger

**What it does:** Records your current location with a timestamp.

**Shortcut Steps:**

```
1. Get Current Location
   → Variable: CurrentLocation

2. Get Details of Location
   - Input: CurrentLocation
   - Get: Latitude
   → Variable: Latitude

3. Get Details of Location
   - Input: CurrentLocation
   - Get: Longitude
   → Variable: Longitude

4. Get Details of Location
   - Input: CurrentLocation
   - Get: Altitude
   → Variable: Altitude

5. Format Date
   - Date: Current Date
   - Format: ISO 8601
   → Variable: Timestamp

6. Dictionary
   {
     "latitude": Latitude,
     "longitude": Longitude,
     "altitude": Altitude,
     "recorded_at": Timestamp,
     "source": "ios_shortcuts"
   }
   → Variable: LocationPayload

7. Get Contents of URL
   - URL: https://api.anuragd.me/v1/location
   - Method: POST
   - Headers:
     * Content-Type: application/json
     * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
   - Request Body: JSON
   - Body: LocationPayload

8. Show Notification
   - Title: "Location Saved"
   - Body: "📍 Location recorded successfully!"
```

---

### Template 2: Location Logger with Label

**What it does:** Records location and prompts you to add a label (e.g., "home", "work", "gym").

**Shortcut Steps:**

```
1. Get Current Location
   → Variable: CurrentLocation

2. Get Details of Location
   - Input: CurrentLocation
   - Get: Latitude
   → Variable: Latitude

3. Get Details of Location
   - Input: CurrentLocation
   - Get: Longitude
   → Variable: Longitude

4. Get Details of Location
   - Input: CurrentLocation
   - Get: Altitude
   → Variable: Altitude

5. Choose from Menu
   - Prompt: "What is this location?"
   - Options:
     * Home
     * Work
     * Gym
     * Restaurant
     * Travel
     * Other
   → Variable: LocationLabel

6. Format Date
   - Date: Current Date
   - Format: ISO 8601
   → Variable: Timestamp

7. Dictionary
   {
     "latitude": Latitude,
     "longitude": Longitude,
     "altitude": Altitude,
     "recorded_at": Timestamp,
     "label": LocationLabel,
     "source": "ios_shortcuts"
   }
   → Variable: LocationPayload

8. Get Contents of URL
   - URL: https://api.anuragd.me/v1/location
   - Method: POST
   - Headers:
     * Content-Type: application/json
     * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
   - Request Body: JSON
   - Body: LocationPayload

9. Show Notification
   - Title: "Location Saved"
   - Body: "📍 Saved as: LocationLabel"
```

---

### Template 3: Automatic Location Logger (Arrive/Leave)

**What it does:** Automatically logs your location when you arrive at or leave a specific place.

**Setup:**

1. Create the location logging shortcut (Template 1 or 2)
2. Go to **Automation** tab
3. Tap **+** → **Create Personal Automation**
4. Choose **Arrive** or **Leave**
5. Tap **Choose** and select a location on the map
6. Set radius (e.g., 100 meters)
7. Tap **Next**
8. Add your location logging shortcut
9. **IMPORTANT:** Toggle OFF "Ask Before Running"
10. Tap **Done**

**Pro tip:** Create separate automations for:
- Arriving at work
- Leaving work
- Arriving home
- Leaving home

---

### Template 4: Travel Logger with Notes

**What it does:** Records location with the ability to add notes (great for travel).

**Shortcut Steps:**

```
1. Get Current Location
   → Variable: CurrentLocation

2. Get Details of Location
   - Input: CurrentLocation
   - Get: Latitude
   → Variable: Latitude

3. Get Details of Location
   - Input: CurrentLocation
   - Get: Longitude
   → Variable: Longitude

4. Get Details of Location
   - Input: CurrentLocation
   - Get: Street Address
   → Variable: Address

5. Get Details of Location
   - Input: CurrentLocation
   - Get: City
   → Variable: City

6. Get Details of Location
   - Input: CurrentLocation
   - Get: State
   → Variable: State

7. Get Details of Location
   - Input: CurrentLocation
   - Get: Country
   → Variable: Country

8. Ask for Input
   - Prompt: "Add a note about this location"
   - Input Type: Text
   → Variable: Notes

9. Format Date
   - Date: Current Date
   - Format: ISO 8601
   → Variable: Timestamp

10. Dictionary
    {
      "latitude": Latitude,
      "longitude": Longitude,
      "recorded_at": Timestamp,
      "address": Address,
      "city": City,
      "state": State,
      "country": Country,
      "notes": Notes,
      "label": "travel",
      "source": "ios_shortcuts"
    }
    → Variable: LocationPayload

11. Get Contents of URL
    - URL: https://api.anuragd.me/v1/location
    - Method: POST
    - Headers:
      * Content-Type: application/json
      * Authorization: Bearer c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
    - Request Body: JSON
    - Body: LocationPayload

12. Show Notification
    - Title: "Travel Location Saved"
    - Body: "📍 City, Country"
```

---

### Template 5: Commute Tracker

**What it does:** Tracks your commute start and end locations.

**Create two shortcuts:**

**Shortcut 1: "Start Commute"**
```
1. Get Current Location
2. Extract latitude, longitude
3. Format timestamp
4. Dictionary with label: "commute_start"
5. POST to API
6. Show notification: "🚗 Commute started"
```

**Shortcut 2: "End Commute"**
```
1. Get Current Location
2. Extract latitude, longitude
3. Format timestamp
4. Dictionary with label: "commute_end"
5. POST to API
6. Show notification: "🏁 Commute ended"
```

**Automation:**
- Run "Start Commute" when leaving home (weekday mornings)
- Run "End Commute" when arriving at work

---

## Use Cases

### 1. Travel Diary
Log locations during trips with notes about what you did there.

**Labels:** `travel`, `vacation`, `business_trip`

---

### 2. Commute Analytics
Track your daily commute to analyze patterns and optimize routes.

**Labels:** `commute_start`, `commute_end`, `work`, `home`

---

### 3. Fitness Tracking
Log locations of your runs, hikes, or bike rides.

**Labels:** `running`, `hiking`, `cycling`, `gym`

---

### 4. Restaurant Tracker
Save locations of restaurants you visit with notes about the experience.

**Labels:** `restaurant`, `cafe`, `food`

---

### 5. Location-Based Reminders
Use location data to trigger reminders or actions.

**Labels:** `grocery_store`, `pharmacy`, `bank`

---

### 6. Personal Heatmap
Build a heatmap of places you frequent over time.

**Labels:** Custom labels for different types of places

---

## Privacy & Security

### Data Privacy

✅ **Your data stays with you:**
- All location data is stored in your personal Cloudflare D1 database
- No third-party services have access
- You control retention and deletion

✅ **Encrypted in transit:**
- All API requests use HTTPS
- Bearer token authentication required

✅ **Location permissions:**
- iOS Shortcuts only accesses location when you run the shortcut
- You control when location is shared
- No background tracking unless you set up automation

---

### Best Practices

1. **Use specific labels** - Makes filtering and analysis easier
2. **Add notes for context** - Future you will thank you
3. **Review periodically** - Delete old data you don't need
4. **Secure your token** - Don't share your API token
5. **Test first** - Run shortcuts manually before automating

---

### Location Accuracy

iOS provides different accuracy levels:
- **High accuracy:** 5-10 meters (GPS + WiFi + Cellular)
- **Medium accuracy:** 100-500 meters (WiFi + Cellular)
- **Low accuracy:** 1-3 km (Cellular only)

The `accuracy` field in the API response tells you the horizontal accuracy in meters.

---

## Advanced Features

### Batch Location Upload

If you want to upload multiple locations at once, you can modify the shortcut to loop through a list:

```
1. Get Current Location
2. Repeat 10 times
   - Wait 30 seconds
   - Get Current Location
   - Add to list
3. Repeat with each location in list
   - POST to API
```

---

### Reverse Geocoding

iOS Shortcuts can extract address information from coordinates:

```
Get Details of Location:
- Street Address
- City
- State
- Country
- Postal Code
```

Include these in your payload for richer location data.

---

### Speed and Heading

For movement tracking (running, cycling, driving):

```
Get Details of Location:
- Speed (m/s)
- Heading (degrees)
```

Useful for analyzing routes and movement patterns.

---

## Troubleshooting

### "Cannot access location"
**Solution:**
1. Settings → Privacy & Security → Location Services
2. Find **Shortcuts**
3. Set to "While Using" or "Always"

---

### "Location not accurate"
**Solution:**
- Ensure you're outdoors with clear sky view
- Wait a few seconds for GPS to lock
- Check the `accuracy` value in the response

---

### "Shortcut doesn't run automatically"
**Solution:**
- Ensure automation has "Ask Before Running" disabled
- Check that location services are enabled
- Verify the location radius is appropriate

---

### "Invalid timestamp format"
**Solution:**
- Use "Format Date" action with "ISO 8601" format
- Example: `2026-01-11T10:30:00Z`

---

## Example Queries

### Get all work locations
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location?label=work"
```

### Get locations from last week
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location?start=2026-01-04T00:00:00Z&end=2026-01-11T23:59:59Z"
```

### Get last 5 locations
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.anuragd.me/v1/location?limit=5"
```

---

## Visualization Ideas

Once you have location data, you can:

1. **Create a map visualization** - Plot all your locations on a map
2. **Generate heatmaps** - See where you spend most of your time
3. **Analyze patterns** - Identify frequent routes and locations
4. **Build timelines** - Create a visual timeline of your travels
5. **Export to GeoJSON** - Use with mapping tools like Mapbox or Leaflet

---

## Next Steps

1. **Create your first shortcut** - Start with Template 1
2. **Test manually** - Run it a few times
3. **Add labels** - Organize your locations
4. **Set up automation** - Automate common locations
5. **Analyze your data** - Use the GET endpoint to explore patterns

---

**Happy tracking! 📍**
