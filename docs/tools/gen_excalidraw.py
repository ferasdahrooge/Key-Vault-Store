#!/usr/bin/env python3
"""
Generates docs/architecture.excalidraw (and a static docs/architecture.svg preview).

    python3 docs/tools/gen_excalidraw.py
    python3 docs/tools/validate_excalidraw.py docs/architecture.excalidraw

No third-party dependencies. Output is deterministic (fixed seeds/ids) so diffs stay readable.
Edit the section builders below and re-run; do not hand-edit the generated JSON.
"""
import json
import math
import os
import textwrap
from html import escape

# Input/output paths.
HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
OUT_JSON = os.path.join(DOCS, "architecture.excalidraw")
OUT_SVG = os.path.join(DOCS, "architecture.svg")

# Text metrics used to size boxes around text.
FONT = 2          # Helvetica
LINE_HEIGHT = 1.15
CHAR_W = 0.56     # average glyph width as a fraction of font size (conservative)
PAD = 5           # Excalidraw's BOUND_TEXT_PADDING
UPDATED = 1760000000000

# --------------------------------------------------------------------------------------------
# Colour coding (also rendered as the legend)
# --------------------------------------------------------------------------------------------
STYLES = {
    #  name          stroke     background  strokeStyle  legend text
    "component": ("#1e1e1e", "#e9ecef", "solid", "Application component / code"),
    "control":   ("#2f9e44", "#b2f2bb", "solid", "Security control"),
    "encrypted": ("#1971c2", "#a5d8ff", "solid", "Encrypted data (at rest / in transit)"),
    "plaintext": ("#e8590c", "#ffd8a8", "solid", "Plaintext key or secret IN MEMORY only"),
    "root":      ("#f08c00", "#ffec99", "solid", "Root of trust: ejson private key"),
    "audit":     ("#6741d9", "#d0bfff", "solid", "Audit (hash-chained, append-only)"),
    "external":  ("#c2255c", "#fcc2d7", "solid", "External actor / consumer"),
    "failure":   ("#e03131", "#ffc9c9", "solid", "Failure / reject path"),
    "note":      ("#495057", "#fff9db", "solid", "Note"),
    "lane":      ("#495057", "#f1f3f5", "solid", "Flow lane title"),
    "boundary":  ("#e03131", "transparent", "dashed", "TRUST BOUNDARY (dashed red)"),
    "container": ("#495057", "transparent", "dashed", "Runtime container (dashed grey)"),
    "header":    ("#1e1e1e", "#ced4da", "solid", None),
    "yes":       ("#2f9e44", "#d3f9d8", "solid", None),
    "no":        ("#adb5bd", "#f8f9fa", "solid", None),
    "cell":      ("#868e96", "#ffffff", "solid", None),
}


# Generates sequential, deterministic element ids.
class Ids:
    def __init__(self):
        self.n = 0

    def __call__(self, prefix):
        self.n += 1
        return f"{prefix}-{self.n:04d}"


nid = Ids()
_seed = [1000]


# Deterministic pseudo-random seed for Excalidraw's hand-drawn rendering.
def seed():
    _seed[0] = (_seed[0] * 1103515245 + 12345) % 2147483647
    return _seed[0]


# Wraps text to fit a box of the given pixel width.
def wrap(text, width_px, fs):
    maxc = max(8, int((width_px - 2 * PAD - 12) / (fs * CHAR_W)))
    out = []
    for para in text.split("\n"):
        if not para.strip():
            out.append("")
            continue
        indent = "   " if para.startswith("• ") else ""
        out.extend(textwrap.wrap(para, maxc, subsequent_indent=indent, break_on_hyphens=False) or [""])
    return out


# Estimated pixel size of wrapped text.
def text_size(lines, fs):
    w = max((len(l) for l in lines), default=1) * fs * CHAR_W
    h = len(lines) * fs * LINE_HEIGHT
    return math.ceil(w), math.ceil(h)


# Common fields for any Excalidraw shape.
def base(kind, x, y, w, h, style="component", stroke_width=2, rounded=True):
    stroke, bg, sstyle, _ = STYLES[style]
    return {
        "id": nid(kind[:4]),
        "type": kind,
        "x": round(x, 2), "y": round(y, 2),
        "width": round(w, 2), "height": round(h, 2),
        "angle": 0,
        "strokeColor": stroke,
        "backgroundColor": bg,
        "fillStyle": "solid",
        "strokeWidth": stroke_width,
        "strokeStyle": sstyle,
        "roughness": 0,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": {"type": 3} if rounded else None,
        "seed": seed(),
        "version": 1,
        "versionNonce": seed(),
        "isDeleted": False,
        "boundElements": [],
        "updated": UPDATED,
        "link": None,
        "locked": False,
    }


# Creates a text element (optionally bound inside a container).
def text_el(x, y, lines, fs, align="left", valign="top", color="#1e1e1e", container=None):
    w, h = text_size(lines, fs)
    el = base("text", x, y, w, h, rounded=False)
    s = "\n".join(lines)
    el.update({
        "strokeColor": color,
        "backgroundColor": "transparent",
        "text": s,
        "originalText": s,
        "fontSize": fs,
        "fontFamily": FONT,
        "textAlign": align,
        "verticalAlign": valign,
        "containerId": container,
        "lineHeight": LINE_HEIGHT,
        "autoResize": True,
    })
    return el


# --------------------------------------------------------------------------------------------
# Section builder: elements are created in local coordinates, then translated into place.
# --------------------------------------------------------------------------------------------
# A group of elements forming one diagram section.
class Section:
    def __init__(self, key, title, subtitle=None):
        self.key = key
        self.title = title
        self.els = []
        self.by_id = {}
        self.add(text_el(40, 30, [title], 40, color="#1e1e1e"))
        if subtitle:
            self.add(text_el(40, 88, wrap(subtitle, 2400, 20), 20, color="#495057"))

    # Registers an element in this section.
    def add(self, el):
        el.setdefault("customData", {})
        el["customData"]["section"] = self.key
        self.els.append(el)
        self.by_id[el["id"]] = el
        return el

    # ---- shapes ---------------------------------------------------------------------------
    # Adds a labelled box; height grows to fit the text.
    def box(self, x, y, w, text, style="component", h=None, fs=18, align="center",
            valign="middle", min_h=0, kind="rectangle", bold_first=False):
        lines = wrap(text, w, fs)
        _, th = text_size(lines, fs)
        need = th + 2 * PAD + 24
        h = max(h or 0, need, min_h)
        r = self.add(base(kind, x, y, w, h, style))
        r["customData"]["role"] = "box"
        tw, _ = text_size(lines, fs)
        tw = min(tw, w - 2 * PAD)
        tx = x + PAD if align == "left" else x + (w - tw) / 2
        ty = y + PAD + 6 if valign == "top" else y + (h - th) / 2
        t = self.add(text_el(tx, ty, lines, fs, align, valign, container=r["id"]))
        t["width"] = tw
        r["boundElements"].append({"type": "text", "id": t["id"]})
        return r["id"]

    # Adds a thick trust-boundary rectangle with a label.
    def boundary(self, x, y, w, h, label, style="boundary"):
        r = self.add(base("rectangle", x, y, w, h, style, stroke_width=3, rounded=False))
        r["customData"]["role"] = "boundary"
        r["customData"]["layer"] = "back"
        stroke = STYLES[style][0]
        t = self.add(text_el(x + 14, y + 10, [label], 18, color=stroke))
        t["customData"]["layer"] = "back"
        return r["id"]

    # Adds free-standing text.
    def label(self, x, y, text, fs=18, w=1000, color="#1e1e1e"):
        return self.add(text_el(x, y, wrap(text, w, fs), fs, color=color))["id"]

    # Bottom / right edge of an element, for positioning neighbours.
    def bottom(self, rid):
        e = self.by_id[rid]
        return e["y"] + e["height"]

    def right(self, rid):
        e = self.by_id[rid]
        return e["x"] + e["width"]

    # ---- arrows ---------------------------------------------------------------------------
    # Adds an arrow between two elements, with an optional label and waypoints.
    def arrow(self, a, b, label=None, sides=None, dashed=False, color="#1e1e1e", via=None,
              both=False, label_w=320):
        A, B = self.by_id[a], self.by_id[b]
        via = via or []
        s_side, e_side = sides if sides else (None, None)
        p0 = anchor(A, s_side, via[0] if via else center(B))
        p1 = anchor(B, e_side, via[-1] if via else center(A))
        pts_abs = [p0] + list(via) + [p1]
        xs = [p[0] for p in pts_abs]
        ys = [p[1] for p in pts_abs]
        el = base("arrow", p0[0], p0[1], max(xs) - min(xs), max(ys) - min(ys), rounded=False)
        el.update({
            "strokeColor": color,
            "backgroundColor": "transparent",
            "strokeStyle": "dashed" if dashed else "solid",
            "roundness": None,
            "points": [[round(px - p0[0], 2), round(py - p0[1], 2)] for px, py in pts_abs],
            "lastCommittedPoint": None,
            "startBinding": {"elementId": a, "focus": 0, "gap": 6},
            "endBinding": {"elementId": b, "focus": 0, "gap": 6},
            "startArrowhead": "arrow" if both else None,
            "endArrowhead": "arrow",
            "elbowed": False,
        })
        self.add(el)
        A["boundElements"].append({"type": "arrow", "id": el["id"]})
        B["boundElements"].append({"type": "arrow", "id": el["id"]})
        if label:
            lines = wrap(label, label_w, 16)
            tw, th = text_size(lines, 16)
            mx, my = midpoint(pts_abs)
            t = self.add(text_el(mx - tw / 2, my - th / 2, lines, 16, "center", "middle",
                                 color="#343a40", container=el["id"]))
            el["boundElements"].append({"type": "text", "id": t["id"]})
        return el["id"]

    # ---- geometry -------------------------------------------------------------------------
    # Bounding box of everything in the section.
    def bbox(self):
        xs, ys, xe, ye = [], [], [], []
        for e in self.els:
            xs.append(e["x"]); ys.append(e["y"])
            xe.append(e["x"] + e["width"]); ye.append(e["y"] + e["height"])
        return min(xs), min(ys), max(xe), max(ye)

    # Moves every element in the section.
    def translate(self, dx, dy):
        for e in self.els:
            e["x"] = round(e["x"] + dx, 2)
            e["y"] = round(e["y"] + dy, 2)


# Centre point of an element.
def center(e):
    return (e["x"] + e["width"] / 2, e["y"] + e["height"] / 2)


# Point on an element's edge where an arrow should attach.
def anchor(e, side, toward):
    cx, cy = center(e)
    if side == "right":
        return (e["x"] + e["width"], cy)
    if side == "left":
        return (e["x"], cy)
    if side == "top":
        return (cx, e["y"])
    if side == "bottom":
        return (cx, e["y"] + e["height"])
    dx, dy = toward[0] - cx, toward[1] - cy
    if dx == 0 and dy == 0:
        return (cx, cy)
    hw, hh = e["width"] / 2, e["height"] / 2
    t = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9)
    return (cx + dx * t, cy + dy * t)


# Middle point along a polyline (for arrow labels).
def midpoint(pts):
    segs = list(zip(pts, pts[1:]))
    lens = [math.dist(p, q) for p, q in segs]
    half = sum(lens) / 2
    for (p, q), L in zip(segs, lens):
        if half <= L and L > 0:
            f = half / L
            return (p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)
        half -= L
    return pts[-1]


# --------------------------------------------------------------------------------------------
# Legend + title
# --------------------------------------------------------------------------------------------
# Title block and colour legend.
def legend():
    s = Section("legend", "Key Vault: architecture, security model & flows",
                "Self-hosted team secrets manager. Express 5 + PostgreSQL 16 + React SPA. Server-side "
                "envelope encryption (AES-256-GCM) rooted in an ejson keypair. Sections: A system "
                "architecture, B key hierarchy, C data model, D flows 1-10, E RBAC, F audit chain, G threat model.")
    s.label(40, 150, "Legend / colour coding", 28)
    y = 210
    col = 0
    items = [k for k, v in STYLES.items() if v[3]]
    for i, k in enumerate(items):
        x = 40 + (i % 3) * 560
        yy = y + (i // 3) * 90
        if k in ("boundary", "container"):
            r = s.add(base("rectangle", x, yy, 120, 60, k, stroke_width=3, rounded=False))
            r["customData"]["role"] = "box"
        else:
            r = s.add(base("rectangle", x, yy, 120, 60, k))
            r["customData"]["role"] = "box"
        s.label(x + 140, yy + 18, STYLES[k][3], 18, w=420)
    yy = y + ((len(items) + 2) // 3) * 90
    # arrow legend
    a = s.box(40, yy, 160, "A", "component", fs=18)
    b = s.box(420, yy, 160, "B", "component", fs=18)
    s.arrow(a, b, "data / call flow", sides=("right", "left"))
    c = s.box(660, yy, 160, "A", "component", fs=18)
    d = s.box(1040, yy, 160, "B", "component", fs=18)
    s.arrow(c, d, "optional / async / reference", sides=("right", "left"), dashed=True)
    s.label(40, yy + 110, "Arrows are bound to shapes: drag a box and its arrows and labels follow. "
            "Regenerate with: python3 docs/tools/gen_excalidraw.py", 16, w=1700, color="#495057")
    return s


# --------------------------------------------------------------------------------------------
# A. System architecture
# --------------------------------------------------------------------------------------------
# Section A: system architecture and trust boundaries.
def section_a():
    s = Section("A", "A. System architecture & trust boundaries",
                "One Node 24 process serves the SPA and the API from the same origin. Secrets for the "
                "server itself come only from the ejson file, decrypted in memory at boot.")
    # left column: people & browser
    users = s.box(40, 170, 440, "Team members\n(invite-only, MFA mandatory)", "external", fs=20)
    s.boundary(20, 330, 480, 640, "TRUST BOUNDARY: browser (untrusted)")
    spa = s.box(40, 380, 440,
                "Browser SPA: React 18 + Vite + TanStack Query + Tailwind\n"
                "• served by Express from web/dist (same origin, no CORS)\n"
                "• values masked by default; auto re-mask + clipboard clear after 30 s\n"
                "• idle-lock overlay; red banner in protected envs\n"
                "• x-csrf-token from GET /api/csrf\n"
                "• passkeys via @simplewebauthn/browser",
                "component", align="left", fs=18)
    s.arrow(users, spa, "uses")

    # vault host
    HX, HY, HW = 580, 150, 1340
    LX, LW = 640, 580      # left stack
    RX, RW = 1310, 560     # right stack
    y = 270
    pino = s.box(LX, y, LW, "pino-http logging\nredacts value, *.password, authorization, cookie", "control")
    y = s.bottom(pino) + 60
    helm = s.box(LX, y, LW, "helmet: strict CSP (default-src 'self'; script-src 'self'; object-src 'none'; "
                 "frame-ancestors 'none'; base-uri 'none'), HSTS preload, Referrer-Policy no-referrer, "
                 "Cache-Control: no-store on /api", "control")
    y = s.bottom(helm) + 60
    sess = s.box(LX, y, LW, "express-session + connect-pg-simple\ncookie __Host-kv.sid: HttpOnly, Secure, "
                 "SameSite=Strict; 15 min idle / 8 h absolute; regenerated on login & privilege change", "control")
    y = s.bottom(sess) + 60
    csrf = s.box(LX, y, LW, "csrf-sync (synchroniser token, every non-GET)\nexpress-rate-limit (login 10/min/IP), "
                 "zod on every route, 256 KB body cap, 64 KB per value", "control")
    y = s.bottom(csrf) + 60
    routes = s.box(LX, y, LW, "Routers: auth, invites, admin, users, projects / envs / secrets / members / "
                   "tokens / compare, exchange (ejson import/export), access-requests, audit\n"
                   "requireEnvRole(min) → req.envCtx; non-member → 404", "component")
    y = s.bottom(routes) + 60
    svcs = s.box(LX, y, LW, "Services: secretService (versions, reveal, rollback), exchangeService, "
                 "audit (hash chain, advisory lock)", "component")

    static = s.box(RX, 270, RW, "Static SPA (web/dist) + index.html fallback\nGET /healthz → { ok: true }", "component")
    mach = s.box(RX, s.by_id[sess]["y"], RW, "/api/v1 machine API\nAuthorization: Bearer kv_st_… "
                 "(sha256 lookup, scopes read/export, expiry, revocation); no cookies, no CSRF", "control")
    crypto = s.box(RX, s.by_id[routes]["y"], RW, "Crypto core (crypto/envelope.ts)\nKEKs by kid, HKDF system key, "
                   "DEK LRU cache (60 s TTL, zeroed on evict), AES-256-GCM + AAD", "plaintext")
    cfg = s.box(RX, s.bottom(crypto) + 70, RW, "Config loader (config/ejson.ts + index.ts)\ndecrypt "
                "secrets.<env>.ejson in memory → zod → deepFreeze. FAIL CLOSED: no key / bad value → exit(1)",
                "plaintext")
    cont_bottom = max(s.bottom(svcs), s.bottom(cfg)) + 40
    s.boundary(HX + 30, 220, HW - 60, cont_bottom - 220,
               "Container: node:24-alpine, non-root, read-only rootfs, cap_drop ALL, no-new-privileges",
               style="container")
    keys = s.box(RX, cont_bottom + 50, RW, "/opt/ejson/keys/<public key hex>\nejson PRIVATE key: root of trust. "
                 "Mounted read-only (Docker secret / deploy system). NEVER in git or the image.", "root")
    host_bottom = s.bottom(keys) + 40
    s.boundary(HX, HY, HW, host_bottom - HY, "TRUST BOUNDARY: vault server host (trusted; holds KEK in memory)")

    s.arrow(spa, pino, "HTTPS: session cookie + x-csrf-token", sides=("right", "left"))
    s.arrow(pino, helm, sides=("bottom", "top"))
    s.arrow(helm, sess, "/api/*", sides=("bottom", "top"))
    s.arrow(sess, csrf, sides=("bottom", "top"))
    s.arrow(csrf, routes, sides=("bottom", "top"))
    s.arrow(routes, svcs, sides=("bottom", "top"))
    s.arrow(helm, mach, "/api/v1/*")
    # Elbow route through the gutter between the columns: a diagonal would cut through Routers,
    # and the right column is stacked (crypto, config) below the machine API.
    m, v = s.by_id[mach], s.by_id[svcs]
    gx = (v["x"] + v["width"] + m["x"]) / 2
    s.arrow(mach, svcs, "scoped reads / exports", sides=("left", "right"), label_w=80,
            via=[(gx, m["y"] + m["height"] / 2), (gx, v["y"] + v["height"] / 2)])
    s.arrow(svcs, crypto, "encrypt / decrypt")
    s.arrow(cfg, crypto, "KEKs, keyring", sides=("top", "bottom"))
    s.arrow(keys, cfg, "private key (read at boot)", sides=("top", "bottom"))
    s.arrow(helm, static, "GET /*")

    # right column: CI, service, git
    OX, OW = 2020, 520
    ci = s.box(OX, s.by_id[mach]["y"] - 40, OW, "CI / deploy pipeline\nholds service token kv_st_… "
               "(scoped, expiring, revocable)", "external")
    svc = s.box(OX, s.bottom(ci) + 140, OW, "Consuming service at runtime\nconfig/secrets.production.ejson "
                "+ its OWN ejson private key → ejson decrypt at boot", "external")
    git = s.box(OX, s.by_id[cfg]["y"] - 10, OW, "Git repository\nconfig/secrets.development.ejson\n"
                "config/secrets.production.ejson\nciphertext + _public_key only: safe to commit", "encrypted")
    s.arrow(ci, mach, "GET /api/v1/secrets  Bearer kv_st_…", sides=("left", "right"))
    s.arrow(ci, svc, "deploys exported .ejson (encrypted to the service key)", sides=("bottom", "top"))
    s.arrow(git, cfg, "secrets.<env>.ejson", sides=("left", "right"))

    # database below host
    DY = host_bottom + 120
    s.boundary(LX - 40, DY, LW + 80, 520, "TRUST BOUNDARY: PostgreSQL 16 (sees ciphertext only)")
    pg = s.box(LX, DY + 60, LW, "PostgreSQL 16 via Prisma\nusers · passkeys · totp_secrets (encrypted) · "
               "recovery_codes (argon2id) · invites (sha256) · projects · environments (wrapped DEK) · "
               "environment_members · secrets · secret_versions (AES-GCM ciphertext) · service_tokens (sha256) · "
               "access_requests · audit_log (INSERT-only trigger + hash chain) · session", "encrypted")
    s.arrow(svcs, pg, "Prisma: ciphertext, hashes, metadata", sides=("bottom", "top"))

    backup = s.box(40, DY + 60, 440, "Backups\npg_dump = ciphertext only.\nThe ejson private key must be "
                   "backed up SEPARATELY and OFFLINE. Lose it and every secret is lost.", "failure")
    s.arrow(pg, backup, "pg_dump", sides=("left", "right"), dashed=True)
    return s


# --------------------------------------------------------------------------------------------
# B. Key hierarchy
# --------------------------------------------------------------------------------------------
# Section B: key hierarchy and envelope encryption.
def section_b():
    s = Section("B", "B. Key hierarchy & envelope encryption",
                "Each environment is a separately keyed vault. Only ciphertext is persisted; plaintext keys live "
                "in process memory and are zeroed after use.")
    W = 620
    k = s.box(40, 160, W, "ejson private key (Curve25519, 32 bytes, hex)\nprod: /opt/ejson/keys/<pub>  ·  "
              "dev: ~/.ejson/keys/<pub>\noverride: EJSON_KEYDIR", "root", fs=20)
    f = s.box(40, s.bottom(k) + 130, W, "config/secrets.<env>.ejson (committed)\n_public_key · master_kek.{v1,v2…} "
              "· _active_kek · session_secret · database_url · import_keypair{_public, private}", "encrypted", fs=20)
    fmt = s.box(760, 160, 600, "ejson value format\nEJ[1:<ephemeral pub b64>:<nonce b64>:<box b64>]\n"
                "NaCl box = Curve25519 + XSalsa20-Poly1305; one ephemeral keypair per session, fresh 24-byte "
                "nonce per value. _-prefixed keys, numbers, bools, null stay plaintext. Native TS codec "
                "(tweetnacl), interop-tested against the Go CLI.", "note", align="left", fs=18)
    kek = s.box(40, s.bottom(f) + 150, W, "Master KEK vN (256-bit)\nmemory only: never on disk, in env vars or "
                "in logs", "plaintext", fs=20)
    s.arrow(k, f, "nacl.box.open per value", sides=("bottom", "top"))
    s.arrow(f, kek, "boot: decrypt (strict) → zod → deepFreeze", sides=("bottom", "top"))

    other = s.box(760, s.by_id[f]["y"] + 40 + s.by_id[f]["height"] + 60, 600,
                  "Other boot secrets (memory only)\n• session_secret → signs session cookie\n"
                  "• database_url → Prisma / pg pool\n• import_keypair.private → opens uploaded ejson imports",
                  "plaintext", align="left")
    s.arrow(f, other, "same decrypt")

    y = s.bottom(kek) + 170
    wr = s.box(40, y, W, "Environment row: wrappedDek + dekIv + dekTag + kekId + dekVersion + encCount\n"
               "(one random 256-bit DEK per environment)", "encrypted")
    sysk = s.box(760, y, 600, "System key = HKDF-SHA256(KEK, info \"kv-system\")\nderived per KEK id; "
                 "active first, older tried on decrypt", "plaintext")
    s.arrow(kek, wr, "AES-256-GCM wrap · AAD \"kv1-dek|<kekId>\"", sides=("bottom", "top"))
    s.arrow(kek, sysk, "HKDF")

    y = max(s.bottom(wr), s.bottom(sysk)) + 170
    cache = s.box(40, y, W, "Plaintext DEK in LRU cache\n60 s TTL, Buffer.fill(0) on eviction", "plaintext")
    totp = s.box(760, y, 600, "TotpSecret.ciphertext + iv + tag\nAAD \"kv1-sys|<context>\"", "encrypted")
    s.arrow(wr, cache, "unwrap on demand with KEK[kekId]", sides=("bottom", "top"))
    s.arrow(sysk, totp, "AES-256-GCM", sides=("bottom", "top"))

    y = s.bottom(cache) + 190
    sv = s.box(40, y, W, "SecretVersion.ciphertext + iv + tag + dekVersion\nimmutable, one row per version",
               "encrypted", fs=20)
    s.arrow(cache, sv, "AES-256-GCM, 96-bit random IV · AAD \"kv1|envId|secretId|version|key\"",
            sides=("bottom", "top"), label_w=420)
    cnt = s.box(760, s.by_id[sv]["y"] - 60, 600, "Nonce budget\nencCount++ atomically per encryption; "
                "auto-rotate the DEK at 2^30 (NIST SP 800-38D caps random 96-bit IVs at 2^32 per key)", "control")
    aad = s.box(760, s.bottom(cnt) + 40, 600, "AAD binding\nciphertext copied to another row, version, key "
                "name or environment fails the GCM tag check. All failures return one uniform "
                "\"decryption failed\" (no oracle).", "control")
    s.arrow(cnt, sv, sides=("left", "right"), dashed=True)
    return s


# --------------------------------------------------------------------------------------------
# C. Data model
# --------------------------------------------------------------------------------------------
# Section C: data model.
def section_c():
    s = Section("C", "C. Domain & data model (Prisma / PostgreSQL)",
                "Organization (single instance) → Project → Environment (own DEK, own members) → Secret → "
                "SecretVersion. Blue = holds ciphertext or hashes only.")
    W = 400
    COLS = [40, 520, 1000, 1480, 1960]
    ent = {}

    # Adds one entity box in column `col`.
    def e(name, col, y, fields, style="component"):
        ent[name] = s.box(COLS[col], y, W, name + "\n" + "\n".join(fields), style, fs=16, align="left",
                          valign="top")
        return ent[name]

    r1 = 170
    e("Project", 0, r1, ["id uuid PK", "slug unique, name, description", "createdBy, createdAt"])
    e("Environment", 1, r1, ["id PK · projectId FK", "slug (dev|staging|prod|custom), unique per project",
                             "name, color, protected bool", "wrappedDek, dekIv, dekTag (bytes)", "kekId, dekVersion",
                             "encCount bigint"], "encrypted")
    e("Secret", 2, r1, ["id PK · envId FK", "key (unique per env)", "type: password|apikey|connstr|cert|note|json",
                        "description, tags[]", "currentVersion, expiresAt?", "deletedAt? (soft delete)", "updatedBy"])
    e("SecretVersion", 3, r1, ["PK (secretId, version)", "ciphertext, iv, tag (AES-GCM)", "dekVersion",
                               "comment, createdBy, createdAt", "IMMUTABLE"], "encrypted")
    e("AuditLog", 4, r1, ["seq bigserial PK", "at, actorType user|token|system", "actorId, action",
                          "projectId?, envId?, secretId?", "ip, userAgent, meta jsonb", "prevHash, hash unique",
                          "UPDATE/DELETE/TRUNCATE blocked by trigger"], "audit")
    row1_bottom = max(s.bottom(ent[n]) for n in ent)
    for n in list(ent):
        s.by_id[ent[n]]["height"] = row1_bottom - r1

    r2 = row1_bottom + 160
    e("User", 0, r2, ["id PK · email unique · name", "passwordHash (argon2id)", "isAdmin (no secret access)",
                      "status invited|active|disabled", "failedLogins, lockedUntil"])
    e("EnvironmentMember", 1, r2, ["PK (envId, userId)", "role viewer|editor|owner", "expiresAt? (time-boxed grant)"])
    e("ServiceToken", 2, r2, ["id PK · envId FK · name", "tokenHash sha256 unique, prefix", "scopes read|export",
                              "ejsonPublicKey?", "expiresAt, lastUsedAt, revokedAt"], "encrypted")
    e("AccessRequest", 3, r2, ["id PK · envId FK · userId FK", "role, reason, durationMin",
                               "status pending|approved|denied|expired", "decidedBy, decidedAt"])
    e("Session", 4, r2, ["sid PK (connect-pg-simple)", "sess json: userId, loginAt, mfaAt, pending MFA, "
                         "enrollment mode", "expire"])
    row2 = ["User", "EnvironmentMember", "ServiceToken", "AccessRequest", "Session"]
    row2_bottom = max(s.bottom(ent[n]) for n in row2)
    for n in row2:
        s.by_id[ent[n]]["height"] = row2_bottom - r2

    r3 = row2_bottom + 200
    e("Passkey", 0, r3, ["id PK · userId FK", "credentialId unique (b64url)", "publicKey, counter, transports[]",
                         "name, lastUsedAt"])
    e("TotpSecret", 1, r3, ["userId PK/FK", "ciphertext, iv, tag (system key)", "confirmed",
                            "lastStep (replay protection)"], "encrypted")
    e("RecoveryCode", 2, r3, ["id PK · userId FK", "codeHash (argon2id)", "usedAt? (10 issued)"], "encrypted")
    e("Invite", 3, r3, ["id PK · userId FK", "tokenHash sha256 unique", "expiresAt (24 h), usedAt (single use)",
                        "createdBy"], "encrypted")

    R = ("right", "left")
    D = ("bottom", "top")
    s.arrow(ent["Project"], ent["Environment"], "1 : N", sides=R)
    s.arrow(ent["Environment"], ent["Secret"], "1 : N", sides=R)
    s.arrow(ent["Secret"], ent["SecretVersion"], "1 : N", sides=R)
    s.arrow(ent["Environment"], ent["EnvironmentMember"], "1 : N", sides=D)
    s.arrow(ent["Environment"], ent["ServiceToken"], "1 : N", sides=("bottom", "top"))
    s.arrow(ent["Environment"], ent["AccessRequest"], "1 : N", sides=("bottom", "top"))
    s.arrow(ent["User"], ent["EnvironmentMember"], "1 : N", sides=R)
    s.arrow(ent["User"], ent["Passkey"], "1 : N", sides=D)
    s.arrow(ent["User"], ent["TotpSecret"], "1 : 0..1", sides=D)
    s.arrow(ent["User"], ent["RecoveryCode"], "1 : N", sides=D)
    s.arrow(ent["User"], ent["Invite"], "1 : N", sides=D)
    s.arrow(ent["AuditLog"], ent["Session"], "no FKs: audit rows outlive deleted entities", sides=D, dashed=True,
            label_w=300)
    return s


# --------------------------------------------------------------------------------------------
# D. Flows
# --------------------------------------------------------------------------------------------
FLOWS = [
    ("1. Server boot (fail closed)", [
        ("NODE_ENV selects config/secrets.<env>.ejson (or SECRETS_FILE)", "component"),
        ("resolveKeydir: EJSON_KEYDIR, else /opt/ejson/keys (prod), else ~/.ejson/keys. Load <keydir>/<_public_key>, "
         "check derived pub matches", "root"),
        ("Decrypt every value in memory (strict: a plaintext value is an error)", "plaintext"),
        ("zod-validate (_active_kek must exist in master_kek) → deepFreeze", "control"),
        ("initCrypto: KEKs, HKDF system keys, empty DEK cache", "plaintext"),
        ("Prisma + session store, helmet/CSRF, listen :8200; /healthz", "component"),
    ], [(1, "Key missing, wrong key, bad MAC or invalid schema → log the path only (never values) → "
            "process.exit(1). The server never starts half-configured.")]),
    ("2. Invite → password → MFA enrolment → recovery codes", [
        ("Admin: POST /api/invites → one-time token, sha256 stored, 24 h, single use; audit invite.created", "control"),
        ("User opens /invite/<token>; GET shows email + name (404 if used/expired)", "component"),
        ("POST /invites/:token/accept {password}: ≥12 chars, strength + breached-list check, Argon2id m=64 MiB t=3 p=1",
         "control"),
        ("Session in enrolment mode: everything else → 403 mfa_enrollment_required", "control"),
        ("Enrol passkey (WebAuthn register) or TOTP (QR, confirm a code; seed encrypted with system key)", "encrypted"),
        ("10 recovery codes shown ONCE (argon2id hashed). Enrolment cleared; audit auth.mfa.*", "audit"),
    ], []),
    ("3. Login: password → pending session → MFA → regenerate", [
        ("POST /api/auth/login {email, password}; rate limit 10/min/IP", "control"),
        ("Argon2id verify; generic error on any failure (no user enumeration)", "control"),
        ("Pending session (not logged in): {mfaRequired, methods: totp | passkey | recovery}", "component"),
        ("POST /auth/mfa/totp (replay-protected lastStep) or passkey verify or recovery code", "control"),
        ("session.regenerate() → __Host-kv.sid, loginAt, mfaAt; SPA refetches CSRF token", "control"),
        ("15 min idle / 8 h absolute timeout; logout-all destroys every session", "control"),
    ], [(1, "5 consecutive failures → lockedUntil = now + 15 min; audit auth.login.failed / auth.login.locked; "
            "admin can unlock")]),
    ("4. Reveal a secret", [
        ("POST …/secrets/:id/reveal {version?}: session + CSRF", "component"),
        ("requireEnvRole(viewer): non-member → 404 (no enumeration); admins have no implicit access", "control"),
        ("Protected env and mfaAt older than 5 min → 401 reauth_required → modal → POST /auth/reauth → retry",
         "control"),
        ("Load Environment wrapped DEK → unwrap with KEK[kekId] (or 60 s cache hit)", "plaintext"),
        ("AES-256-GCM decrypt with AAD kv1|envId|secretId|version|key; tamper → 'decryption failed'", "plaintext"),
        ("Audit secret.reveal (key + version, never the value) → {value, version}, Cache-Control: no-store", "audit"),
        ("UI shows value, auto re-masks after 30 s; copy clears clipboard after 30 s", "component"),
    ], [(1, "Not a member → 404 not_found, identical to a missing environment")]),
    ("5. Create / update secret → new version → DEK auto-rotation", [
        ("POST / PATCH …/secrets (editor). Protected env needs confirm: \"<envSlug>\". zod: key regex, ≤64 KB",
         "control"),
        ("Transaction: version = currentVersion + 1", "component"),
        ("encCount++ atomically; encrypt with env DEK + AAD bound to the new version", "plaintext"),
        ("Insert immutable SecretVersion; bump Secret.currentVersion; audit secret.created / secret.updated",
         "audit"),
        ("encCount ≥ 2^30 → auto DEK rotation: new DEK, re-encrypt all versions in one tx, dekVersion++", "control"),
    ], [(3, "Rollback = new version that copies an old value (history is never rewritten); audit secret.rollback")]),
    ("6. ejson export to a service", [
        ("Service owner: ejson keygen → private key stays on the service host (/opt/ejson/keys)", "root"),
        ("Env owner + recent MFA: POST …/export {recipientPublicKey, keys?}", "control"),
        ("Server decrypts values with the DEK in memory, encrypts each to the recipient (ephemeral keypair, "
         "fresh nonce). The server cannot read the result.", "plaintext"),
        ("Audit export.ejson → download secrets.<env>.ejson (_public_key, _kv_meta, one field per secret)", "audit"),
        ("Commit to the service repo or ship with the deploy", "encrypted"),
        ("Service boots: ejson decrypt with its OWN private key", "external"),
    ], []),
    ("7. ejson import", [
        ("GET /api/import-key → the server's import public key (hex)", "component"),
        ("User writes JSON with _public_key = import key and runs `ejson encrypt` locally", "external"),
        ("POST …/import/preview {ejson} (editor): opened with import_keypair.private; nested keys → a__b", "plaintext"),
        ("Diff preview: new / changed / unchanged (no values shown)", "component"),
        ("POST …/import/commit → new SecretVersions encrypted with env DEK; audit import.ejson", "audit"),
    ], [(2, "Any value that is not ejson-encrypted is rejected (listed in `rejected`)")]),
    ("8. CI / service-token pull", [
        ("Owner + recent MFA: POST …/tokens → kv_st_<32 B base64url> shown once; sha256 stored; scopes, expiry, "
         "optional ejsonPublicKey", "control"),
        ("CI stores the token in its own secret store", "external"),
        ("GET /api/v1/secrets  Authorization: Bearer kv_st_… (no cookies, no CSRF)", "component"),
        ("sha256 lookup; scope check (read | export)", "control"),
        ("Returns {project, env, secrets} or an ejson doc encrypted to the token's key / ?pub=; audit token.use, "
         "lastUsedAt", "audit"),
    ], [(3, "Unknown, revoked or expired token → 401; missing scope → 403")]),
    ("9. Access request → time-boxed membership", [
        ("User POST …/access-requests {role, reason, durationMin}", "component"),
        ("Audit access.requested; env owners see it under toDecide", "audit"),
        ("Owner POST /access-requests/:id/decide {approve}", "control"),
        ("Approved → EnvironmentMember(role, expiresAt = now + durationMin); audit access.decided", "audit"),
        ("After expiresAt the membership is ignored → back to 404", "control"),
    ], [(0, "Admin self-grant is allowed but audited as member.admin_self_grant (owners alerted)")]),
    ("10. Key rotation: KEK, DEK, ejson keypair", [
        ("KEK: npm run secrets:edit → add master_kek.v2, set _active_kek = v2; deploy", "plaintext"),
        ("npm run rotate:kek re-wraps every Environment DEK (O(environments)); secret data untouched", "control"),
        ("Verify (all kekId = v2), then remove v1 from the ejson file", "component"),
        ("DEK: owner + recent MFA POST …/rotate-key → new DEK, re-encrypt every version in one tx; "
         "audit env.dek_rotated", "control"),
        ("ejson keypair: secrets:keygen → re-encrypt secrets file to the new pub → deploy new key file → delete "
         "old key (keep offline backup)", "root"),
    ], []),
]


# Section D: request flows.
def section_d():
    s = Section("D", "D. Flows (numbered lanes, left to right)",
                "Each lane is one request sequence. Red boxes below a step are the reject / failure branch.")
    LANE_W, STEP_W, GAP = 330, 330, 70
    y = 170
    for title, steps, branches in FLOWS:
        lane = s.box(40, y, LANE_W, title, "lane", fs=20, min_h=140)
        ids = []
        x = 40 + LANE_W + GAP
        for i, (txt, style) in enumerate(steps):
            ids.append(s.box(x, y, STEP_W, f"{i + 1}. {txt}", style, fs=16, min_h=140))
            x += STEP_W + GAP
        h = max(s.by_id[i]["height"] for i in ids + [lane])
        for i in ids + [lane]:
            el = s.by_id[i]
            el["height"] = h
            # re-centre the bound text vertically
            t = s.by_id[el["boundElements"][0]["id"]]
            t["y"] = el["y"] + (h - t["height"]) / 2
        s.arrow(lane, ids[0], sides=("right", "left"))
        for a, b in zip(ids, ids[1:]):
            s.arrow(a, b, sides=("right", "left"))
        bottom = y + h
        for step_idx, txt in branches:
            src = s.by_id[ids[step_idx]]
            br = s.box(src["x"], bottom + 60, STEP_W * 2 + GAP, txt, "failure", fs=16)
            s.arrow(ids[step_idx], br, "reject", sides=("bottom", "top"))
            bottom = max(bottom, s.bottom(br))
        y = bottom + 90
    return s


# --------------------------------------------------------------------------------------------
# E. RBAC
# --------------------------------------------------------------------------------------------
RBAC = [
    ("List secret keys / metadata (never values)", "YYY-"),
    ("Reveal value (audited; re-auth in protected envs)", "YYY-"),
    ("Create / update / delete / rollback", "-YY-"),
    ("Import ejson", "-YY-"),
    ("Export ejson (recent MFA)", "--Y-"),
    ("Create / revoke service tokens", "--Y-"),
    ("Manage members (recent MFA)", "--Y-"),
    ("Rotate environment DEK", "--Y-"),
    ("Edit env settings (protected, colour)", "--Y-"),
    ("View audit for own environments", "--YY"),
    ("Decide access requests", "--Y-"),
    ("Create projects / environments", "---Y"),
    ("Invite users, disable, unlock", "---Y"),
    ("Verify audit chain, export audit", "---Y"),
]


# Section E: RBAC matrix.
def section_e():
    s = Section("E", "E. RBAC matrix",
                "Per-environment roles viewer < editor < owner. Admin is a separate global flag that grants NO "
                "implicit secret access.")
    CW, RW, H, HH = 560, 160, 60, 80
    y = 160
    # Auto-height may grow a cell past H, so each row advances by its tallest cell.
    row = [s.box(40, y, CW, "Capability", "header", h=HH, fs=20)]
    for j, role in enumerate(["viewer", "editor", "owner", "admin (global)"]):
        row.append(s.box(40 + CW + j * RW, y, RW, role, "header", h=HH, fs=18))
    y = max(s.bottom(i) for i in row)
    for cap, marks in RBAC:
        row = [s.box(40, y, CW, cap, "cell", h=H, fs=17, align="left")]
        for j, m in enumerate(marks):
            row.append(s.box(40 + CW + j * RW, y, RW, "✔" if m == "Y" else "–", "yes" if m == "Y" else "no",
                             h=H, fs=22))
        y = max(s.bottom(i) for i in row)
    s.box(40, y + 40, CW + 4 * RW, "• Non-member → 404 (environments cannot be enumerated)\n"
          "• Admin self-grant allowed but audited (member.admin_self_grant) and owners alerted\n"
          "• Protected env (prod by default): editors confirm each change with the env slug; viewers need recent "
          "MFA to reveal; others file an AccessRequest for time-boxed access\n"
          "• The last owner of an environment cannot be removed\n"
          "• Service tokens: scope read → JSON / ejson pull; scope export → ejson only", "note", align="left",
          fs=17)
    return s


# --------------------------------------------------------------------------------------------
# F. Audit chain
# --------------------------------------------------------------------------------------------
# Section F: audit hash chain.
def section_f():
    s = Section("F", "F. Audit hash chain",
                "Every auth event, reveal, change, export, import, token use, membership change and rotation is "
                "appended. Secret values are never written to meta.")
    W = 380
    rows = []
    for i, (seq, prev, h) in enumerate([("n-1", "hash(n-2)", "a3f9…"), ("n", "a3f9…", "7c01…"),
                                        ("n+1", "7c01…", "e44b…")]):
        rows.append(s.box(40 + i * (W + 120), 170, W, f"AuditLog seq {seq}\naction, actor, ip, meta, at\n"
                          f"prevHash = {prev}\nhash = {h}", "audit", fs=18, align="left", valign="top"))
    for a, b in zip(rows, rows[1:]):
        s.arrow(a, b, "prevHash", sides=("right", "left"))
    fx = s.box(40, s.bottom(rows[0]) + 70, 3 * W + 240,
               "hash(n) = SHA-256( prevHash(n) + canonicalJSON({ action, actorType, actorId, projectId, envId, "
               "secretId, ip, userAgent, meta, at }) )\ncanonicalJSON = sorted keys, no whitespace. Genesis "
               "prevHash = 64 zeros.", "note", fs=18)
    w = (3 * W + 240 - 40) / 2
    y = s.bottom(fx) + 60
    lock = s.box(40, y, w, "Append: pg_advisory_xact_lock serialises writers so the chain never forks",
                 "control", fs=17)
    trig = s.box(40 + w + 40, y, w, "INSERT-only: migration trigger blocks UPDATE, DELETE and TRUNCATE on "
                 "AuditLog (plus DB role without UPDATE/DELETE in prod)", "control", fs=17)
    y = max(s.bottom(lock), s.bottom(trig)) + 60
    ver = s.box(40, y, w, "GET /api/audit/verify (admin) recomputes every hash from genesis → "
                "{ ok, checked, brokenAtSeq? }", "audit", fs=17)
    bad = s.box(40 + w + 40, y, w, "An edited, inserted or deleted row breaks the link → brokenAtSeq is the "
                "first bad row", "failure", fs=17)
    s.arrow(ver, bad, "mismatch", sides=("right", "left"))
    s.arrow(fx, lock, sides=("bottom", "top"), dashed=True)
    return s


# --------------------------------------------------------------------------------------------
# G. Threat model
# --------------------------------------------------------------------------------------------
THREATS = [
    ("Database dump / backup leaked", "Every value is AES-256-GCM ciphertext; the KEK is not in the DB; TOTP seeds "
     "encrypted; tokens, invites and recovery codes hashed"),
    ("Git repository leaked", "ejson files hold only ciphertext + public key; private key never committed or baked "
     "into the image"),
    ("Row swap / ciphertext tampering", "GCM tag + AAD binds ciphertext to env, secret, version and key name"),
    ("Stolen session cookie", "__Host-, HttpOnly, Secure, SameSite=Strict; 15 min idle / 8 h absolute; re-auth for "
     "sensitive ops; logout-all"),
    ("CSRF", "csrf-sync synchroniser token on every non-GET + SameSite=Strict"),
    ("Credential stuffing / brute force", "Argon2id, mandatory MFA, 10/min/IP rate limit, 15 min lockout after 5 "
     "failures, breached-password check, generic errors"),
    ("Environment enumeration", "Non-members get 404, identical to missing"),
    ("Insider admin", "No implicit secret access; self-grant audited and owners alerted"),
    ("XSS / clickjacking", "Strict CSP (script-src 'self', frame-ancestors 'none'), React escaping, no "
     "dangerouslySetInnerHTML"),
    ("Secrets leaking to logs / caches", "pino redaction, no values in audit meta, Cache-Control: no-store, values "
     "only via POST /reveal, one per call"),
    ("Shoulder surfing / clipboard", "Masked by default, re-mask and clipboard clear after 30 s, idle lock"),
    ("Leaked service token", "sha256-only storage, scopes, expiry, revocation, per-use audit + lastUsedAt"),
    ("Audit tampering", "Hash chain + INSERT-only trigger/role + /api/audit/verify"),
    ("AES-GCM nonce exhaustion", "Per-env DEK with encCount, auto-rotation at 2^30"),
    ("Loss of the ejson private key", "AVAILABILITY RISK: back the key up separately and offline. Without it the "
     "data is unrecoverable"),
    ("Full server compromise (KEK in memory)", "ACCEPTED RISK of server-side encryption; reduced by KEK/DEK "
     "rotation, least-privilege hosting, read-only container"),
]


# Section G: threat model summary.
def section_g():
    s = Section("G", "G. Threat model summary", "See SECURITY.md for the full model and scope.")
    TW, MW, H = 520, 1000, 64
    y = 160
    s.box(40, y, TW, "Threat", "header", h=H, fs=20)
    s.box(40 + TW, y, MW, "Mitigation", "header", h=H, fs=20)
    y += H
    for threat, mit in THREATS:
        style = "failure" if mit.startswith(("ACCEPTED", "AVAILABILITY")) else "cell"
        a = s.box(40, y, TW, threat, style, h=H, fs=18, align="left")
        b = s.box(40 + TW, y, MW, mit, "control" if style == "cell" else "failure", h=H, fs=17, align="left")
        h = max(s.by_id[a]["height"], s.by_id[b]["height"])
        for i in (a, b):
            el = s.by_id[i]
            el["height"] = h
            t = s.by_id[el["boundElements"][0]["id"]]
            t["y"] = el["y"] + (h - t["height"]) / 2
        y += h
    return s


# --------------------------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------------------------
# Frame drawn around a section.
def frame_for(sec, x, y):
    x0, y0, x1, y1 = sec.bbox()
    m = 40
    sec.translate(x - x0 + m, y - y0 + m)
    w, h = (x1 - x0) + 2 * m, (y1 - y0) + 2 * m
    fr = base("frame", x, y, w, h, rounded=False)
    fr.update({"name": sec.title, "strokeColor": "#bbb", "backgroundColor": "transparent",
               "strokeWidth": 2, "customData": {"section": sec.key, "role": "frame"}})
    # boundaries (layer "back") render beneath boxes; sort is stable for everything else
    sec.els.sort(key=lambda e: 0 if e.get("customData", {}).get("layer") == "back" else 1)
    for e in sec.els:
        e["frameId"] = fr["id"]
    return fr, w, h


# Lays out all sections and returns the Excalidraw document.
def build():
    rows = [
        [legend()],
        [section_a(), section_b()],
        [section_c(), section_e(), section_f()],
        [section_d()],
        [section_g()],
    ]
    elements = []
    GAP = 200
    y = 0
    for row in rows:
        x = 0
        row_h = 0
        for sec in row:
            fr, w, h = frame_for(sec, x, y)
            elements.extend(sec.els)
            elements.append(fr)  # frame after its children
            x += w + GAP
            row_h = max(row_h, h)
        y += row_h + GAP
    doc = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": elements,
        "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
        "files": {},
    }
    return doc


# --------------------------------------------------------------------------------------------
# Static SVG preview (no network, no dependencies)
# --------------------------------------------------------------------------------------------
# Renders a static SVG preview of the document.
def to_svg(doc):
    els = [e for e in doc["elements"] if not e["isDeleted"]]
    x0 = min(e["x"] for e in els) - 40
    y0 = min(e["y"] for e in els) - 80
    x1 = max(e["x"] + e["width"] for e in els) + 40
    y1 = max(e["y"] + e["height"] for e in els) + 40
    W, H = x1 - x0, y1 - y0
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {W:.0f} {H:.0f}" '
           f'width="{W / 4:.0f}" height="{H / 4:.0f}" font-family="Helvetica, Arial, sans-serif">',
           '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
           'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>',
           f'<rect x="{x0}" y="{y0}" width="{W}" height="{H}" fill="#ffffff"/>']
    by_id = {e["id"]: e for e in els}
    frames = [e for e in els if e["type"] == "frame"]
    for f in frames:
        out.append(f'<rect x="{f["x"]}" y="{f["y"]}" width="{f["width"]}" height="{f["height"]}" fill="#fcfcfd" '
                   f'stroke="#bbbbbb" stroke-width="2" rx="8"/>')
        out.append(f'<text x="{f["x"]}" y="{f["y"] - 14}" font-size="22" fill="#868e96">{escape(f["name"])}</text>')
    for e in els:
        t = e["type"]
        dash = ' stroke-dasharray="14 10"' if e["strokeStyle"] == "dashed" else ""
        if t == "rectangle":
            fill = "none" if e["backgroundColor"] == "transparent" else e["backgroundColor"]
            rx = 10 if e["roundness"] else 0
            out.append(f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" rx="{rx}" '
                       f'fill="{fill}" stroke="{e["strokeColor"]}" stroke-width="{e["strokeWidth"]}"{dash}/>')
        elif t == "arrow":
            pts = " ".join(f'{e["x"] + px},{e["y"] + py}' for px, py in e["points"])
            start = ' marker-start="url(#ah)"' if e["startArrowhead"] else ""
            out.append(f'<polyline points="{pts}" fill="none" stroke="{e["strokeColor"]}" stroke-width="2"{dash}'
                       f' marker-end="url(#ah)"{start}/>')
    for e in els:
        if e["type"] != "text":
            continue
        fs = e["fontSize"]
        lines = e["text"].split("\n")
        lh = fs * e["lineHeight"]
        cont = by_id.get(e["containerId"]) if e["containerId"] else None
        if cont and cont["type"] == "arrow":
            out.append(f'<rect x="{e["x"] - 4}" y="{e["y"] - 2}" width="{e["width"] + 8}" '
                       f'height="{e["height"] + 4}" fill="#ffffff" opacity="0.9"/>')
        if e["textAlign"] == "center":
            ax, anchor_ = e["x"] + e["width"] / 2, "middle"
        else:
            ax, anchor_ = e["x"], "start"
        tsp = "".join(f'<tspan x="{ax:.1f}" y="{e["y"] + (i + 0.8) * lh:.1f}">{escape(l)}</tspan>'
                      for i, l in enumerate(lines))
        out.append(f'<text font-size="{fs}" fill="{e["strokeColor"]}" text-anchor="{anchor_}">{tsp}</text>')
    out.append("</svg>")
    return "\n".join(out)


if __name__ == "__main__":
    doc = build()
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    with open(OUT_SVG, "w", encoding="utf-8") as fh:
        fh.write(to_svg(doc))
    print(f"wrote {OUT_JSON} ({len(doc['elements'])} elements) and {OUT_SVG}")
