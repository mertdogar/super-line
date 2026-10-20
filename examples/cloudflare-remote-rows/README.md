# example: cloudflare-remote-rows

A Durable Object that is **not** the super-line node, served live through it. Each `Store` is a plain SQLite
database, one object per store id, whose tables are whatever SQL you run against it. The `Node` is the super-line
node: it serves every store's tables to subscribers as one read-only collection, `storeRows`, with a snapshot on
subscribe and then every insert, update and delete as it commits.

The page has two halves. On the left you run SQL against a store, straight through the Worker; the node is not
involved. On the right a live subscription reads one store table through the node. Open it in two windows and
SQL run in one shows up in the other.

**Local only.** There is no authentication: anyone who can reach the page can run any SQL in any store. Add auth
before you deploy anything shaped like this.

## Run it locally

From the repo root, build the packages once (Vite and wrangler bundle their `dist`):

```bash
pnpm install
pnpm build
```

Then, from this directory:

```bash
pnpm dev        # vite build && wrangler dev → http://localhost:8787
```

Keep the terminal in view: the store logs every push it sends, and the node logs each construction and each
resync.

## What to try

Open http://localhost:8787 in two windows. Both subscribe to store `demo`, table `dishes`, on load. The table
doesn't exist yet, so both start empty.

1. **create dishes** (or **Run** on the prefilled SQL). Both windows show three rows, and the terminal prints
   `store demo: clock 1, 3 changes inline`. A table needs no registration: the store puts triggers on every table
   it finds, and a table created in a batch is captured whole, even the rows its own `INSERT` wrote.
2. **insert row**, **update price**, **delete row**. Each one lands in the other window's table and event log.
   Each is one batch: the store bumps its clock, then pushes the batch's changes to the node, which fans them out.
   Type your own SQL too: `UPDATE dishes SET price = price + 1` is one batch with one change per row.
3. **bulk insert 1000**. The 1000 rows arrive in both windows without a reconnect, and the terminal prints
   `clock only (the node pulls)`. A batch larger than `maxInlineChanges` (500) pushes its clock alone, and the node
   asks the store for the changes since its last clock.
4. **bulk insert 6000**. Both windows log `resync: the node closed the socket (4409)`, reconnect, and re-read a
   fresh snapshot. The terminal prints `history broke, closing every socket with 4409`. This example sets
   `maxPullChanges` to 2000 (the default is 5000), so a 6000-change backlog is too long to pull: the store answers
   "wipe" instead, and the node sends its readers back for a snapshot. The client reconnects and resubscribes
   by itself; the page never resubscribes. The subscription now shows 1000 rows of a much longer table, because
   a snapshot reads at most `snapshotLimit` (1000) rows of the table. Live changes after it aren't capped.
5. **drop table**. Another 4409, and both windows empty. A drop fires no row triggers, so the store can't say
   which rows went; dropping or altering a table breaks the history the same way an overflow does. Click
   **create dishes** again: the rows come back live, with no resync, because creating a table breaks nothing.
6. **Hibernation.** Leave both windows idle for about 15 seconds, then insert a row. The terminal prints
   `node constructed` again: the node had left memory, and the store's push woke it. Both windows update with no
   `resync` or `disconnected` line in their log. The sockets and their subscriptions survived the wake, and the
   node caught up on the stores it serves.
7. **Another store.** Set the store id on both sides to `uptown` and subscribe again. Each store id is its own
   Durable Object with its own tables; the `demo` subscription in the other window doesn't see `uptown`'s writes.

## Inspect it

```bash
node ../../packages/control-center/bin/control-center.js --url ws://localhost:8787/ws
```

The Control Center channel is open, as befits a local example. The Collections view reads `storeRows` only with
a filter that pins both `storeId` and `table` with equality, like any other read of this collection.

## How it fits together

- **`wrangler.jsonc`**: two SQLite-backed Durable Object classes, `Node` and `Store`, both bound to the Worker.
  The store calls the node to push, and the node calls the store to read.
- **`src/contract.ts`**: `remoteRowsCollection('storeRows')` from `@super-line/collections-cloudflare/contract`.
  Every row is `{ key, storeId, table, id, data }`, with the store's columns opaque under `data`. That subpath
  imports only zod and core, so the page imports the same contract.
- **`src/worker.ts`**:
  - **`Store`** wraps its own SQLite in `syncedSql`. Its `query` is the one write path; `snapshot`, `get` and
    `changesSince` are what the node reads. It's named `node:<store id>`, so its `onChange` knows which node to
    push to.
  - **`Node`** is a `createDurableNode` class. `remoteRows` is its backend for `storeRows`, composed with
    `composeCollections` beside the node's own backend (`cloudflareCollections`, which owns no collection in
    this contract). Its `storeChanged` method is where each push lands. `onWipe` closes the sockets after a wipe.
    After every construction it calls `resume` for every store it has served, to catch up on a push it might
    have missed while asleep.
  - **`fetch`** serves `./dist`, sends `/ws` to the node and `POST /stores/<id>/query` to that store, and answers
    404 to everything else, because every request a Durable Object receives wakes it.
- **`src/web.ts`**: writes are a plain `fetch` to the store's route. Reads are
  `client.collection('storeRows').subscribe({ filter: and(eq('storeId', …), eq('table', …)) })`. Both pins are
  required, because they tell the node which store, and which of its tables, to read.

## Things to know

- **The collection is read-only.** `insert`, `update` and `delete` on `storeRows` fail with `FORBIDDEN`; every
  write goes through the store's `query`. The page sends the whole textarea as one statement: SQLite runs every
  statement in it, in one transaction, and returns the last one's rows. One failing statement rolls the whole
  batch back.
- **A wipe closes every socket**, not only those reading that store. A guest may read any store, and this node
  doesn't track which store each connection reads. An app that knows (from the connection's `ctx`, say) closes
  only those readers.
- **Resume covers every store the node has served.** An app that knows which stores its connections read passes
  just those to `resume`. A store left out catches up at its next push or its next subscribe.
- **Store ids and table names must not contain `:`.** A row's key is `storeId:table:id`.
