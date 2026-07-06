// Shared by the server and the browser so both compute the SAME ids.

/** Display name -> stable, url-safe user id. Your identity persists across reloads (no accounts here). */
export const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** One membership row per (user, channel); a derived id makes join idempotent and leave a delete-by-id. */
export const memId = (userId: string, channelId: string): string => `${userId}:${channelId}`
