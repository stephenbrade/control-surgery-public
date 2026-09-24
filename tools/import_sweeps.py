#!/usr/bin/env python3
"""Import morph sweep zips exported by the Control Surgery demo tool.

Each zip is expected to contain:

    frames/00_a0.00.wav ... frames/10_a1.00.wav
    manifest.json   {axis_name, method, method_label, seed, frames,
                     alpha_values, prompts:{source,target,centre,negative}, ...}

Frames are copied to audio/morphs/<method_key>/<slug>/step_NN.wav (ordered by
the alpha in the filename, not by listing order) and an entry is written into
data/examples.json, preserving any prompts or ops you have already edited by
hand unless --overwrite-meta is passed.

AUTHORED OPS. The zip's manifest does not carry them. The agent's
actual operator program lives in the manifest of the *unzipped* sibling folder
(`<stem>_sweep/manifest.json`), pasted in by hand, so it is not valid JSON.
Two shapes are seen in the wild and both are read here:

    A   {..., "exported_at": "..."      B   {..., "exported_at": "..."},
        {"analysis": {...},                 [{"op": "gain", ...}, ...]
         "ops": [...]}
        }

Shape A is an object that lost the key introducing it; shape B is an array
appended after the manifest object. Anything else falls back to plain
json.loads. Pass --ops-dir to look somewhere other than beside the zip.

    python3 tools/import_sweeps.py ~/Downloads/*_sweep.zip
    python3 tools/import_sweeps.py --meta-only ~/Downloads/*_sweep.zip
    python3 tools/import_sweeps.py --group random ~/Downloads/foo_sweep.zip
    python3 tools/import_sweeps.py --mp3 320 ~/Downloads/*_sweep.zip
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "data", "examples.json")

FRAME_RE = re.compile(r"(\d+)_a([0-9.]+)\.wav$")
METHOD_KEYS = {
    "cs": "control_surgery",
    "control_surgery": "control_surgery",
    "ot": "optimal_transport",
    "sdedit": "sdedit_rms",
    "text": "text_morph",
    "echoedit": "echoedit",
}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def parse_manifest(txt):
    """-> (manifest_dict, ops_list). Tolerates the two hand-pasted shapes."""
    # shape B: {manifest} , [ops]
    m = re.search(r"\}\s*,\s*\[", txt)
    if m:
        return json.loads(txt[:m.start() + 1]), json.loads(txt[m.end() - 1:])
    # shape A: {manifest <missing key> {analysis..., ops:[...]} }
    fixed = re.sub(r'("exported_at"\s*:\s*"[^"]*")\s*\n\s*\{',
                   r'\1, "agent": {', txt, count=1)
    if fixed != txt:
        d = json.loads(fixed)
        agent = d.pop("agent", {}) or {}
        return d, agent.get("ops", [])
    d = json.loads(txt)
    return d, d.get("ops", [])


def frame_list(zf):
    out = []
    for n in zf.namelist():
        m = FRAME_RE.search(n)
        if m and "/frames/" in ("/" + n):
            out.append((float(m.group(2)), int(m.group(1)), n))
    out.sort()
    return out


def fmt_num(v):
    if isinstance(v, float) and v == int(v):
        v = int(v)
    return str(v)


# Only operators in the published library are surfaced on the page; anything
# else an older build may emit is dropped.
PUBLISHED_OPS = {"gain", "brightness", "density", "pitch",
                 "stretch_attack", "stretch_tail", "stretch_all"}

BOOST_OPS = {"gain", "brightness", "density"}

# A destination band alone does not say which way the signal moved: that
# depends on the source's own starting band, which the sweep manifests do not
# record. Where a value op is known to move a signal DOWN, name it here as
# (example slug, op) so the chip reads "reduce to" instead of "boost to".
DIRECTION_OVERRIDES = {
    ("surface-hardness", "density"): "reduce",
}

# Prompt text is reproduced verbatim from each sweep manifest; these are
# corrections to typos in the prompts as they were entered.
PROMPT_FIXES = {"foosteps": "footsteps"}


def fix_prompt(t):
    for bad, good in PROMPT_FIXES.items():
        t = t.replace(bad, good)
    return t


def op_chip(o, slug=None):
    """One authored operator call -> a plain-language chip for the page.

    Value ops name a destination band on the corpus percentile ladder, so they
    read as "boost to p85" rather than a bare "p85", which tells a reader
    nothing about direction.
    """
    name = o.get("op", "?")
    if name not in PUBLISHED_OPS:
        return None
    p = o.get("params", {}) or {}

    if "to" in p:
        band = str(p["to"])
        if name in BOOST_OPS:
            verb = DIRECTION_OVERRIDES.get((slug, name), "boost")
            return "%s: %s to %s" % (name, verb, band)
        return "%s: to %s" % (name, band)

    if "semitones" in p:
        s = p["semitones"]
        sign = "+" if (isinstance(s, (int, float)) and s > 0) else ""
        return "pitch: %s%s semitones" % (sign, fmt_num(s))

    if "factor" in p:
        f = p["factor"]
        # The paper names a single time operator, `envelope`; these sweeps come
        # from a slightly older build that split it into attack/tail calls.
        # Functionally identical, so present them under the published name.
        part = {"stretch_attack": "envelope: attack",
                "stretch_tail": "envelope: tail",
                "stretch_all": "envelope"}.get(name, name)
        try:
            longer = float(f) > 1
        except (TypeError, ValueError):
            longer = None
        word = "" if longer is None else (" (longer)" if longer else " (shorter)")
        chip = "%s \u00d7%s%s" % (part, fmt_num(f), word)
        if p.get("anchor"):
            chip += ", about the %s" % p["anchor"]
        return chip

    return "%s: %s" % (name, ", ".join("%s=%s" % (k, fmt_num(v))
                                       for k, v in p.items()))


def chips(man, ops, slug=None):
    """Chips describe what the AGENT authored, nothing else. Run settings are
    constraints on the run rather than authored calls, so they are not shown."""
    c = [op_chip(o, slug) for o in ops]
    c = [x for x in c if x]
    if man.get("seed") is not None:
        c.append("seed %s" % man["seed"])
    return c


def find_ops(zpath, ops_dir):
    """Look for the hand-edited manifest beside the zip (or in --ops-dir)."""
    stem = os.path.basename(zpath)[:-4]
    roots = [ops_dir] if ops_dir else [os.path.dirname(zpath)]
    for root in roots:
        for cand in (os.path.join(root, stem, "manifest.json"),
                     os.path.join(root, stem + ".manifest.json")):
            if os.path.isfile(cand):
                try:
                    _man, ops = parse_manifest(open(cand).read())
                    return ops, cand
                except Exception as e:
                    print("   ! could not parse %s (%s)" % (cand, e))
    return [], None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zips", nargs="+")
    ap.add_argument("--group", default="cherrypicked")
    ap.add_argument("--overwrite-meta", action="store_true",
                    help="replace prompts/ops even if already edited by hand")
    ap.add_argument("--meta-only", action="store_true",
                    help="refresh manifest metadata only; do not recopy audio")
    ap.add_argument("--ops-dir", default=None,
                    help="where to look for the unzipped folder holding the ops")
    ap.add_argument("--mp3", type=int, metavar="KBPS", default=0,
                    help="transcode frames to mp3 at this bitrate (needs ffmpeg)")
    args = ap.parse_args()

    with open(MANIFEST) as f:
        site = json.load(f)
    by_id = {e["id"]: e for e in site["examples"]}
    order = [e["id"] for e in site["examples"]]

    ext = "mp3" if args.mp3 else "wav"
    no_ops = []

    for zpath in args.zips:
        zpath = os.path.expanduser(zpath)
        if not zipfile.is_zipfile(zpath):
            print("skip (not a zip)", zpath)
            continue
        with zipfile.ZipFile(zpath) as zf:
            try:
                man, ops = parse_manifest(zf.read("manifest.json").decode("utf-8"))
            except KeyError:
                print("skip (no manifest.json)", zpath)
                continue

            if not ops:
                ops, src = find_ops(zpath, args.ops_dir)

            slug = slugify(man.get("axis_name") or
                           os.path.basename(zpath).replace("_sweep.zip", ""))
            mkey = METHOD_KEYS.get(man.get("method", "cs"), man.get("method", "cs"))
            reldir = "audio/morphs/%s/%s" % (mkey, slug)
            outdir = os.path.join(HERE, reldir)
            frames = frame_list(zf)

            if not args.meta_only:
                if not frames:
                    print("skip (no frames/)", zpath)
                    continue
                os.makedirs(outdir, exist_ok=True)
                tmp = tempfile.mkdtemp()
                try:
                    for i, (_a, _n, name) in enumerate(frames):
                        dst = os.path.join(outdir, "step_%02d.%s" % (i, ext))
                        if args.mp3:
                            src = os.path.join(tmp, "f.wav")
                            with open(src, "wb") as fh:
                                fh.write(zf.read(name))
                            subprocess.run(
                                ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
                                 "-b:a", "%dk" % args.mp3, dst], check=True)
                        else:
                            with zf.open(name) as s, open(dst, "wb") as d:
                                shutil.copyfileobj(s, d)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)

            p = man.get("prompts") or {}
            entry = by_id.get(slug)
            fresh = entry is None
            if fresh:
                entry = {"id": slug, "group": args.group}
                by_id[slug] = entry
                order.append(slug)
            if fresh or args.overwrite_meta:
                entry["group"] = args.group
                entry["tier"] = man.get("axis_name", "")
                entry["source_prompt"] = fix_prompt(p.get("source") or p.get("negative") or "")
                entry["target_prompt"] = fix_prompt(p.get("target") or "")
                entry["ops"] = chips(man, ops, slug)
            entry.setdefault("methods", {})
            m = entry["methods"].get(mkey, {})
            m["dir"] = reldir
            nframes = len(frames) or site.get("steps", 11)
            if nframes != site.get("steps", 11):
                m["steps"] = nframes
            if ext != "wav":
                m["pattern"] = "step_{i}." + ext
            elif "pattern" in m:
                del m["pattern"]
            if man.get("method_label"):
                m["label"] = man["method_label"]
            entry["methods"][mkey] = m

            if not ops:
                no_ops.append(slug)
            print("%-26s %2d frames  %d ops" % (slug, nframes, len(ops)))

    site["examples"] = [by_id[i] for i in order]
    with open(MANIFEST, "w") as f:
        json.dump(site, f, indent=2)
        f.write("\n")
    print("manifest now has %d examples" % len(site["examples"]))
    if no_ops:
        print("no authored ops found for: " + ", ".join(no_ops))
        print("  (re-export those sweeps, or paste the ops into "
              "<name>_sweep/manifest.json beside the zip)")


if __name__ == "__main__":
    main()
