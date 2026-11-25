# @super-line/example-peer-controller

Phones as game controllers for a game running in a desktop browser, with
[`@super-line/plugin-peer`](../../packages/plugin-peer). The super-line server admits each phone and
relays the WebRTC handshake; after that, stick input and button presses travel **directly** from the
phone to the screen over WebRTC data channels. The server carries none of it.

- **Screen** (`/`, a desktop browser, think "the TV"): creates a room, shows the join link as a QR
  code and as text, lists the controllers with their link state and round-trip time, and draws one
  coloured dot per connected controller.
- **Controller** (`/c#<room key>`, a phone): joins with the key from the link, sends its stick
  position every animation frame on a lossy channel and the **A** button on a reliable one, and shows
  the room state (`active` / `rejoining` / `closed` with the reason), the link to the screen and the
  measured round trip.

Both channels are declared once in [`src/contract.ts`](src/contract.ts) and typed end to end:

| Channel | Options | Carries |
| --- | --- | --- |
| `stick` | `reliable: false` (unordered, no retransmits) | `{ x, y }` in -1..1, every frame |
| `events` | reliable and ordered (the default) | `press`, `ping`/`pong`, `color`, `bump` |

What to look for:

- The dot follows the stick with no visible lag. Each side pings the other about once a second over
  `events` and shows the round trip; with both pages on one machine it is about 1 ms.
- Pressing **A** pulses the dot on the screen; the screen answers with a `bump`, which flashes the
  controller and vibrates the phone where the browser supports it (Android Chrome; iOS Safari has no
  vibration API). Driving a dot into a wall bumps too.
- Stop the server while a controller is linked: the dot keeps moving and the round trip keeps
  updating, because the data path does not go through the server. When the server comes back, the
  screen re-claims its room and the controller re-joins on its own.
- Close or reload a controller tab: its dot disappears at once (the page says goodbye on `pagehide`),
  and a reload joins again with a fresh dot.

## Run

From the repo root:

```bash
pnpm install
pnpm --filter @super-line/example-peer-controller build   # vite build → dist/
pnpm --filter @super-line/example-peer-controller start   # http://localhost:3000
```

Open **http://localhost:3000** on the computer that runs the server. The server prints the join base
it puts in the QR code (`http://<your LAN address>:3000`). To try it without a phone, open the link
under the QR code in a second browser window.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `PUBLIC_URL` | `http://<first LAN IPv4>:<PORT>` | the base of the join link in the QR code |
| `ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array of `RTCIceServer`, used by every page |

## On a phone

Put the phone on the **same Wi-Fi** as the computer and scan the QR code. The server listens on all
interfaces, so the phone reaches it at the LAN address (allow incoming connections if your firewall
asks). If the server picked the wrong interface, set `PUBLIC_URL=http://192.168.1.20:3000`.

### Secure contexts

`http://localhost` counts as a secure context; `http://192.168.x.x` does not. What that changes here:

| API | Needs a secure context | Used by | Over plain HTTP on a LAN address |
| --- | --- | --- | --- |
| `RTCPeerConnection`, data channels | no | both pages | works |
| `crypto.getRandomValues` | no | both pages (the join ticket) | works |
| `crypto.subtle` | **yes** | the screen (`createRoom` derives the room key) | the screen cannot create a room, so open it at `localhost` |
| Screen Wake Lock | **yes** | the controller | not available; the controller shows "unavailable here" and the phone may dim and lock |
| `navigator.vibrate` | no | the controller | works where supported |

So the plain-HTTP setup works: the screen on `localhost`, the phones on the LAN address. To also get
the wake lock on phones, serve the pages over HTTPS. Any TLS reverse proxy in front of port 3000
works; the pages switch to `wss://` on their own. For example, with Tailscale on the computer and the
phone:

```bash
tailscale serve --https=8443 http://127.0.0.1:3000
PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443 pnpm --filter @super-line/example-peer-controller start
```

### Lifecycle

The controller holds a Screen Wake Lock while it is linked to the screen and takes it again when the
page becomes visible (browsers release it whenever the page is hidden). If the phone locks or the tab
goes to the background anyway, mobile browsers suspend the page and the link dies; the screen drops
that dot after about 3 seconds of silence. When the page is visible again, the controller re-joins
the same room by itself (state `rejoining`, then `active`). It gives up after 8 attempts and shows
**Join again**; it shows the same button when its link to the screen failed to connect at all.

## Networks, STUN and TURN

WebRTC needs a direct path between the phone and the screen.

- **Same Wi-Fi** usually just works. Chrome hides local IP addresses behind `.local` mDNS names,
  which needs multicast on the Wi-Fi; most home networks allow it. The default STUN server adds the
  public address as a second candidate, which helps when mDNS is filtered and the router supports
  hairpinning.
- **TURN is needed** when no direct path exists: guest, venue and office networks with client
  isolation (devices on the same Wi-Fi cannot reach each other), a phone on cellular data while the
  screen is on Wi-Fi behind a strict or symmetric NAT, or routers without hairpinning. Run a TURN
  server (coturn, or a hosted one) and list it:

  ```bash
  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' \
    pnpm --filter @super-line/example-peer-controller start
  ```

  In a real deployment, vend short-lived TURN credentials: `iceServers` also accepts a function that
  `peerClient` calls for every new peer connection.
- There is no fallback through the server. A controller that cannot connect shows `failed` for the
  screen link.

## Limits

- Desktop and phone browsers only. Smart-TV browsers are out of scope: most of them do not offer
  WebRTC to third-party pages. Plug a computer with a desktop browser into the TV instead.
- Rooms are full meshes: every controller also links to every other controller, although this game
  only talks to the screen. The screen allows 8 controllers (`maxMembers: 9`), which is 36 links.
- Phones in the background lose their link (see Lifecycle).
- The server keeps no game state and authorizes every join (`authorize` returns the player's name as
  `info`); the screen accepts every controller. A real game would check who may create and join.

## Files

- [`src/contract.ts`](src/contract.ts): the two channels and the contract.
- [`src/server.ts`](src/server.ts): static files, `/config.json` (join base and ICE servers), the
  super-line server with the WebSocket transport and the peer plugin.
- [`src/screen.ts`](src/screen.ts): room, QR code, member list, the game loop.
- [`src/controller.ts`](src/controller.ts): join, stick and button, state display, wake lock.
