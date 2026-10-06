#!/usr/bin/env python3
"""Download the CC0 assets the game uses from Poly Haven (https://polyhaven.com).

Usage: python3 tools/fetch_assets.py [--dry-run]
Everything lands in assets/. All Poly Haven assets are CC0 (public domain).
"""
import json
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')

# Surface textures: id -> maps to fetch (1k jpg)
TEXTURES = [
    'beige_wall_001', 'beige_wall_002', 'painted_plaster_wall', 'plastered_wall_04', 'painted_concrete_02',
    'long_white_tiles', 'dirty_carpet', 'laminate_floor_02', 'herringbone_parquet', 'floor_tiles_06',
    'concrete_floor_worn_001',
]
TEX_MAPS = {'Diffuse': 'diff', 'nor_gl': 'nor', 'Rough': 'rough'}

MODELS = [
    'Sofa_01', 'sofa_02', 'sofa_03', 'ArmChair_01', 'modern_arm_chair_01',
    'CoffeeTable_01', 'coffee_table_round_01',
    'Television_01', 'television_02', 'ClassicConsole_01', 'wooden_bookshelf_worn',
    'WoodenTable_01', 'dining_chair_02',
    'ClassicNightstand_01', 'painted_wooden_nightstand', 'modern_wooden_cabinet', 'vintage_cabinet_01',
    'drawer_cabinet',
    'electric_stove', 'vintage_microwave',
    'cardboard_box_01', 'potted_plant_04',
    'hanging_picture_frame_01', 'hanging_picture_frame_02', 'hanging_picture_frame_03',
    'wall_clock', 'alarm_clock_01', 'medical_box',
    'mounted_fluorescent_lights', 'modern_ceiling_lamp_01', 'korean_fire_extinguisher_01',
    'plunger', 'bleach_bottle', 'throw_pillows_01',
]

HDRIS = ['shanghai_bund', 'urban_street_04']


HEADERS = {'User-Agent': 'hush-horror-game-asset-fetch/1.0'}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60)


def api(path):
    with get('https://api.polyhaven.com/' + path) as r:
        return json.load(r)


def plan():
    jobs = []
    for t in TEXTURES:
        f = api('files/' + t)
        for key, short in TEX_MAPS.items():
            info = f[key]['1k']['jpg']
            jobs.append((info['url'], os.path.join(ROOT, 'textures', t, short + '.jpg'), info['size']))
    for m in MODELS:
        if os.path.exists(os.path.join(ROOT, 'models', m, m + '.glb')):
            continue  # already downloaded and optimised
        f = api('files/' + m)
        if 'gltf' not in f or '1k' not in f['gltf']:
            print('  (no glTF for', m + ', skipping)')
            continue
        g = f['gltf']['1k']['gltf']
        jobs.append((g['url'], os.path.join(ROOT, 'models', m, m + '.gltf'), g['size']))
        for rel, info in g['include'].items():
            jobs.append((info['url'], os.path.join(ROOT, 'models', m, rel), info['size']))
    for h in HDRIS:
        f = api('files/' + h)
        info = f['tonemapped']
        jobs.append((info['url'], os.path.join(ROOT, 'hdri', h + '.jpg'), info['size']))
    return jobs


def main():
    jobs = plan()
    total = sum(j[2] for j in jobs)
    print(f'{len(jobs)} files, {total / 1e6:.1f} MB')
    if '--dry-run' in sys.argv:
        return
    for url, dest, size in jobs:
        if os.path.exists(dest) and os.path.getsize(dest) == size:
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        print('  ', os.path.relpath(dest, ROOT))
        with get(url) as r, open(dest, 'wb') as out:
            out.write(r.read())
    # Re-encode every jpg a little harder; they're 1k already.
    if sys.platform == 'darwin':
        for d, _, files in os.walk(ROOT):
            for n in files:
                if n.endswith('.jpg') and 'hdri' not in d:
                    subprocess.run(['sips', '-s', 'formatOptions', '72', os.path.join(d, n)], check=True, capture_output=True)
    # The tonemapped HDRI jpgs are 8k; 4k is plenty for a background.
    for h in HDRIS:
        p = os.path.join(ROOT, 'hdri', h + '.jpg')
        if sys.platform == 'darwin':
            subprocess.run(['sips', '-Z', '4096', '-s', 'formatOptions', '82', p], check=True, capture_output=True)


if __name__ == '__main__':
    main()
