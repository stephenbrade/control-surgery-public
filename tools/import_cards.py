#!/usr/bin/env python3
"""Import "all methods" card zips exported by the comparison tool.

Each zip contains one directory per method, eleven mp3s named alpha_0.00.mp3
.. alpha_1.00.mp3, and a manifest.csv:

    file,tier,method,card_id,alpha,src_prompt,tgt_prompt,source_s3

Every method in the zip becomes an entry under the same example, so the page
renders them as a side-by-side comparison grid. Control Surgery is placed
first. Prompts come from the CSV; these cards carry no authored ops.

    python3 tools/import_cards.py ~/Downloads/*-all-methods-mp3.zip
    python3 tools/import_cards.py --group baselines ~/Downloads/foo.zip
"""

import argparse, csv, io, json, os, re, zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "data", "examples.json")

# directory name in the zip -> key used on the site
METHOD_KEYS = {"control_surgery_reduced": "control_surgery"}

# method directories in the export that the paper does not report
SKIP_METHODS = {"lin_curve", "audio_morph_bare"}

# export label -> the name used in the paper
LABELS = {"audio_morph": "SDEdit + RMS", "ot_curve": "Optimal transport"}
FIRST = "control_surgery"


def slug_from_card(card_id, fallback):
    # card ids look like "<32-hex>-<axis-name>"
    m = re.match(r"^[0-9a-f]{16,}-(.+)$", card_id or "")
    return m.group(1) if m else (card_id or fallback)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zips", nargs="+")
    ap.add_argument("--group", default="random")
    ap.add_argument("--overwrite-meta", action="store_true")
    args = ap.parse_args()

    site = json.load(open(MANIFEST))
    by_id = {e["id"]: e for e in site["examples"]}
    order = [e["id"] for e in site["examples"]]
    labels = site.setdefault("methods", {})

    for zpath in args.zips:
        zpath = os.path.expanduser(zpath)
        if not zipfile.is_zipfile(zpath):
            print("skip (not a zip)", zpath); continue
        with zipfile.ZipFile(zpath) as zf:
            names = zf.namelist()
            csv_name = next((n for n in names if n.endswith("manifest.csv")), None)
            if not csv_name:
                print("skip (no manifest.csv)", zpath); continue
            prefix = csv_name[:-len("manifest.csv")]
            rows = list(csv.DictReader(
                io.StringIO(zf.read(csv_name).decode("utf-8-sig"))))
            if not rows:
                print("skip (empty manifest)", zpath); continue

            card = rows[0]["card_id"]
            slug = slug_from_card(card, os.path.basename(zpath))
            tier = (rows[0].get("tier") or "").strip()
            src = (rows[0].get("src_prompt") or "").strip()
            tgt = (rows[0].get("tgt_prompt") or "").strip()

            # group rows by method directory, ordered by alpha
            per = {}
            for r in rows:
                d = r["file"].split("/")[0]
                per.setdefault(d, []).append((float(r["alpha"]), r["file"],
                                              (r.get("method") or d).strip()))
            for v in per.values():
                v.sort()

            entry = by_id.get(slug)
            fresh = entry is None
            if fresh:
                entry = {"id": slug, "group": args.group, "methods": {}}
                by_id[slug] = entry; order.append(slug)
            if fresh or args.overwrite_meta:
                entry["group"] = args.group
                entry["source_prompt"] = src
                entry["tgt_placeholder"] = None
                entry["target_prompt"] = tgt
                entry.pop("tgt_placeholder", None)
                entry.setdefault("ops", [])

            dirs = [d for d in per if d not in SKIP_METHODS]
            dirs.sort(key=lambda d: (METHOD_KEYS.get(d, d) != FIRST, d))
            for d in dirs:
                key = METHOD_KEYS.get(d, d)
                reldir = "audio/morphs/%s/%s" % (key, slug)
                outdir = os.path.join(HERE, reldir)
                os.makedirs(outdir, exist_ok=True)
                for i, (_a, fname, label) in enumerate(per[d]):
                    with zf.open(prefix + fname) as s, \
                         open(os.path.join(outdir, "step_%02d.mp3" % i), "wb") as o:
                        o.write(s.read())
                label = LABELS.get(key, per[d][0][2])
                labels.setdefault(key, label)
                m = entry["methods"].get(key, {})
                m["dir"] = reldir
                m["pattern"] = "step_{i}.mp3"
                m["label"] = label
                if len(per[d]) != site.get("steps", 11):
                    m["steps"] = len(per[d])
                entry["methods"][key] = m

            # keep Control Surgery first in the grid
            if FIRST in entry["methods"]:
                entry["methods"] = dict(
                    [(FIRST, entry["methods"][FIRST])] +
                    [(k, v) for k, v in entry["methods"].items() if k != FIRST])

            print("%-26s %s  %d methods x %d steps" %
                  (slug, tier or "-", len(per), len(per[dirs[0]])))

    site["examples"] = [by_id[i] for i in order]
    with open(MANIFEST, "w") as f:
        json.dump(site, f, indent=2); f.write("\n")
    print("manifest now has %d examples" % len(site["examples"]))


if __name__ == "__main__":
    main()
