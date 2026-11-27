"""Convert NHC CurrentStorms.json into the small data/storms.json the site reads.

Usage: python3 scripts/normalize_storms.py <raw CurrentStorms.json> <output path>
Only fields that change with real advisories are written, so the file (and the
repo) only changes when NHC issues something new.
"""
import json
import sys


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def main(src, dst):
    with open(src, encoding="utf-8") as f:
        raw = json.load(f)
    storms = []
    for s in raw.get("activeStorms") or []:
        lat, lon = s.get("latitudeNumeric"), s.get("longitudeNumeric")
        if lat is None or lon is None:
            continue
        storms.append({
            "id": s.get("id"),
            "name": s.get("name"),
            "classification": s.get("classification"),
            "intensityKt": num(s.get("intensity")),
            "pressureMb": num(s.get("pressure")),
            "lat": float(lat),
            "lon": float(lon),
            "movementDir": num(s.get("movementDir")),
            "movementSpeedKt": num(s.get("movementSpeed")),
            "advisoryUrl": (s.get("publicAdvisory") or {}).get("url") or "https://www.nhc.noaa.gov/",
            "lastUpdate": s.get("lastUpdate"),
        })
    storms.sort(key=lambda x: x["id"] or "")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"source": "https://www.nhc.noaa.gov/CurrentStorms.json", "storms": storms}, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
