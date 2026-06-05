#!/usr/bin/env python3
"""
Cross-platform builder for the Wyzie Kodi repository (no `zip`/`md5sum` needed).
Mirrors build.sh using Python's zipfile + hashlib. Output goes to ./dist, which
the wyzie-kodi Worker (wrangler.toml) serves at kodi.wyzie.io.

Run:  python build.py    (then: wrangler deploy)
"""
import hashlib
import os
import shutil
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON_SRC = os.path.join(HERE, "..", "kodi")            # service.subtitles.wyzie
REPO_SRC = os.path.join(HERE, "repository.wyzie")        # repository.wyzie
DIST = os.path.join(HERE, "dist")
ZIPS = os.path.join(DIST, "zips")

SKIP_DIRS = {"__pycache__", ".git", ".wrangler", "dist"}
SKIP_EXT = {".pyc"}


def addon_version(addon_xml: str) -> str:
    """Version attribute of the <addon> root element (not the XML declaration)."""
    return ET.parse(addon_xml).getroot().attrib["version"]


def package(src_dir: str, addon_id: str, version: str) -> str:
    """Zip src_dir under a top-level <addon_id>/ folder (Kodi's required layout)."""
    out_dir = os.path.join(ZIPS, addon_id)
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"{addon_id}-{version}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fn in files:
                if os.path.splitext(fn)[1] in SKIP_EXT:
                    continue
                abs_path = os.path.join(root, fn)
                rel = os.path.relpath(abs_path, src_dir)
                zf.write(abs_path, arcname=f"{addon_id}/{rel}".replace(os.sep, "/"))
    print(f"  packaged {os.path.relpath(zip_path, HERE)}")
    return zip_path


def addon_block(addon_xml: str) -> str:
    """The <addon>...</addon> text without its XML declaration."""
    with open(addon_xml, "r", encoding="utf-8") as fh:
        return "".join(l for l in fh if not l.lstrip().startswith("<?xml"))


def main():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(ZIPS)

    addon_ver = addon_version(os.path.join(ADDON_SRC, "addon.xml"))
    repo_ver = addon_version(os.path.join(REPO_SRC, "addon.xml"))
    print(f"service.subtitles.wyzie v{addon_ver} | repository.wyzie v{repo_ver}")

    package(ADDON_SRC, "service.subtitles.wyzie", addon_ver)
    repo_zip = package(REPO_SRC, "repository.wyzie", repo_ver)

    addons_xml = os.path.join(DIST, "addons.xml")
    with open(addons_xml, "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<addons>\n')
        fh.write(addon_block(os.path.join(ADDON_SRC, "addon.xml")))
        fh.write(addon_block(os.path.join(REPO_SRC, "addon.xml")))
        fh.write("</addons>\n")

    with open(addons_xml, "rb") as fh:
        md5 = hashlib.md5(fh.read()).hexdigest()
    with open(addons_xml + ".md5", "w", encoding="utf-8") as fh:
        fh.write(md5)

    # Stable, version-independent installer link for the website/docs.
    shutil.copyfile(repo_zip, os.path.join(DIST, "repository.wyzie.zip"))

    print(f"Done -> {os.path.relpath(DIST, HERE)} (addons.xml md5 {md5})")
    print("Files:")
    for root, _, files in os.walk(DIST):
        for f in files:
            p = os.path.relpath(os.path.join(root, f), DIST)
            print("  ", p)


if __name__ == "__main__":
    main()
