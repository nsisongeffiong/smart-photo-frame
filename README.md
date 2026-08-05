# smart-photo-frame

A digital photo frame for an iPad Air 1 permanently stuck on **iOS 12.5.7
(Safari 12)**.

That iPad cannot render the Home Assistant frontend — HA supports Safari 14 and
above — and cannot run the companion app. So the iPad never talks to Home
Assistant at all. A small Node service on a public VPS polls Home Assistant
server-side over Tailscale and serves the iPad a static page from the same
origin:

    HA (private tailnet) <-- polls -- bridge (public VPS) <-- polls -- iPad

Consequences of that shape, all deliberate:

- **Same origin** for the page, the JSON API and the photo files: no CORS
  configuration, no mixed-content block.
- The Home Assistant **long-lived token never reaches a browser**. It lives in
  the VPS process environment only.
- **Home Assistant needs no file changes.** No `configuration.yaml` edit, no
  custom integration, no add-on. Four helper entities created through its UI,
  and that is the whole HA side.
- An HA outage must never blank the frame, so the last known good state is
  served indefinitely.

Everything below is what the code actually does. Where this README and the
comments in other files disagree, see [Known
inconsistencies](#known-inconsistencies) at the end.

---

## Table of contents

- [Setup: Home Assistant](#setup-home-assistant)
- [Setup: Tailscale](#setup-tailscale)
- [Deployment](#deployment)
- [Photos](#photos)
- [The iPad](#the-ipad)
- [Operating it](#operating-it)
- [Security posture](#security-posture)
- [Configuration reference](#configuration-reference)
- [Known inconsistencies](#known-inconsistencies)

---

## Setup: Home Assistant

### The four helpers

Create these via **Settings → Devices & Services → Helpers → Create helper**.
The entity IDs below are the defaults the server expects; if you want different
IDs, set the `ENTITY_*` variables instead (see
[Configuration reference](#configuration-reference)).

| Helper type | Entity ID | Notes |
| --- | --- | --- |
| Dropdown | `input_select.photo_frame_album` | One option per album directory |
| Toggle | `input_boolean.photo_frame_display` | `on` / `off` — screen on or black |
| Number | `input_number.photo_frame_brightness` | Range **10 – 100**, step 1 |
| Number | `input_number.photo_frame_interval` | Seconds per photo |

Helper names in the HA UI become entity IDs by slugification, so a Dropdown
named "Photo Frame Album" becomes `input_select.photo_frame_album`. Check the
resulting entity ID in the helper's settings; don't assume it.

**The dropdown options must match the album directory names under the photos
volume exactly.** The server compares them as literal strings. `Family` and
`family` are different albums; a trailing space is a different album.

Album directory names must also pass the server's allowlist, or they are
skipped with a warning in the log:

- first character must be a letter or digit
- remaining characters: letters, digits, space, `.`, `_`, `-`
- 1 to 64 characters, no `..` anywhere
- `__proto__`, `constructor` and `prototype` are rejected outright
- symlinks and names starting with `.` are skipped
- at most 512 albums are scanned

Brightness is clamped to **10 – 100** by the server, so a helper with a minimum
of 0 will still never dim past 10. Interval is clamped to 1 – 3600 by the
server, but the client page enforces its own floor of **5 seconds** — setting
the helper below 5 has no visible effect.

### The access token

**Settings → your profile → Security → Long-lived access tokens → Create
token.** Copy it into `HA_TOKEN`.

State this plainly to yourself before you create it: **Home Assistant has no
read-only token.** A long-lived access token has full API scope. It can unlock
doors, read cameras, disarm alarms, and call any service in your house. This
service only ever issues `GET /api/states/<entity_id>` against four entities,
but the credential it carries is capable of everything.

That makes `HA_TOKEN` the single most valuable thing in this deployment — more
valuable than the photographs, and far more valuable than frame uptime. Every
design decision in `server.js` that looks paranoid is protecting it: the token
never goes to a browser, `HA_BASE_URL` is validated at boot before the token is
ever sent to it, redirects are refused (`redirect: 'error'`) so the token is
never replayed at an unvalidated host, and the log helper never prints it.

If the VPS is compromised, rotate the token in Home Assistant first, before
anything else.

---

## Setup: Tailscale

Install Tailscale on **both** the Home Assistant box and the VPS, and join them
to the same tailnet.

### Disable key expiry on both nodes

In the Tailscale admin console, open each machine → **Disable key expiry**.

Node keys expire after 180 days by default. When they do, the tailnet route
dies **silently**: the bridge simply cannot reach Home Assistant any more. It
will fail over to Nabu Casa if you configured a fallback, or serve the last
known album forever if you didn't. Either way the frame keeps showing
photographs and nobody notices for months. This is the single most likely
long-term failure of this deployment.

### Use the raw `100.x.y.z` address

`HA_BASE_URL` must be the raw tailnet IP, e.g. `http://100.101.102.103:8123`.

Not a MagicDNS name. The container gets Docker's embedded resolver, not the
host's `/etc/resolv.conf`, so tailnet hostnames do not resolve inside it.
`ts.net` names will fail with a DNS error that looks like an outage.

If you would rather write a name, `docker-compose.yaml` has a commented
`extra_hosts:` block that pins one — that is the only way a name resolves in
the container.

### Restrict the VPS with an ACL

The VPS is a public host. Assume it can be compromised. A tailnet ACL that lets
it reach only Home Assistant's HTTP port means a compromise yields one HTTP
port, not your whole home network.

In the Tailscale admin console → **Access controls**:

```jsonc
{
  "tagOwners": {
    "tag:frame-bridge": ["autogroup:admin"],
    "tag:homeassistant": ["autogroup:admin"]
  },
  "acls": [
    {
      // The public VPS may reach Home Assistant's HTTP port and nothing else.
      "action": "accept",
      "src": ["tag:frame-bridge"],
      "dst": ["tag:homeassistant:8123"]
    }
  ]
}
```

Tag the two machines accordingly (`tailscale up --advertise-tags=tag:frame-bridge`
on the VPS). Verify from the VPS that `curl http://100.x.y.z:8123/` succeeds and
that nothing else on the tailnet answers.

---

## Deployment

Target: **Coolify** on a public VPS, with a persistent volume mounted at the
photos directory. `docker-compose.yaml` and `Dockerfile` are ready to use.

### 1. `TRUST_PROXY=1` is required, not optional

`server.js` defaults `TRUST_PROXY` to **false** — correct for a service
listening directly on the internet, because otherwise any client can name its
own address in `X-Forwarded-For` and evade per-IP throttling entirely.

Behind Coolify's reverse proxy that default is wrong. Every request appears to
come from the proxy, so `req.ip` is the proxy address for every client, and the
auth rate limiter collapses into **one global bucket**. Measured behaviour:
twelve failed attempts from a single address returned **429 to a completely
unrelated client**, locking the real frame out. With `TRUST_PROXY=1` the same
test returns 429 to the attacker, 401 to the bystander, and 200 to a
cookie-holder requesting from the attacker's own address.

`docker-compose.yaml` hard-codes `TRUST_PROXY: "1"` for this reason. If you
deploy some other way, set it yourself. `1` means "trust exactly one proxy
hop" — count your hops if you have more.

The effective value is printed in the boot log line (`"trustProxy": "1"`).
Check it after every deploy.

### 2. HTTPS is required, not merely recommended

The session cookie is named `__Host-spf`. The `__Host-` prefix means browsers
that understand it will only accept the cookie over HTTPS, with `Path=/` and no
`Domain`. The cookie is also set with the `Secure` attribute unconditionally.

Over plain HTTP the frame **appears to authenticate and then fails**: the server
returns its 303 redirect, the browser discards the cookie, and the next request
is a 401. There is no error message that tells you this; it just doesn't work.

Coolify terminates TLS for you. Make sure the domain has a certificate before
you open the URL on the iPad.

### 3. Deploy

```bash
git clone <your-remote> smart-photo-frame
cd smart-photo-frame
cp .env.example .env
$EDITOR .env          # fill in HA_BASE_URL, HA_TOKEN, FRAME_KEY
```

In Coolify: new resource → Docker Compose → point it at this repository. Coolify
writes the environment you configure in its UI into a `.env` file next to the
compose file, which is also the file Compose interpolates `${...}` from. Then:

- Add a **persistent volume** for the named volume `photos`, mounted at
  `/photos`. It is mounted **read-only** (`photos:/photos:ro`) — the service
  only ever reads, so a compromised process cannot delete your photographs.
- Set the domain and enable HTTPS.

`FRAME_KEY` must survive the server's own strength check at boot: at least 16
characters, at most 512, printable ASCII with no spaces (it travels in a URL
query string), at least 8 distinct characters, and not one of a small list of
well-known placeholders. Generate it properly:

```bash
openssl rand -hex 24
```

### 4. `package-lock.json` must be committed

The `Dockerfile` runs `npm ci --omit=dev`, which refuses to run without a
lockfile. That is the point — builds are reproducible or they fail. The
lockfile **is** committed in this repository; if you ever `.gitignore` it, the
image stops building.

### Manual Docker deployment

```bash
cp .env.example .env && $EDITOR .env
docker compose up -d --build
docker compose logs -f
```

To publish the port directly for local testing, uncomment the `ports:` block in
`docker-compose.yaml`. Note that a directly published instance has no HTTPS, so
the session cookie will not stick — see above.

---

## Photos

### Layout

One subdirectory per album under the photos volume. No nesting: the server
serves exactly `photos/<album>/<file>` and rejects anything deeper.

```
/photos
├── Family
│   ├── 001.jpg
│   └── 002.jpg
├── Holidays
│   └── beach.jpg
└── Weddings
    └── ceremony.jpg
```

Accepted extensions: `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.heic`
`.heif`. **Use JPEG or PNG.** The server will happily serve `.webp` and
`.heic`, but Safari 12 cannot decode either of them — WebP support arrived in
iOS 14 and HEIC has never worked in mobile Safari. Those files will show up as
skipped photos on the frame, not as an error you can see.

Filenames may contain spaces. Dotfiles are skipped.

### Downscale before uploading

**This is not optional.** The iPad Air 1 has **1 GB of RAM** shared with the
OS. A full-resolution photo from any modern camera will exhaust it and Safari
will kill the page — the frame goes white or reloads in a loop.

The iPad Air 1 screen is 2048 × 1536. Resize the long edge to 2048 and strip
metadata:

```bash
# ImageMagick, in place, only shrinks and never upscales — note the escaped '>'
mogrify -resize '2048x2048>' -quality 82 -strip -interlace Plane *.jpg

# ImageMagick, writing to a separate output directory
mkdir -p out && magick mogrify -path out -resize '2048x2048>' -quality 82 -strip *.jpg

# macOS, no extra tools
mkdir -p out && sips -Z 2048 *.jpg --out out/
```

Aim for well under 1 MB per file. The client page keeps at most two photo
layers in the DOM, preloads exactly one image ahead, destroys the outgoing
layer after every crossfade, and reloads itself every 4 hours precisely because
this device leaks bitmaps — but none of that saves you from a 12 MP original.

### Populating the volume

The volume is mounted read-only, so populate it out of band:

```bash
# Option A: mount it rw once, copy in, then set it back to :ro
docker cp ./Family <container>:/photos/

# Option B: rsync into the volume's host path on the VPS
rsync -av ./Family/ /var/lib/docker/volumes/<project>_photos/_data/Family/
```

New photos appear without a restart: the library is rescanned every `SCAN_MS`
(default 300000 ms in `server.js`, overridden to 60000 in
`docker-compose.yaml`). `MAX_PHOTOS_PER_ALBUM` caps how many files per album
are served; the list is sorted **before** it is capped, so the selected subset
is stable across rescans rather than depending on filesystem enumeration order.

---

## The iPad

### First launch — authenticating

Open Safari once with the key in the query string:

```
https://frame.example.com/?k=<FRAME_KEY>
```

The server verifies the key, sets the `__Host-spf` cookie, and returns a **303
redirect to the bare path**. The secret is therefore never left in browser
history, never sent in a `Referer` header (the app also sets
`Referrer-Policy: no-referrer`), and never written to a proxy access log for
the page you actually keep open.

The cookie value is an HMAC derived from `FRAME_KEY`, not the key itself, so a
stolen cookie jar cannot be turned back into a shareable `?k=` link. It lasts
400 days — this is a kiosk, not a session.

### Then, in order

1. **Add to Home Screen.** Share → Add to Home Screen. Launch from that icon,
   not from Safari: the page declares `apple-mobile-web-app-capable`, so the
   home-screen launcher runs it full screen with no browser chrome.
2. **Settings → Display & Brightness → Auto-Lock → Never.**
3. **Do Not Disturb on**, and notifications off for everything
   (Settings → Notifications). A banner over a photo frame ruins it, and a
   notification tap can navigate away from the page.
4. **Guided Access** to lock it into the page:
   Settings → Accessibility → Guided Access → on, set a passcode, then
   triple-click the Home button while the frame is open and tap Start.
5. Set the iPad's own hardware brightness to maximum. The frame dims by
   overlaying black at variable opacity, so its brightness control only ever
   works downward from whatever the hardware is set to.
6. Keep it on power. This device's battery is a decade old.

### Diagnostics panel

**Tap three times within about a second** to open it. It shows the bridge
state, which HA route is in use, photo and album counts, failure counters and
the current settings source. A single tap closes it, and it auto-hides after 45
seconds.

This is the fastest way to answer "is the frame actually talking to the
bridge?" while standing in front of it.

---

## Operating it

### `./verify.sh`

```bash
./verify.sh
echo $?   # must be 0
```

The regression harness. It boots the real `server.js` against Home Assistant
stubs it creates itself, in a temporary directory, on ports it allocates
itself. It does **not** read your `.env` and does **not** touch your photos
volume. Requires `bash`, `curl` and `node` — no test framework.

It covers, in order:

| Section | What it asserts |
| --- | --- |
| Static analysis | `server.js` parses; the client page contains no frame key, no bearer token, no HA host or API reference, and no optional chaining or nullish coalescing (both fatal on Safari 12); `npm audit` reports no high or critical findings |
| Authentication and session | `/healthz` open; `/`, `/api/state`, `/photos/...` all 401 without credentials; a wrong `?k=` rejected; a correct `?k=` returns 303 with no query string in `Location`; the cookie is `__Host-`-prefixed, HttpOnly, Secure, SameSite, `Path=/`; a cookie with undecodable percent-encoding yields 401, not 500 |
| Response contract | `/healthz` and `/api/state` return JSON carrying every documented key |
| Rate limiting and proxy trust | On a dedicated `TRUST_PROXY=1` instance: the offending forwarded address gets 429, an unrelated address still gets 401, and a cookie holder is served 200 even from the throttled address |
| Security headers | `nosniff`, `no-referrer`, CSP present, CSP includes `frame-ancestors` |
| Path safety | `../`, `%2e%2e` and deep traversal all blocked and leak no bytes; dotfiles not served; filenames with spaces served |
| Hostile input | Albums literally named `__proto__`, `constructor`, `toString` and `<img src=x onerror=alert(1)>` do not corrupt state or produce a 5xx; non-image files excluded; an oversized album is capped; an unreadable album does not abort the scan |
| Query-key mode | On a dedicated `ALLOW_QUERY_KEY=true` instance: a correct `?k=` serves the frame page with a 200 and still sets the session cookie, a repeat launch on the same URL is served again, `/api/state?k=` needs no redirect hop, and a wrong or absent key is still rejected |
| Home Assistant propagation | Album, display, brightness and interval all propagate from HA and revert |
| Failover and degradation | `haVia` reports primary, switches to fallback when the primary dies, `haOk` goes false only when both die, the last known album is retained, photos keep being served, and `haVia` returns to primary once it recovers |
| Logging | Log lines are JSON objects carrying `ts`, `level`, `message` |

A non-zero exit prints the failing labels. Read the "Harness notes" comment at
the top of `verify.sh` before concluding the server is broken — several
apparent failures are curl behaviours (Secure cookies require `127.0.0.1`;
`Set-Cookie` is discarded across a redirect without a jar).

One check is skipped when running as root, because a mode-`000` directory is
not enforced for root.

### Monitoring: `/healthz`

Unauthenticated, `Cache-Control: no-store`, intended for Uptime Kuma:

```json
{"ok":true,"ha":true,"haVia":"primary","haLastOk":"2026-08-04T12:00:00.000Z","albums":3,"photos":412}
```

**It returns 200/503 based on the photo library only, not on Home Assistant.**
`ok` is false (and the status is 503) when `PHOTOS_DIR` could not be read. When
Home Assistant is unreachable, `ha` is false but the status is still **200** —
deliberately, because an HA outage must not restart the container or page you at
3am. The `Dockerfile` healthcheck hits the same endpoint for the same reason.

Monitor the status code for "the bridge is broken", and alert separately on
`ha == false` for more than a few minutes if you want to catch a dead Tailscale
route (see [key expiry](#disable-key-expiry-on-both-nodes)).

### Authenticated state: `/api/state`

```json
{"album":"Family","display":true,"brightness":85,"interval":45,
 "haOk":true,"haError":null,"haVia":"primary","haLastOk":"...",
 "albums":{"Family":["photos/Family/001.jpg"]},"scannedAt":"..."}
```

`haError` is the place to look when `haOk` is false — it names the entity and
the failure per route, e.g. `input_number.photo_frame_interval: HTTP 404` for a
renamed helper, or `timeout` for a dead route.

### Logs

Single-line JSON on stdout/stderr, never containing `HA_TOKEN` or `FRAME_KEY`.
Compose keeps 3 × 10 MB. Events worth grepping for:

- `listening` — boot, and the only place the effective `trustProxy` is printed
- `ha route changed` — failover or recovery
- `ha unreachable, serving last known good state`
- `ha reachable but returned no usable state` — HA answered, but nothing
  usable came back. Four 401s (bad token) or four 404s (renamed helpers) look
  like this
- `auth throttled` — an address burned its allowance
- `photo scan failed`, `album scan failed`, `album photo cap reached`
- `skipping album with unsupported name`

### What happens when things break

| Failure | Behaviour |
| --- | --- |
| **Home Assistant unreachable** | The last known good album, display, brightness and interval are served indefinitely. `haOk` false, `haError` populated, `/healthz` still 200. Photos keep being served. |
| **HA reachable but a helper is renamed, or the token is bad** | The route still counts as reachable (so no route flapping), `haOk` goes false, and `haError` names the offending entity. Any helper that *did* answer still updates; an entity whose state is `unknown`, `unavailable`, `none` or unparseable keeps its previous value rather than blanking. |
| **The bridge unreachable from the iPad** | After 2 consecutive failed polls the page falls back to its own built-in time-of-day schedule: brightness 65 from 06:30, 95 from 09:00, 70 from 18:00, 35 from 21:30, screen off from 23:00; 45 s per photo; album `family`. It also caches the album's photo list in `localStorage`, so it keeps showing photographs across a reload. Open the diagnostics panel and the settings source will read `fallback schedule`. |
| **The Tailscale route down** | Automatic failover to `HA_BASE_URL_FALLBACK` (Nabu Casa). The active route is sticky, but every `HA_REPROBE_EVERY` poll cycles the primary is tried first, so the service returns to the tailnet automatically once it recovers. `haVia` tells you which one is live. |
| **A photo fails to load** | Skipped after 9 s; after 12 consecutive failures the slideshow pauses 20 s and retries. |
| **Memory pressure on the iPad** | The page reloads itself every 4 hours to keep leaked bitmaps from accumulating. |

Note that `HA_BASE_URL_FALLBACK` is ignored if it is identical to
`HA_BASE_URL`; there is then only one route and no failover.

### Common problems

| Symptom | Cause |
| --- | --- |
| The frame authenticates, then 401s on the next request | No HTTPS. The `Secure`/`__Host-` cookie was discarded. |
| One client's failed logins 429 everyone | `TRUST_PROXY` not set behind the proxy. |
| An album in the HA dropdown shows nothing | The dropdown option does not exactly match the directory name, or the directory name failed the allowlist (grep the log for `skipping album with unsupported name`). |
| Photos load but appear blank or skipped | `.webp` or `.heic` files — Safari 12 cannot decode them. |
| The frame reloads in a loop or goes white | Photos not downscaled; 1 GB of RAM exhausted. |
| The container exits immediately | A `ConfigError`. The message is on stderr; see below. |
| Everything worked for six months, then HA went unreachable | Tailscale node key expired. |

---

## Security posture

Stated honestly, because the alternative is a false sense of safety.

### `FRAME_KEY` is a shared secret, not authentication

It is one static string, shared by every device that ever opens the frame, with
no identity, no expiry and no revocation short of changing the value and
re-onboarding every device.

**What it does protect:** it keeps the family photographs off the open internet
and out of search engines (the app also sends `X-Robots-Tag: noindex,
nofollow`). A stranger who finds the URL sees `Unauthorized`. The photo
endpoints cannot be casually enumerated.

**What it does not protect:** anything, once the key leaks. It cannot tell one
device from another, so you cannot revoke a lost iPad without disrupting every
other device. It offers no protection against someone who has the URL and the
key — which, note, is exactly what anyone with physical access to an unlocked
iPad has, since the cookie is already there.

If the photographs warrant more than that, put **Cloudflare Access** (or any
identity-aware proxy) in front of the origin and require a real identity. That
is the intended upgrade path; nothing in this service fights it.

### The rate limiter slows brute force; it does not prevent it

`AUTH_MAX_FAILS` failures per `AUTH_WINDOW_MS` per client address, tracked in
memory in a map capped at 10 000 entries and swept periodically. Successful
cookie holders are never counted and never throttled.

It makes online guessing of a 48-character random key hopeless in practice. It
does not stop a distributed attempt from many addresses, it resets when the
container restarts, and with `TRUST_PROXY` misconfigured it either collapses to
one global bucket or can be evaded outright by a client-supplied
`X-Forwarded-For`. Its purpose is to blunt scanners, not to be a security
boundary.

### What is actually enforced

- The HA token stays server-side. `HA_BASE_URL` is validated at boot (http/https
  only, no embedded credentials); redirects from HA are refused rather than
  followed, so the token is never replayed at an unvalidated host; HA response
  bodies are capped at 1 MiB while being read.
- Only `GET` and `HEAD` exist. Everything else is 405.
- Photo files are served by explicit lookup, not a blanket static mount: album
  and file names are revalidated, the path is checked to be inside the root,
  and `realpath` is re-checked afterwards so a symlink inside the volume cannot
  export `/etc/passwd`.
- Album names are validated against an allowlist and every album map is
  null-prototype, so a directory named `__proto__` is inert.
- CSP is `default-src 'none'` with explicit allowances, `frame-ancestors
  'none'`, `base-uri 'none'`, `form-action 'none'`, plus `X-Frame-Options:
  DENY`, `nosniff`, `no-referrer` and `Cross-Origin-Resource-Policy:
  same-origin`. `'unsafe-inline'` is granted for script and style because the
  client page targets Safari 12 with no build step; everything it can reach is
  same-origin regardless.
- The key comparison is constant-time. A malformed `Cookie` header degrades to
  401, never to a 500 an attacker can trigger at will. Redirect targets are
  normalised so `//evil.example` cannot become an open redirect.
- Error responses never carry a stack trace or an internal path.
- The container runs as the unprivileged `node` user and the photos volume is
  mounted read-only.

### Rotating secrets

- **`FRAME_KEY`**: change it, redeploy, then re-open `https://.../?k=<new key>`
  on the iPad. Every existing cookie stops working, because the cookie value is
  derived from the key.
- **`HA_TOKEN`**: revoke it on the HA profile page, create a new one, update the
  environment, redeploy. The frame keeps showing the last known album
  throughout.

---

## Configuration reference

Copy `.env.example` to `.env` and edit. Only three variables are required:
**`HA_BASE_URL`**, **`HA_TOKEN`**, **`FRAME_KEY`**. Everything else has a
default.

| Variable | Default in `server.js` | Notes |
| --- | --- | --- |
| `PORT` | `3000` | 1 – 65535 |
| `HA_BASE_URL` | — | **Required.** Raw tailnet IP, e.g. `http://100.101.102.103:8123`. http/https only, no embedded credentials, trailing slashes stripped |
| `HA_BASE_URL_FALLBACK` | none | Nabu Casa URL. Ignored if identical to the primary |
| `HA_TOKEN` | — | **Required.** Long-lived access token, full API scope |
| `FRAME_KEY` | — | **Required.** ≥16 chars, ≤512, printable ASCII, no spaces, ≥8 distinct chars, not a known placeholder |
| `PHOTOS_DIR` | `/photos` | Resolved to an absolute path; symlinked mounts are realpath-resolved at boot |
| `HA_POLL_MS` | `10000` | 1000 – 3600000. The HA request timeout is derived from it: `clamp(HA_POLL_MS - 1000, 2000, 15000)` |
| `SCAN_MS` | `300000` | 5000 – 86400000. Photo library rescan interval |
| `HA_REPROBE_EVERY` | `30` | 1 – 10000. Poll cycles between primary re-probes while on the fallback |
| `MAX_PHOTOS_PER_ALBUM` | `5000` | 1 – 200000 |
| `AUTH_MAX_FAILS` | `10` | 1 – 1000 |
| `AUTH_WINDOW_MS` | `900000` | 1000 – 86400000 |
| `ALLOW_QUERY_KEY` | `false` | `true`/`1` or `false`/`0`. When true a valid `?k=` is served directly instead of 303'ing to the bare path — needed for an iOS home-screen web app, which cannot inherit Safari's cookie. Cost: the key persists in the icon URL on the device and appears in proxy access logs |
| `TRUST_PROXY` | `false` | Set to `1` behind a reverse proxy. Also accepts `true`, `false`, `loopback`, `uniquelocal`, or a comma-separated address list |
| `ENTITY_ALBUM` | `input_select.photo_frame_album` | Must match `domain.object_id` |
| `ENTITY_DISPLAY` | `input_boolean.photo_frame_display` | |
| `ENTITY_BRIGHTNESS` | `input_number.photo_frame_brightness` | |
| `ENTITY_INTERVAL` | `input_number.photo_frame_interval` | |

`docker-compose.yaml` overrides five of these defaults with more responsive
values: `HA_POLL_MS=5000`, `SCAN_MS=60000`, `HA_REPROBE_EVERY=12`,
`MAX_PHOTOS_PER_ALBUM=500`, `AUTH_WINDOW_MS=60000`. Those are the values that
actually apply to a Compose deployment unless you override them in `.env`.

### Configuration errors

Any out-of-range or malformed value is a **boot failure**, never a lazy
request-time crash:

```
smart-photo-frame: configuration error: SCAN_MS must be between 5000 and 86400000, got 1000
```

The process exits 1. **Only the first violation is reported**, so a value you
fix can reveal another behind it. Validation order is: missing required
variables (all named at once) → `FRAME_KEY` strength → `HA_BASE_URL` →
`HA_BASE_URL_FALLBACK` → `HA_POLL_MS` → `PORT` → `SCAN_MS` →
`HA_REPROBE_EVERY` → `MAX_PHOTOS_PER_ALBUM` → `AUTH_MAX_FAILS` →
`AUTH_WINDOW_MS` → `ALLOW_QUERY_KEY` → the four `ENTITY_*` variables. Note that `HA_POLL_MS` is
checked before `PORT`, which is not the order the table above lists.

Integers must be exact: `"10000 "` is fine (trimmed), but `1e4`, `10_000` and
`5000ms` are all rejected.

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | 200/503 on the photo library; the `ha` field is informational |
| `GET` | `/api/state` | cookie or `?k=` | `no-store`, `Vary: Cookie` |
| `GET` | `/photos/<album>/<file>` | cookie or `?k=` | `Cache-Control: private, max-age=3600`, range requests supported |
| `GET` | `/` and other static files | cookie or `?k=` | served from `public/`, `Cache-Control: no-cache` |

Anything other than `GET`/`HEAD` returns 405 with an `Allow: GET, HEAD` header.

---

## Known inconsistencies

Things in this repository that will mislead you if you take them at face value.
None of them break a working deployment; all were left in place because this
change was scoped to documentation only.

1. **`Dockerfile`'s own header comment says "Rename to `Dockerfile` before
   building; this file ships as `Dockerfile.txt`".** The file is already named
   `Dockerfile`. The comment is a leftover from the pipeline that generated it;
   ignore it.

2. **`docker-compose.yaml`'s header says "Copy `example.env` to `.env`".** No
   file named `example.env` exists. The template is `.env.example` — the name
   `.gitignore` explicitly un-ignores (`.env.*` followed by `!.env.example`)
   and the name this README uses.

3. **`verify.sh`'s header says "Run with: `bash verify.sh`".** The file is
   executable, so `./verify.sh` works too.

4. **Compose's inline defaults are not `server.js`'s defaults** for
   `HA_POLL_MS`, `SCAN_MS`, `HA_REPROBE_EVERY`, `MAX_PHOTOS_PER_ALBUM` and
   `AUTH_WINDOW_MS`. Both sets are listed above.

5. **`docs/` is empty**, and `prompts/`, `scripts/`, `reviews/`, `test/` and the
   `run*.sh` scripts are apparatus from the pipeline that generated this
   project, not part of the deployment. `.dockerignore` excludes all of them
   from the image.
