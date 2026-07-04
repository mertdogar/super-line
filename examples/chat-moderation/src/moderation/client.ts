import type { SuperLineClientPlugin } from '@super-line/client'

/**
 * The CLIENT half of the moderation pair. Small by design: it uses `onReconnect` — a lifecycle hook
 * the plugin system added to the client — so a moderator's mutelist view re-syncs after a dropped
 * socket (it may have changed while they were offline). The app supplies the actual re-fetch.
 */
export function moderationClient(opts: { onReconnect?: () => void } = {}): SuperLineClientPlugin {
  return {
    name: 'moderation',
    onReconnect: () => opts.onReconnect?.(),
  }
}
