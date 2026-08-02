// What a mutating HTTP route requires before it is allowed to change anything.
//
// Every route here used to dispatch on the path alone, and `readBody` resolves an
// empty object for a request with no body - so `GET /record/stop` ended a shoot and
// disarmed the node, and an `<img src>` or a link prefetch on any page anywhere was
// enough to send it. That is the silent-stop failure this design spent a whole round
// closing, reached from outside the process, and it is the same door a cross-origin
// `POST /library/reclaim/:id` walked through.
//
// So the rule is one rule rather than a patch per hole, and it is stated in one
// place because a second copy of it would be a second thing to keep honest:
//
//   **A route that changes something requires its method, requires a same-origin
//   caller, and requires a JSON content type.**
//
// The three together are what a page you merely *visit* cannot produce. A `no-cors`
// `fetch` may only set `text/plain`, `application/x-www-form-urlencoded` or
// `multipart/form-data`, and an HTML form the same three - so the content type alone
// stops every request a hostile page can send without asking permission first, and
// the origin check stops the ones where it does ask.
//
// **An absent `Origin` passes, and that is load-bearing rather than lax.** Every
// call across the capture-node link is a server-side `fetch` - the manifest, the
// marks log, the take's bytes, and the reclaim's `POST /library/delete/:id` - and
// none of them carries an `Origin` header at all, because nothing in Node has an
// origin to declare. Requiring one would sever the two-machine link and present it
// as a reconciliation failure. What the header is good for is the case it exists
// for: a browser saying which page this request came from, where a *wrong* answer
// is decisive and no answer is simply not a browser.

/**
 * Whether this request may act on this server.
 *
 * Split out from `requireMutation` and exported on its own, without a response to
 * write to, because the judgement and the refusal are separable and only the
 * judgement is reusable: a caller holding a raw socket rather than a `res` - the
 * WebSocket upgrade is the one coming - has nothing to write a 403 into and still
 * needs the same answer. One predicate that two paths can share beats two rules that
 * drift, and the shape is worth having before the second caller rather than after.
 *
 * The second caller has arrived: `server/index.js` asks this on the `upgrade` event,
 * where the socket carries the recorder's arm, start and stop and `WebSocket` is
 * exempt from the same-origin policy, so the answer has to be the same one the
 * mutating routes get. The other two thirds of `requireMutation` do not apply there -
 * an upgrade is always a GET and declares no content type - which is the whole
 * reason this is a predicate rather than a gate.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  // No origin is not a browser, so there is no page to be lying about.
  if (!origin) return true;
  // **A duplicated Host header is not a request this server will reason about.**
  // Node *discards* the extra ones rather than joining them - `req.headers.host`
  // is the first and a string, so nothing about the collapsed view says a second
  // arrived. It has to be counted in `rawHeaders`, which is the only place the
  // duplicate survives; checking `Array.isArray(req.headers.host)` looks like the
  // same test and never fires, which is how this first shipped.
  //
  // What it is worth: this server reads only the first Host, so today the one
  // checked is the one used. The refusal is for the request being malformed at
  // all - anything in front of this that picked the second would disagree with
  // the guard about which server the caller thinks it reached.
  const raw = req.rawHeaders ?? [];
  let hostCount = 0;
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') hostCount++;
  if (hostCount > 1) return false;
  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || rawHost === '') return false;

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    // `null` is what a sandboxed iframe and a `file://` page send, and it is not a
    // URL. Neither is same-origin with anything.
    return false;
  }

  // **Compared through the URL parser on both sides, and including the scheme.**
  // The first version of this compared `new URL(origin).host` against the raw
  // `Host` string, which was wrong in both directions at once. It accepted
  // `Origin: https://127.0.0.1:8080` against `Host: 127.0.0.1:8080`, because the
  // parser had normalised one side and nothing had looked at the scheme - and an
  // origin is a scheme, a host and a port, so two of three is not same-origin. It
  // also rejected spellings that are genuinely the same authority, since the
  // parser strips a default port, lowercases the host and compresses IPv6 on the
  // origin side while the `Host` header keeps whatever the client typed.
  //
  // Running the header through the same parser is what makes the two comparable.
  // This server speaks http, so that is the scheme the request arrived on; if it
  // ever terminates TLS itself, this is the line that has to learn about it rather
  // than a second rule somewhere else.
  // **A Host header is an authority and nothing else, and that has to be checked
  // before it is parsed rather than after.** `new URL('http://' + rawHost)` will
  // happily consume a userinfo section, a path, a query or a fragment and hand
  // back a normalised `host` - so `Host: evil.example@127.0.0.1:8080` and
  // `Host: 127.0.0.1:8080/anything` both parsed to the trusted authority and were
  // allowed. None of those are valid in a Host header, so the shape is the check:
  // no `@`, no `/`, no `?`, no `#`, and no whitespace.
  if (/[@/?#\s\\]/.test(rawHost)) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${rawHost}`);
  } catch {
    return false;
  }
  if (hostUrl.host === '') return false;
  // And the parse has to have consumed exactly the authority: anything the URL
  // parser moved into another component means the header was not one.
  if (hostUrl.pathname !== '/' || hostUrl.search !== '' || hostUrl.username !== '' || hostUrl.password !== '') {
    return false;
  }
  // **Host equality is a rule about who the caller thinks they reached, and DNS
  // rebinding is the attack that makes the caller think it reached us while the
  // page belongs to somebody else.** The attacker serves a page from a name they
  // control, lets the record expire, re-resolves that name onto the address this
  // server listens on, and the browser then sends the attacker's name in *both*
  // headers. Everything above this line agrees: the origin's host and the Host
  // header are the same string, because they are the same name.
  //
  // This was measured against the default loopback bind rather than reasoned
  // about. A request carrying `Host: evil.example.com:8231` and a matching Origin
  // wrote a preset, drove `/record/start` and `/record/stop` against the sensor,
  // opened the socket, read every take's hash from `/library/all` and then deleted
  // a take - the one irreversible action in the program, reached by a page the
  // operator merely visited.
  //
  // The bind address does not answer it, and the comment in `server/index.js` that
  // said it did was wrong: the browser making the connection is already on the
  // machine, so loopback is routable to it by definition. Binding to loopback stops
  // a page that guesses the port. It does nothing about a page that rebinds a name
  // onto it.
  //
  // What separates the two cases is the *kind* of authority. Rebinding needs a
  // name, because the attacker has to control what it resolves to; an address
  // literal cannot be rebound without controlling the address itself, which is
  // what the bind already decides. So a browser is required to have arrived at an
  // address, with two carve-outs that do not widen anything:
  //
  //   - `localhost` is reserved to loopback by RFC 6761 and hardcoded as such by
  //     browsers, so it is not a name an attacker can point anywhere.
  //   - a `.local` name resolves over multicast on the local link rather than
  //     through DNS the attacker controls. Answering one means already being on
  //     the link, which is already enough to reach the port directly - so this
  //     concedes nothing the network position did not concede first. It is here
  //     because a browser on the editing Mac reaches a capture node by mDNS name.
  //     Drop this clause if nothing here is ever reached that way.
  //
  // Placed after the origin-less return above, so the capture-node link is
  // untouched: every call across it is a server-side `fetch` that declares no
  // origin at all, and this rule never sees them.
  const { hostname } = hostUrl;
  const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
  if (!isAddress && hostname !== 'localhost' && !hostname.endsWith('.local')) return false;
  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host;
}

// Anything a hostile page cannot set without a preflight. The parameters are
// allowed for because `application/json; charset=utf-8` is what several clients
// send by default.
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

/**
 * The gate every mutating route stands behind. Answers the request itself when it
 * refuses, so a caller is one `if` rather than a branch per failure.
 *
 * **Call this before reading the body.** A request that is going to be refused
 * should not first be allowed to stream four megabytes into this process.
 */
export function requireMutation(req, res, methods) {
  // Origin first, so a request from another page gets one answer whatever it asked
  // for rather than being told which method would have worked.
  if (!originAllowed(req)) {
    refuse(res, 403, `${req.headers.origin} is not this server, and this route changes something`);
    return false;
  }
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    refuse(res, 405, `${req.method} is not how this route is called: it changes something, so it takes ${methods.join(' or ')}`);
    return false;
  }
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    refuse(res, 415, 'this route changes something, so it takes a request declaring application/json');
    return false;
  }
  return true;
}

// A refusal is JSON, because every caller of these routes already parses JSON and a
// bare status with a text body would be the one answer the page has to special-case.
function refuse(res, status, message) {
  const text = Buffer.from(JSON.stringify({ error: message }));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': text.length,
    'Cache-Control': 'no-cache',
  });
  res.end(text);
}
