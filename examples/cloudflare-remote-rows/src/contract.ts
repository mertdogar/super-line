import { defineContract } from '@super-line/core'
import { remoteRowsCollection } from '@super-line/collections-cloudflare/contract'

// One collection, `storeRows`, holding the rows of every store's tables. The `/contract` subpath pulls in only zod
// and core, so the page can import this file too.
export const contract = defineContract({
  roles: { guest: {} },
  plugins: [remoteRowsCollection('storeRows')],
})
