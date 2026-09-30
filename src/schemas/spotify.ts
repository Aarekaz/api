import { z } from "zod";

// Upstream Spotify Web API payloads. Only the fields /v1/music/now projects are
// validated; everything else is tolerated (passthrough) and never re-emitted.

export const spotifyTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().finite().nonnegative(),
  // Always present on the authorization-code exchange; optional on refresh, where
  // Spotify only returns one when it rotates the refresh token.
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
}).passthrough();

const spotifyImageSchema = z.object({
  url: z.string(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
}).passthrough();

export const spotifyTrackSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.literal("track").optional(),
  duration_ms: z.number().finite().nonnegative().nullable().optional(),
  artists: z.array(z.object({ name: z.string() }).passthrough()),
  album: z.object({
    name: z.string().nullable().optional(),
    images: z.array(spotifyImageSchema).optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

export const spotifyCurrentlyPlayingSchema = z.object({
  is_playing: z.boolean(),
  progress_ms: z.number().finite().nonnegative().nullable().optional(),
  currently_playing_type: z.string(),
  // Episodes, ads, and unknown items are not validated as tracks; the mapper ignores them.
  item: z.unknown().nullable().optional(),
}).passthrough();

export const spotifyRecentlyPlayedSchema = z.object({
  items: z.array(z.object({
    track: z.unknown(),
    played_at: z.string(),
  }).passthrough()),
}).passthrough();

export type SpotifyTokenResponse = z.infer<typeof spotifyTokenResponseSchema>;
export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;
export type SpotifyCurrentlyPlaying = z.infer<typeof spotifyCurrentlyPlayingSchema>;
export type SpotifyRecentlyPlayed = z.infer<typeof spotifyRecentlyPlayedSchema>;
