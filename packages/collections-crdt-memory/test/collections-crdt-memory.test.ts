import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { runCrdtConformance } from './crdt-store-conformance.js'

runCrdtConformance('collections-crdt-memory', { make: () => crdtMemoryCollections() })
