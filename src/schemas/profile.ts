import { z } from "zod";

export const profileSchema = z.object({
  name: z.string().min(1).optional(),
  bio: z.string().optional(),
  handles: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
  timezone: z.string().optional(),
  avatar_url: z.string().url().optional(),
  location: z.string().optional(),
});

export const nowSchema = z.object({
  focus: z.string().optional(),
  status: z.string().optional(),
  availability: z.string().optional(),
  mood: z.string().optional(),
  current_song: z.string().optional(),
});

// Shelf config schema for type safety
export const shelfConfigSchema = z.object({
  sections: z.object({
    links: z.object({ visible: z.boolean() }).optional(),
    quotes: z.object({ visible: z.boolean() }).optional(),
    visuals: z.object({ visible: z.boolean() }).optional(),
    wallpapers: z.object({ visible: z.boolean() }).optional(),
  }).optional(),
  hiddenItems: z.array(z.number()).optional(),
});

export const settingsSchema = z.object({
  public_fields: z.array(z.string()).optional(),
  theme: z.string().optional(),
  flags: z.record(z.unknown()).optional(),
  shelf_config: shelfConfigSchema.optional(),
});

export const experienceSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  location: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  employment_type: z.string().optional(),
  description: z.string().optional(),
});

export const educationSchema = z.object({
  institution: z.string().min(1),
  degree: z.string().optional(),
  field: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  description: z.string().optional(),
});

export const skillSchema = z.object({
  category: z.string().min(1),
  items: z.array(z.string()).optional(),
});
