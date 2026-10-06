#!/bin/sh
# Simplify the denser Poly Haven models (furniture to ~4k triangles, small
# props to ~1.2k) and pack every model into a single .glb, so the whole
# apartment floor renders quickly. Run after tools/fetch_assets.py.
# Needs Node: uses npx @gltf-transform/cli.
set -e
cd "$(dirname "$0")/../assets/models"
for dir in */; do
  name=${dir%/}
  src="$name/$name.gltf"
  [ -f "$src" ] || continue
  tris=$(python3 -c "
import json; g=json.load(open('$src'))
print(sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives'] if 'indices' in p))")
  case "$name" in
    plunger|bleach_bottle|alarm_clock_01|potted_plant_04|modern_ceiling_lamp_01|cardboard_box_01|trashbag|\
    throw_pillows_01|vintage_microwave|korean_fire_extinguisher_01|television_02|Television_01|WetFloorSign_01|\
    mounted_fluorescent_lights) target=1200 ;;
    *) target=4000 ;;
  esac
  ratio=$(python3 -c "print(min(1.0, $target / max($tris, 1)))")
  # the wall clock's hands must stay separate and exact
  case "$name" in wall_clock|medical_box) ratio=1 ;; esac
  if [ "$ratio" = "1.0" ] || [ "$ratio" = "1" ]; then
    npx --yes @gltf-transform/cli@4 copy "$src" "$name/$name.glb" > /dev/null
  else
    npx --yes @gltf-transform/cli@4 simplify "$src" "$name/$name.glb" --ratio "$ratio" --error 0.004 > /dev/null
  fi
  echo "$name: $tris tris, ratio $ratio"
  rm -rf "$name/$name.gltf" "$name"/*.bin "$name/textures"
done
