#!/usr/bin/env python3
"""Structural + layout validator for docs/architecture.excalidraw (Python 3.9 stdlib only).

    python3 docs/tools/validate_excalidraw.py [path]      # default: docs/architecture.excalidraw

Errors (exit 1): JSON/shape problems, duplicate ids, dangling containerId/binding/frameId refs,
missing boundElements reciprocity, children outside their frame, overlapping frames, fonts below
the minimum, a frame without a title >= 28px, overlapping boxes within a section.
Warnings (exit 0): arrow segments that pass through a box they are not bound to.
"""
import json
import sys
from pathlib import Path

# Readability and layout limits the diagram must respect.
MIN_FONT = 16
MIN_TITLE_FONT = 28
EPS = 1.0  # boxes may touch; they must not overlap by more than this

# Fields every element must have, plus extra ones per element type.
COMMON = ["id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
          "fillStyle", "strokeWidth", "roughness", "opacity", "seed", "version", "versionNonce",
          "isDeleted", "boundElements", "locked"]
REQUIRED = {
    "rectangle": COMMON,
    "frame": COMMON + ["name"],
    "text": COMMON + ["text", "originalText", "fontSize", "fontFamily", "textAlign",
                      "verticalAlign", "containerId", "lineHeight"],
    "arrow": COMMON + ["points", "startBinding", "endBinding", "startArrowhead", "endArrowhead"],
}


# Element bounding box as (x1, y1, x2, y2).
def rect(e):
    return (e["x"], e["y"], e["x"] + e["width"], e["y"] + e["height"])


# True when two boxes overlap by more than eps.
def overlap(a, b, eps=EPS):
    return a[0] + eps < b[2] and b[0] + eps < a[2] and a[1] + eps < b[3] and b[1] + eps < a[3]


# True when `inner` lies within `outer`.
def inside(inner, outer):
    return (inner[0] >= outer[0] - EPS and inner[1] >= outer[1] - EPS
            and inner[2] <= outer[2] + EPS and inner[3] <= outer[3] + EPS)


def seg_hits_rect(p, q, r, shrink=4.0):
    """Liang-Barsky: does segment p->q pass through the interior of r (shrunk a little)?"""
    x0, y0, x1, y1 = r[0] + shrink, r[1] + shrink, r[2] - shrink, r[3] - shrink
    if x0 >= x1 or y0 >= y1:
        return False
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, p[0] - x0), (dx, x1 - p[0]), (-dy, p[1] - y0), (dy, y1 - p[1])):
        if pk == 0:
            if qk < 0:
                return False
            continue
        t = qk / pk
        if pk < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return False
    return t1 - t0 > 1e-6


# Checks a diagram file; returns lists of errors and warnings.
def validate(path):
    errors, warnings = [], []
    try:
        doc = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        return [f"cannot parse {path}: {exc}"], [], {}
    if doc.get("type") != "excalidraw" or not isinstance(doc.get("elements"), list):
        errors.append("top level must have type=excalidraw and an elements list")
        return errors, warnings, {}
    els = [e for e in doc["elements"] if not e.get("isDeleted")]
    by_id = {}
    for e in els:
        if e.get("id") in by_id:
            errors.append(f"duplicate id {e.get('id')}")
        by_id[e.get("id")] = e

    for e in els:
        for f in REQUIRED.get(e.get("type"), COMMON):
            if f not in e:
                errors.append(f"{e.get('id')} ({e.get('type')}): missing field {f}")

    # Ids of elements bound to `target` (text labels, arrows).
    def bound_ids(target):
        return {b.get("id") for b in (target.get("boundElements") or [])}

    for e in els:
        eid = e["id"]
        cid = e.get("containerId")
        if cid:
            c = by_id.get(cid)
            if c is None:
                errors.append(f"{eid}: containerId {cid} does not exist")
            elif eid not in bound_ids(c):
                errors.append(f"{eid}: container {cid} does not list it in boundElements")
        if e.get("type") == "arrow":
            for side in ("startBinding", "endBinding"):
                b = e.get(side)
                if not b:
                    continue
                t = by_id.get(b.get("elementId"))
                if t is None:
                    errors.append(f"{eid}: {side} -> missing {b.get('elementId')}")
                elif eid not in bound_ids(t):
                    errors.append(f"{eid}: {side} target {t['id']} does not list it in boundElements")
        for b in e.get("boundElements") or []:
            t = by_id.get(b.get("id"))
            if t is None:
                errors.append(f"{eid}: boundElements lists missing {b.get('id')}")
            elif t.get("containerId") != eid and eid not in (
                    (t.get("startBinding") or {}).get("elementId"),
                    (t.get("endBinding") or {}).get("elementId")):
                errors.append(f"{eid}: boundElements lists {t['id']} which is not bound back")
        fid = e.get("frameId")
        if fid:
            fr = by_id.get(fid)
            if fr is None or fr.get("type") != "frame":
                errors.append(f"{eid}: frameId {fid} is not an existing frame")
            elif e.get("type") != "arrow" and not inside(rect(e), rect(fr)):
                errors.append(f"{eid}: lies outside its frame {fid}")
            elif e.get("type") == "arrow":
                for px, py in e.get("points", []):
                    if not inside((e["x"] + px, e["y"] + py) * 2, rect(fr)):
                        errors.append(f"{eid}: arrow point outside its frame {fid}")
                        break
        if e.get("type") == "text" and e.get("fontSize", 0) < MIN_FONT:
            errors.append(f"{eid}: fontSize {e.get('fontSize')} < {MIN_FONT}")

    frames = [e for e in els if e.get("type") == "frame"]
    for i, a in enumerate(frames):
        for b in frames[i + 1:]:
            if overlap(rect(a), rect(b), eps=0):
                errors.append(f"frames overlap: {a.get('name')} / {b.get('name')}")
        titles = [t for t in els if t.get("frameId") == a["id"] and t.get("type") == "text"
                  and not t.get("containerId") and t.get("fontSize", 0) >= MIN_TITLE_FONT]
        if not titles:
            errors.append(f"frame {a.get('name')}: no title text >= {MIN_TITLE_FONT}px")

    boxes = [e for e in els if (e.get("customData") or {}).get("role") == "box"]
    sections = {}
    for b in boxes:
        sections.setdefault((b.get("customData") or {}).get("section"), []).append(b)
    for sec, bs in sections.items():
        for i, a in enumerate(bs):
            for b in bs[i + 1:]:
                if overlap(rect(a), rect(b)):
                    errors.append(f"[{sec}] boxes overlap: {a['id']} {rect(a)} / {b['id']} {rect(b)}")

    for e in els:
        if e.get("type") != "arrow":
            continue
        sec = (e.get("customData") or {}).get("section")
        ends = {(e.get("startBinding") or {}).get("elementId"), (e.get("endBinding") or {}).get("elementId")}
        pts = [(e["x"] + px, e["y"] + py) for px, py in e.get("points", [])]
        for b in sections.get(sec, []):
            if b["id"] in ends:
                continue
            if any(seg_hits_rect(p, q, rect(b)) for p, q in zip(pts, pts[1:])):
                warnings.append(f"[{sec}] arrow {e['id']} crosses box {b['id']}")

    stats = {"elements": len(els), "frames": len(frames), "boxes": len(boxes),
             "min_font": min((e["fontSize"] for e in els if e.get("type") == "text"), default=None)}
    return errors, warnings, stats


# CLI entry: validate the given file (default: docs/architecture.excalidraw).
def main():
    path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[1] / "architecture.excalidraw")
    errors, warnings, stats = validate(path)
    print(f"{path}: {stats}")
    for w in warnings:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)
    print(f"{len(errors)} error(s), {len(warnings)} warning(s)")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
