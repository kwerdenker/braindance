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
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    // `null` is what a sandboxed iframe and a `file://` page send, and it is not a
    // URL. Neither is same-origin with anything.
    return false;
  }
  return host === req.headers.host;
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
