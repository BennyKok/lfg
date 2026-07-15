#!/usr/bin/env python3
"""Query a JSON stats endpoint and print one complete, self-contained document."""

import argparse
import html
import json
import os
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument("--endpoint", required=True)
args = parser.parse_args()

headers = {"Accept": "application/json"}
if token := os.environ.get("GROWTH_API_TOKEN"):
    headers["Authorization"] = f"Bearer {token}"
request = urllib.request.Request(args.endpoint, headers=headers)
with urllib.request.urlopen(request, timeout=15) as response:
    stats = json.load(response)

users = int(stats["users"])
apps = int(stats["apps"])
updated = html.escape(str(stats.get("updatedAt", "just now")))
print(f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {{ margin: 0; padding: 24px; color: #eef; background: #121622; font: 16px system-ui }}
    main {{ display: flex; gap: 16px }}
    section {{ flex: 1; padding: 18px; border-radius: 14px; background: #20283a }}
    strong {{ display: block; font-size: 2rem }}
  </style>
</head>
<body>
  <main>
    <section>Users<strong>{users:,}</strong></section>
    <section>Apps<strong>{apps:,}</strong></section>
  </main>
  <p>Updated {updated}</p>
</body>
</html>""")
