# example: scaling-libp2p (decentralized, broker-less)

The same multi-node cluster as [`scaling`](../scaling), but with **no Redis** — the nodes
peer directly over [libp2p](https://libp2p.io) gossipsub via
[`@super-line/adapter-libp2p`](../../packages/adapter-libp2p). One shared mesh fans out all
three flows across separate processes:

1. **`message`** — a room broadcast a client triggers via `say` (server → all clients, any node)
2. **`announce`** — a topic `node-1` publishes on a timer (server → subscribed clients, any node)
3. **`stats`** — a shared topic used as the cluster event bus (server → server gossip of conn counts)

## Run it

```bash
cd examples/scaling-libp2p && docker compose up
```

Three server nodes peer over libp2p (`P2P_PORT` 9001), a Caddy load balancer round-robins
six client WebSockets across them (`:8085`), and there is **no broker container**. Watch a
client's `say` come back out on every other client, `node-1`'s `announce` reach all of them,
and each node log its peers' connection counts gossiped over the bus.

## Kubernetes

Kubernetes pod networks do not guarantee multicast, so the included
[`kubernetes.yaml`](./kubernetes.yaml) uses dynamic DNS discovery instead of
mDNS. It contains one Deployment whose replica count can be changed freely,
plus one headless Service that publishes every pod IP.

For a local Kubernetes cluster, prepare the image before you deploy the
manifest:

1. From the repository root, build the server and Control Center images:

```bash
docker build \
  --tag super-line-scaling-libp2p:dev \
  --file=examples/scaling-libp2p/Dockerfile \
  .

docker build \
  --tag super-line-scaling-libp2p-control-center:dev \
  --file=examples/scaling-libp2p/Dockerfile.control-center \
  .
```

2. Make the image available to your cluster:

   - For Docker Desktop Kubernetes with the containerd image store, continue
     to step 3. The manifest uses `imagePullPolicy: Always`, so a rollout
     fetches the freshly built development tags from Docker Desktop.
   - For a standalone `kind` cluster, load the image into the cluster. The
     default cluster name is `kind`; replace it if you used another name.

```bash
kind load docker-image \
  super-line-scaling-libp2p:dev \
  super-line-scaling-libp2p-control-center:dev \
  --name kind
```

3. After the image is available, deploy the manifest:

```bash
kubectl apply -f examples/scaling-libp2p/kubernetes.yaml
kubectl -n super-line rollout status deployment/super-line
kubectl -n super-line rollout status deployment/super-line-control-center
```

If you deployed before the image was available and the pods entered
`ImagePullBackOff`, start a fresh rollout after preparing the image:

```bash
kubectl -n super-line rollout restart deployment/super-line
kubectl -n super-line rollout status deployment/super-line
kubectl -n super-line rollout restart deployment/super-line-control-center
kubectl -n super-line rollout status deployment/super-line-control-center
```

For a remote cluster, push the image to a registry and replace
`super-line-scaling-libp2p:dev` in the manifest.

Every pod receives the same discovery configuration:

```ts
discovery: {
  dns: {
    hostname: 'super-line-p2p.super-line.svc.cluster.local',
    port: 9001,
  },
}
```

The adapter resolves every A/AAAA record immediately and every five seconds
thereafter, dialing new endpoints at the shared libp2p port. Peer IDs can stay
ephemeral because no configuration references them. Scale-ups and replacement
pods join on the next DNS scan.

Each server logs its live direct peers as they connect or disconnect. For
example, a three-replica deployment settles at two peers per pod:

```text
[super-line-…] libp2p peers (2): 12D3Koo…, 12D3Koo…
```

Read the logs from all replicas with:

```bash
kubectl -n super-line logs \
  -l app=super-line-scaling-libp2p \
  --prefix \
  --max-log-requests=10
```

### Control Center

The manifest also deploys the [Control Center](../../packages/control-center),
which renders the cluster topology, connections, and live message feed. Run
these commands in separate terminals, then open <http://localhost:8091>:

```bash
kubectl -n super-line port-forward service/super-line 8801:8801
kubectl -n super-line port-forward service/super-line-control-center 8091:8091
```

The browser connects the Control Center to `ws://localhost:8801`. That Service
selects one replica, and the inspector renders the full libp2p cluster through
the adapter's presence mesh. The inspector is read-only but unauthenticated, so
use this deployment only on a trusted network.

The topology view lists server nodes that own an application client connection.
Start clients on more than one replica to watch all nodes appear; the peer logs
above show the direct libp2p links even when no application clients are present.

To exercise the cluster from the host:

```bash
kubectl -n super-line port-forward service/super-line 8085:8801
pnpm --filter @super-line/example-scaling-libp2p client
```

Scale the one Deployment:

```bash
kubectl -n super-line scale deployment/super-line --replicas=6
```

If the namespace uses default-deny network policies, allow TCP `9001` between
these pods. UDP `5353` is not required because this topology does not use mDNS.

## How Docker discovery works

Every node needs to find the others. This demo derives a **deterministic Ed25519 key from each
node name**, so each node can compute the others' peer IDs and build the bootstrap list with no
registry:

```ts
const bootstrap = await Promise.all(
  NODES.filter((n) => n !== NODE).map(
    async (n) => `/dns4/${n}/tcp/${P2P_PORT}/p2p/${peerIdFromPrivateKey(await keyFor(n))}`,
  ),
)
const adapter = await createLibp2pAdapter({
  identity: myKey,
  listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`],
  discovery: { bootstrap },
})
```

> **Demo shortcut.** Deterministic keys keep the example registry-free. A real deployment
> persists each node's key and runs ≥2 stable **seed** nodes (or lists every peer for a small
> cluster). Persist with `createLibp2pAdapter({ identity: { path: '/var/lib/app/p2p' } })` so a
> seed's peer ID — and therefore its bootstrap multiaddr — survives restarts. Kubernetes uses
> dynamic DNS discovery instead, so its replicas do not need stable identities.

## Redis vs. libp2p

Both adapters implement the same `Adapter` contract, so server code is identical — only the
adapter line changes. Redis is a simple central broker; libp2p is broker-less and decentralized.
See the [scaling & adapters guide](https://mertdogar.github.io/super-line/guide/scaling-adapters).
