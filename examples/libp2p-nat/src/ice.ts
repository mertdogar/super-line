// Public STUN lets WebRTC discover a hole-punchable public (server-reflexive) address, so peers on
// different real networks — a phone on cellular ↔ a server behind a home router — can connect. With
// only host candidates (the default) it works on a single LAN but not across NATs. Truly symmetric
// NATs still need a TURN relay, which this example doesn't run.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]
