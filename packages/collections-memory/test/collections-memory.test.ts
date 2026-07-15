import { memoryCollections } from '@super-line/collections-memory'
import { runRowConformance } from '../../core/test/collection-store-conformance.js'

// Every assertion this package used to make was a CollectionStore contract clause, not a memory one — it is
// the seam's reference implementation, so it has no behaviour of its own to test. The whole file is the
// conformance run. Anything worth asserting here belongs in the suite, where sqlite and pglite meet it too.
runRowConformance('collections-memory', { make: () => memoryCollections(), clustering: 'relay' })
