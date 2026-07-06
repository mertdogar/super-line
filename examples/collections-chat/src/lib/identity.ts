// Shared by the server and the browser so both compute the SAME ids. (User identity now comes from
// @super-line/plugin-auth; `slug` here derives a stable, url-safe CHANNEL id from a channel name.)

/** A display string -> stable, url-safe id (used for channel ids). */
export const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** One membership row per (user, channel); a derived id makes join idempotent and leave a delete-by-id. */
export const memId = (userId: string, channelId: string): string => `${userId}:${channelId}`
