/photos/...`, `/healthz`, etc.
If `req.path` starts with `//` or `/\\` or `/\`, or if `req.path` does not start with a single `/` followed by a non-slash character (or is exactly `/`), `res.redirect(303, req.path)` will redirect to an arbitrary external origin (Open Redirect)!

Let's test this scenario:
An attacker crafts a URL: `https://smart-photo-frame.example.com//evil.com?k=secret`
Or `https://smart-photo-frame.example.com/\\evil.com?k=secret`
1. User clicks the link or client makes a request with `?k=secret`.
2. Server validates key, sets session cookie.
3. Server calls `res.redirect(303, '//evil.com')`.
4. Browser redirects to `https://evil.com`.

Wait! Is this an Open Redirect vulnerability?
Let's check if `req.path` can be `//evil.com`.
In Express 4:
If client sends `GET //evil.com?k=secret HTTP/1.1`
`req.path` is `//evil.com`.
`req.path.startsWith('//')` is `true`.
`res.redirect(303, '//evil.com')` -> sends `Location: //evil.com`.
Browser navigates to `https://evil.com`.

Is there any other place where open redirect could occur?
`res.redirect(303, req.path)` in `#redirectBare` is the only redirect in the codebase.

Let's check if `req.path` can be sanitized in `#redirectBare`:
`const target = req.path.startsWith('//') || req.path.startsWith('/\\') ? '/' : req.path;`
or ensuring `target` starts with `/` and not `//` or `/\\` or `/\`.

Let's check the severity and impact:
Category: Open Redirect / Unsanitized Redirection
Location: `server.js`, `AuthGate.#redirectBare`
What: `res.redirect(303, req.path)` redirects to `req.path` without checking if `req.path` begins with `//` or `/\\` (protocol-relative URLs), allowing an attacker to construct a URL that redirects authenticated users to an external malicious domain.
Attack path: Attacker sends/distributes `https://frame-domain.com//attacker.com?k=FRAME_KEY` or `https://frame-domain.com/\\attacker.com?k=FRAME_KEY`. When visited, `AuthGate` authenticates the request and redirects the client browser to `https://attacker.com`.

---

Wait! Let's check another area: Content Security Policy & Static File Serving!

Look at `CONTENT_