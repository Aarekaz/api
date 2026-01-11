# Shelf Configuration in Settings

## Overview

Shelf configuration (visibility toggles and hidden items) is stored in the `settings` table under the `shelf_config_json` column. This allows dynamic control of which shelf sections are visible and which specific items are hidden.

## Database Schema

### Migration: `0008_shelf_config.sql`

```sql
ALTER TABLE settings ADD COLUMN shelf_config_json TEXT;
```

### Settings Table Structure

```sql
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  public_fields_json TEXT,
  theme TEXT,
  flags_json TEXT,
  shelf_config_json TEXT,  -- Added in migration 0008
  updated_at TEXT
);
```

## API Schema

### Shelf Config Type

```typescript
{
  sections: {
    links: { visible: boolean },
    quotes: { visible: boolean },
    visuals: { visible: boolean },
    wallpapers: { visible: boolean }
  },
  hiddenItems: number[]  // Array of shelf item IDs to hide
}
```

### Settings Endpoint Response

```json
{
  "id": 1,
  "public_fields": ["name", "bio"],
  "theme": "dark",
  "flags": {},
  "shelf_config": {
    "sections": {
      "links": { "visible": true },
      "quotes": { "visible": true },
      "visuals": { "visible": false },
      "wallpapers": { "visible": false }
    },
    "hiddenItems": [5, 12, 23]
  },
  "updated_at": "2026-01-11T12:00:00.000Z"
}
```

## API Endpoints

### GET `/v1/settings`

Fetches all settings including shelf configuration.

**Default Response** (if no settings exist):
```json
{
  "public_fields": [],
  "theme": null,
  "flags": {},
  "shelf_config": {
    "sections": {
      "links": { "visible": true },
      "quotes": { "visible": true },
      "visuals": { "visible": false },
      "wallpapers": { "visible": false }
    },
    "hiddenItems": []
  }
}
```

### PUT `/v1/settings`

Updates settings including shelf configuration.

**Request Body:**
```json
{
  "shelf_config": {
    "sections": {
      "links": { "visible": true },
      "quotes": { "visible": false },
      "visuals": { "visible": true },
      "wallpapers": { "visible": true }
    },
    "hiddenItems": [3, 7, 15]
  }
}
```

**Response:**
```json
{
  "ok": true,
  "updated_at": "2026-01-11T12:00:00.000Z"
}
```

## Migration from Local Config

### Step 1: Apply Database Migration

```bash
# Local development
npx wrangler d1 migrations apply personal_api --local

# Production
npx wrangler d1 migrations apply personal_api --remote
```

### Step 2: Migrate Config Data

From the website repository, run:

```bash
API_URL=https://api.anuragd.me \
API_TOKEN=your-token \
node scripts/migrate-shelf-config.mjs
```

This reads `content/shelf/config.json` and uploads it to the API settings.

## Usage in Website

### Fetch Shelf Config

```typescript
import { getShelfConfig } from '@/lib/shelf-config'

// In a server component
const config = await getShelfConfig()

if (config.sections.links.visible) {
  // Show links section
}
```

### Check Section Visibility

```typescript
import { isSectionVisible } from '@/lib/shelf-config'

const showLinks = await isSectionVisible('links')
const showQuotes = await isSectionVisible('quotes')
```

### Check Item Visibility

```typescript
import { isItemHidden } from '@/lib/shelf-config'

const items = await api.getShelf()
const visibleItems = []

for (const item of items) {
  if (!await isItemHidden(item.id)) {
    visibleItems.push(item)
  }
}
```

### Admin: Toggle Section Visibility

```typescript
import { toggleSectionVisibility } from '@/lib/shelf-config'

// In a server action or API route
await toggleSectionVisibility('visuals')  // Toggle visuals on/off
```

### Admin: Hide/Unhide Item

```typescript
import { toggleItemVisibility } from '@/lib/shelf-config'

// In a server action or API route
await toggleItemVisibility(5)  // Toggle item #5 visibility
```

## Integration with Shelf Items

### Filter Items by Visibility

```typescript
import { api } from '@/lib/api-client'
import { getShelfConfig } from '@/lib/shelf-config'

async function getVisibleShelfItems() {
  const [items, config] = await Promise.all([
    api.getShelf(),
    getShelfConfig()
  ])
  
  // Filter by section visibility
  const visibleItems = items.filter(item => {
    const drawer = item.drawer as keyof typeof config.sections
    return config.sections[drawer]?.visible ?? true
  })
  
  // Filter by hidden items
  return visibleItems.filter(item => !config.hiddenItems.includes(item.id))
}
```

## Notes

- **Default Visibility**: Links and quotes are visible by default, visuals and wallpapers are hidden
- **Hidden Items**: Uses numeric IDs from the API (not string IDs from local JSON)
- **Singleton Settings**: Settings table uses `id = 1` as a singleton record
- **Caching**: Consider caching shelf config in the website with appropriate revalidation
- **Admin UI**: Build admin interface to toggle visibility without editing JSON files

## Example Admin UI Component

```typescript
// components/manage/shelf-config-manager.tsx
'use client'

import { useState } from 'react'
import { toggleSectionVisibility } from '@/lib/shelf-config'

export function ShelfConfigManager({ initialConfig }) {
  const [config, setConfig] = useState(initialConfig)
  
  const handleToggle = async (section: string) => {
    await toggleSectionVisibility(section)
    // Refresh config
    const updated = await getShelfConfig()
    setConfig(updated)
  }
  
  return (
    <div>
      <h2>Shelf Visibility</h2>
      {Object.entries(config.sections).map(([section, { visible }]) => (
        <div key={section}>
          <label>
            <input
              type="checkbox"
              checked={visible}
              onChange={() => handleToggle(section)}
            />
            {section}
          </label>
        </div>
      ))}
    </div>
  )
}
```

## Testing

```bash
# Fetch current settings
curl https://api.anuragd.me/v1/settings \
  -H "Authorization: Bearer $API_TOKEN"

# Update shelf config
curl -X PUT https://api.anuragd.me/v1/settings \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "shelf_config": {
      "sections": {
        "links": { "visible": true },
        "quotes": { "visible": true },
        "visuals": { "visible": true },
        "wallpapers": { "visible": true }
      },
      "hiddenItems": []
    }
  }'
```
