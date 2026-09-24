#!/usr/bin/env python3
"""Rebuild data/examples.json from whatever is on disk under audio/morphs/.

Expected layout:

    audio/morphs/<method>/<example_id>/step_00.wav ... step_10.wav

Existing metadata (prompts, ops, group, tier) is preserved by example id; new
example ids are added with REPLACE_PROMPT placeholders for you to fill in.
Directories that disappeared are dropped.

    python3 tools/build_manifest.py
    python3 tools/build_manifest.py --group random --match 'random_*'
"""

import argparse
import fnmatch
import json
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "data", "examples.json")
ROOT = os.path.join(HERE, "audio", "morphs")

STEP_RE = re.compile(r"^step_(\d+)\.wav$")


def scan():
    """-> {example_id: {method_key: (reldir, n_steps)}}"""
    found = {}
    if not os.path.isdir(ROOT):
        return found
    for method in sorted(os.listdir(ROOT)):
        mdir = os.path.join(ROOT, method)
        if not os.path.isdir(mdir):
            continue
        for ex in sorted(os.listdir(mdir)):
            edir = os.path.join(mdir, ex)
            if not os.path.isdir(edir):
                continue
            steps = [f for f in os.listdir(edir) if STEP_RE.match(f)]
            if not steps:
                continue
            rel = os.path.relpath(edir, HERE).replace(os.sep, "/")
            found.setdefault(ex, {})[method] = (rel, len(steps))
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="random",
                    help="group assigned to newly discovered examples")
    ap.add_argument("--match", default="*",
                    help="only touch example ids matching this glob")
    args = ap.parse_args()

    with open(MANIFEST) as f:
        man = json.load(f)

    old = {ex["id"]: ex for ex in man["examples"]}
    order = [ex["id"] for ex in man["examples"]]
    found = scan()

    for ex_id, methods in sorted(found.items()):
        if not fnmatch.fnmatch(ex_id, args.match):
            continue
        entry = old.get(ex_id)
        if entry is None:
            entry = {
                "id": ex_id,
                "group": args.group,
                "tier": "one-shot",
                "source_prompt": "REPLACE_PROMPT source",
                "target_prompt": "REPLACE_PROMPT target",
                "ops": [],
                "methods": {},
            }
            old[ex_id] = entry
            order.append(ex_id)
        for mk, (rel, n) in methods.items():
            m = entry["methods"].get(mk, {})
            m["dir"] = rel
            if n != man.get("steps", 11):
                m["steps"] = n
            entry["methods"][mk] = m

    man["examples"] = [old[i] for i in order if old[i]["methods"]]

    with open(MANIFEST, "w") as f:
        json.dump(man, f, indent=2)
        f.write("\n")

    todo = [e["id"] for e in man["examples"]
            if "REPLACE_PROMPT" in json.dumps(e)]
    print("%d examples in manifest" % len(man["examples"]))
    if todo:
        print("prompts still to fill: " + ", ".join(todo))


if __name__ == "__main__":
    main()
