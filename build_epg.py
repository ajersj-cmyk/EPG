#!/usr/bin/env python3
"""Download a live US XMLTV source and add Strong/Trex display-name aliases."""

from __future__ import annotations

import gzip
import html
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_GZ = ROOT / "cache" / "epgtalk_us.xml.gz"
OUT_GZ = ROOT / "strong_us_sports_epg.xml.gz"
OUT_MAP = ROOT / "channel_aliases.txt"

SOURCE_URL = "https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz"

MANUAL_ALIASES: dict[str, list[str]] = {
    "espn": ["US: ESPN HD", "US: ESPN", "USA ESPN HD", "ESPN USA", "ESPN HD", "ESPN"],
    "espnhd": ["US: ESPN HD", "US: ESPN", "USA ESPN HD", "ESPN USA", "ESPN HD", "ESPN"],
    "espn2": ["US: ESPN2 HD", "US: ESPN 2 HD", "US: ESPN2", "USA ESPN2 HD", "ESPN2 HD", "ESPN2"],
    "espn2hd": ["US: ESPN2 HD", "US: ESPN 2 HD", "US: ESPN2", "USA ESPN2 HD", "ESPN2 HD", "ESPN2"],
    "espnews": ["US: ESPNEWS HD", "US: ESPN NEWS HD", "US: ESPNEWS", "ESPNEWS HD", "ESPNEWS"],
    "espnu": ["US: ESPNU HD", "US: ESPN U HD", "US: ESPNU", "ESPNU HD", "ESPNU"],
    "espndeportes": ["US: ESPN DEPORTES HD", "US: ESPN Deportes", "ESPN Deportes HD"],
    "foxsports1us": ["US: FS1 HD", "US: FOX SPORTS 1 HD", "US: FS1", "FS1 HD", "Fox Sports 1"],
    "foxsports2us": ["US: FS2 HD", "US: FOX SPORTS 2 HD", "US: FS2", "FS2 HD", "Fox Sports 2"],
    "nflnetwork": ["US: NFL NETWORK HD", "US: NFL Network", "NFL Network HD", "NFL NETWORK"],
    "nflredzone": ["US: NFL REDZONE HD", "US: NFL RedZone", "NFL RedZone HD", "NFL REDZONE"],
    "nbatv": ["US: NBA TV HD", "US: NBA TV", "NBA TV HD", "NBATV"],
    "nhlnetwork": ["US: NHL NETWORK HD", "US: NHL Network", "NHL Network HD", "NHL NETWORK"],
    "mlbnetwork": ["US: MLB NETWORK HD", "US: MLB Network", "MLB Network HD", "MLB NETWORK"],
    "tnt": ["US: TNT HD", "US: TNT", "TNT HD", "TNT USA"],
    "tbs": ["US: TBS HD", "US: TBS", "TBS HD"],
    "usanetwork": ["US: USA NETWORK HD", "US: USA Network", "USA Network HD", "USA HD"],
    "cbssportsnetwork": ["US: CBS SPORTS HD", "US: CBSSN HD", "CBS Sports Network HD", "CBSSN"],
    "golfchannel": ["US: GOLF CHANNEL HD", "US: Golf HD", "Golf Channel HD"],
    "tennischannel": ["US: TENNIS CHANNEL HD", "US: Tennis HD", "Tennis Channel HD"],
    "secnetwork": ["US: SEC NETWORK HD", "US: SEC HD", "SEC Network HD", "SECN"],
    "accnetwork": ["US: ACC NETWORK HD", "US: ACCN HD", "ACC Network HD", "ACCN"],
    "bigtennetwork": ["US: BIG TEN HD", "US: BTN HD", "Big Ten Network HD", "BTN"],
    "beinsports": ["US: BEIN SPORTS HD", "US: beIN Sports", "beIN Sports USA HD"],
    "willowcrickethd": ["US: WILLOW HD", "Willow Cricket HD", "Willow HD"],
    "cnnhd": ["US: CNN HD", "US: CNN", "CNN HD", "CNN USA"],
    "foxnewschannel": ["US: FOX NEWS HD", "US: Fox News", "Fox News Channel HD", "FOX NEWS"],
    "foxbusiness": ["US: FOX BUSINESS HD", "Fox Business HD"],
    "cnbc": ["US: CNBC HD", "CNBC HD", "CNBC"],
    "msnbc": ["US: MSNBC HD", "MSNBC HD"],
    "newsmax": ["US: NEWSMAX HD", "Newsmax HD"],
    "tudn": ["US: TUDN HD", "TUDN HD"],
}


def norm(s: str) -> str:
    s = html.unescape(s).lower()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = s.replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "", s)


def strong_variants(name: str) -> list[str]:
    name = html.unescape(name).strip()
    name = re.sub(r"\s+", " ", name)
    core = re.sub(r"^(US|CA|UK)\s*[-:]\s*", "", name, flags=re.I)
    core = re.sub(r"\s+\((Pacific|East|West|Alternate).*?\)\s*$", "", core, flags=re.I)
    variants = [
        name,
        core,
        f"US: {core}",
        f"US: {core} HD" if not re.search(r"\bHD\b", core, re.I) else f"US: {core}",
        f"USA {core}",
        f"{core} HD" if not re.search(r"\bHD\b", core, re.I) else core,
        core.replace(" HD", "").replace(" FHD", "").replace(" 4K", ""),
        f"USA | {core}",
        f"US|{core}",
        f"US| {core}",
        f"US| {core} HD" if not re.search(r"\bHD\b", core, re.I) else f"US| {core}",
        f"USA| {core}",
    ]
    out, seen = [], set()
    for v in variants:
        v = re.sub(r"\s+", " ", v).strip(" :|-")
        if not v:
            continue
        key = v.lower()
        if key not in seen:
            seen.add(key)
            out.append(v)
    return out


def download_source() -> None:
    SRC_GZ.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {SOURCE_URL}", flush=True)
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "strong-epg-builder/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = resp.read()
    SRC_GZ.write_bytes(data)
    print(f"Saved {SRC_GZ} ({len(data)} bytes)", flush=True)


def parse_channels_and_programmes(path: Path):
    print(f"Reading {path} ...", flush=True)
    text = gzip.open(path, "rt", encoding="utf-8", errors="replace").read()
    channels = []
    for m in re.finditer(r'<channel id="([^"]+)">(.*?)</channel>', text, re.S):
        cid = m.group(1)
        inner = m.group(2)
        names = [html.unescape(n) for n in re.findall(r"<display-name[^>]*>([^<]*)", inner)]
        icons = re.findall(r'<icon src="([^"]+)"', inner)
        channels.append({"id": cid, "names": names, "icons": icons})
    progs_by_ch = defaultdict(list)
    prog_re = re.compile(r'(<programme\s[^>]*channel="([^"]+)"[\s\S]*?</programme>)')
    for m in prog_re.finditer(text):
        progs_by_ch[m.group(2)].append(m.group(1))
    print(f"  {len(channels)} channels, {sum(len(v) for v in progs_by_ch.values())} programmes", flush=True)
    return channels, progs_by_ch


def main() -> int:
    download_source()
    channels, progs = parse_channels_and_programmes(SRC_GZ)

    extra_ids_for = defaultdict(list)
    alias_channels = []
    used_ids = {c["id"] for c in channels}
    map_lines = []

    for ch in channels:
        primary = ch["names"][0] if ch["names"] else ch["id"]
        auto = strong_variants(primary)
        manual: list[str] = []
        nkey = norm(primary)
        for k in (nkey, nkey.replace("hd", ""), nkey.replace("us", "")):
            if k in MANUAL_ALIASES:
                manual.extend(MANUAL_ALIASES[k])
                break
        for mk, aliases in MANUAL_ALIASES.items():
            if mk and mk in nkey and len(mk) >= 6:
                manual.extend(aliases)

        aliases = []
        seen = {norm(x) for x in ch["names"]}
        for a in auto + manual:
            k = norm(a)
            if k and k not in seen:
                seen.add(k)
                aliases.append(a)

        extra_xml = [f"  <display-name>{html.escape(a)}</display-name>" for a in aliases]
        ch["extra_names_xml"] = "\n".join(extra_xml)

        sportsish = any(
            w in nkey
            for w in (
                "espn", "nfl", "nba", "nhl", "mlb", "foxsports", "foxsoccer",
                "secnetwork", "accnetwork", "bigten", "golfchannel", "tennis",
                "bein", "willow", "yesnetwork", "nesn", "cbssport", "redzone",
                "tudn", "nbatv", "nhlnetwork", "mlbnetwork", "fs1", "fs2",
                "cnn", "foxnews", "foxbusiness", "cnbc", "newsmax", "newsnation",
                "tnt", "tbseast", "usanetwork",
            )
        )
        if sportsish:
            preferred = [a for a in aliases if a.upper().startswith("US:")]
            clone_targets = (preferred[:1] or aliases[:1])[:1]
            for a in clone_targets:
                if a not in used_ids:
                    used_ids.add(a)
                    extra_ids_for[ch["id"]].append(a)
                    alias_channels.append({"id": a, "names": [a, primary], "icons": ch["icons"]})

        if aliases:
            map_lines.append(f"{primary}\t{ch['id']}\t{' | '.join(aliases[:8])}")

    print(f"Writing {OUT_GZ} with {len(alias_channels)} alias channels ...", flush=True)
    tmp_xml = ROOT / "cache" / "out.xml"
    tmp_xml.parent.mkdir(parents=True, exist_ok=True)
    with tmp_xml.open("w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(f'<tv generator-info-name="strong-us-sports-epg" generator-info-url="github-actions">\n')
        for ch in channels:
            f.write(f'<channel id="{html.escape(ch["id"], quote=True)}">\n')
            for n in ch["names"]:
                f.write(f"  <display-name>{html.escape(n)}</display-name>\n")
            if ch.get("extra_names_xml"):
                f.write(ch["extra_names_xml"] + "\n")
            for ic in ch["icons"]:
                f.write(f'  <icon src="{html.escape(ic, quote=True)}" />\n')
            f.write("</channel>\n")
        for ch in alias_channels:
            f.write(f'<channel id="{html.escape(ch["id"], quote=True)}">\n')
            for n in ch["names"]:
                f.write(f"  <display-name>{html.escape(n)}</display-name>\n")
            for ic in ch["icons"]:
                f.write(f'  <icon src="{html.escape(ic, quote=True)}" />\n')
            f.write("</channel>\n")
        written = 0
        for ch in channels:
            for blob in progs.get(ch["id"], []):
                f.write(blob)
                f.write("\n")
                written += 1
                for alias in extra_ids_for.get(ch["id"], []):
                    cloned = re.sub(
                        r'channel="[^"]+"',
                        f'channel="{html.escape(alias, quote=True)}"',
                        blob,
                        count=1,
                    )
                    f.write(cloned)
                    f.write("\n")
                    written += 1
        f.write("</tv>\n")

    with tmp_xml.open("rb") as fin, gzip.open(OUT_GZ, "wb", compresslevel=6) as fout:
        while True:
            chunk = fin.read(1024 * 1024)
            if not chunk:
                break
            fout.write(chunk)
    OUT_MAP.write_text("\n".join(sorted(map_lines, key=str.lower)) + "\n", encoding="utf-8")
    print(f"Wrote {written} programme blocks")
    print("GZ", OUT_GZ.stat().st_size)
    print("built_at", datetime.now(timezone.utc).isoformat())
    return 0


if __name__ == "__main__":
    sys.exit(main())
