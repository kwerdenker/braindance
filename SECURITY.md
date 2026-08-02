# Security

Braindance has no authentication of any kind, and that is a design decision rather than an
omission. Whoever can reach the port can arm the recorder, start and stop a take, read the
library, and delete footage. There are no accounts, no tokens and no TLS. It is a tool for
driving a sensor on a network you control, and it is built on the assumption that reaching it
is itself the permission.

That assumption is only honest if the boundaries around it are stated plainly, so this document
states them, including the one that turned out to be wrong.

## What protects you, and what does not

**The bind address is the real boundary.** The server listens on `127.0.0.1` unless you pass
`--host`, so out of the box nothing off the machine can reach it. It says on stdout when you
widen it, so widening is a decision somebody took rather than a default.

**The origin rule is the second half, and it only speaks to browsers.** Mutating HTTP routes
and the WebSocket upgrade require a same-origin `Origin` header, a matching method and a JSON
content type — the three things a page you merely visit cannot produce together. A request
carrying **no** `Origin` passes on purpose: every call across the capture-node link is a
server-side `fetch`, and nothing in Node has an origin to declare.

The consequence is worth being blunt about: **the origin rule stops hostile web pages and stops
nothing else.** Any non-browser client that can route to the port — curl, a script, another
machine on the Wi-Fi — sends no `Origin` and is allowed to do everything.

**Host equality alone does not survive DNS rebinding, so the guard does not rely on it.** The
original rule compared `Origin` against `Host`, and a name an attacker controls, re-resolved
onto the address you are listening on, makes those two strings equal. This was measured against
the default loopback bind rather than theorised: a request in that shape wrote a preset, drove
`/record/start` and `/record/stop` against a real sensor, opened the WebSocket, read every
take's hash from `/library/all`, and deleted a take.

Binding to loopback does not prevent it — the browser doing the connecting is already on the
machine, so loopback is routable to it by definition.

The guard now additionally requires that a browser arrived at an **address** rather than a name,
because rebinding needs a name the attacker can point somewhere and an address literal cannot be
rebound without controlling the address itself. Two authorities are allowed through besides an
IP literal: `localhost`, which RFC 6761 reserves to loopback, and a `.local` name, which is
answered over multicast on the local link by whoever is already on it. `node tools/guard-check.mjs`
proves the rule, and `--mutate host-accepts-a-name` reverts it and must fail.

If you reach this server through a browser at some other hostname — a reverse proxy, a name in
`/etc/hosts`, a Tailscale MagicDNS name — that request will now be refused. That is the rule
working, not a bug, and the fix is to reach it by address or to add your case deliberately.

## What `--host 0.0.0.0` actually exposes

Everything, to everyone who can route to the port:

- `POST /record/start`, `/record/stop`, `/record/mark` — arm the node, end a shoot in progress,
  or write marks into someone else's take.
- `GET /library/all` and `GET /capture/:id/file` — list every take and download the footage.
- `POST /library/delete/:id` — destroy a take. This is the only irreversible action in the tool.
  The `confirm` flag it requires is an interlock against a misclick, not a check on who is asking.
- `PUT /projects/:name`, `/presets/:name`, `/deliverables/:name` — overwrite saved work.
- `POST /jobs` — queue renders, without limit, on the disk your takes are being written to.
- The WebSocket — the live sensor feed, and the recorder's controls.

## Staying safe

- **Leave the default bind alone on any machine you edit on.** It needs no network access.
- **Pass `--host 0.0.0.0` only on a capture node, and only on a network you control.** A shoot
  on conference or hotel Wi-Fi is not that network. A wired link, or a dedicated access point
  between the node and the editing machine, is.
- **Put it behind something if it must cross a network you do not control.** An SSH tunnel or a
  WireGuard link, with the server still bound to loopback on the far side, gives you the
  authentication and the transport security this program deliberately does not have.
- **Nothing here is safe to expose to the internet.** Not behind a reverse proxy, not on a
  forwarded port.

## Reporting

Open an issue, or mail <tim@timkraus.eu> for anything you would rather not file in public. There
is no bounty and no SLA — this is a personal project, and it is better to say so than to imply a
response time nobody is on call for.

If you are reporting something you found by reading rather than by running it, say which it was.
This repository's convention is that a measured result and a reasoned one are different kinds of
claim, and a report that marks the difference is worth more than one that does not.
