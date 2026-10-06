# HUSH

A first-person 3D horror game that runs in the browser. You wake up on the fourth floor of
an abandoned apartment building, emptied in a hurry, with dust sheets still over the furniture. The stairs only ever lead back to the same floor. Somewhere,
one clock is still ticking. Find it and pick it up to get home. Something tall and wrong lives
on this floor, and it hunts by **sound**: the more noise you make, the further away it can
hear you and the more precisely it knows where you are.

## Run it

ES modules need to be served over HTTP (opening `index.html` as a file won't work):

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome, Edge, or Firefox. Three.js loads from a CDN, so
you need an internet connection. There's no build step. The first load pulls in about 43 MB of
textures, models, and photographed skies from `assets/`.

**Difficulty.** Pick one on the title screen (it's remembered):

| | Creature | Hits to die | Flares | Broken glass | Ticking | Stopped clocks point the way |
| --- | --- | --- | --- | --- | --- | --- |
| Peaceful | none | — | — | none | loud | yes |
| Easy | slower than you walk | 3 | 3 | none | loud | yes |
| Medium | normal speed | 2 | 3 | 5 piles | normal | no |
| Hard | 10% faster | 1 | 0 | 10 piles | faint | no |

**Graphics.** The title screen has a High/Medium switch. High adds ambient occlusion and a
sharper image; use Medium on older or integrated-graphics laptops.

## Controls

| Key | Action |
| --- | --- |
| Mouse | look |
| W A S D | move |
| Shift | sprint (fast, very loud, uses stamina) |
| C (hold) | crouch (slow, nearly silent, harder to see) |
| Space | jump (the landing is loud) |
| F | flashlight on/off (it can see the beam) |
| E | check a clock / take a med kit |
| Q | light a flare |
| H | use a carried med kit |
| Esc | pause |

## How it works

**Noise.** Every action has a loudness from 0 to 1, shown by the NOISE meter. Standing still
≈ 0, crouch-walking ≈ 0.1, walking ≈ 0.36, sprinting ≈ 0.85, landing a jump ≈ 0.75, and
**broken glass** = 1.0. Carpet muffles your steps, while tile, laminate, and the concrete
stairs carry them. The creature hears anything within `loudness × 30 m`. Sound travels through
doorways and around corners, and each wall in the way costs 5 m. Quiet sounds make it come
and look; loud or close ones make it charge.

**The creature.** A gaunt, near-black figure far taller than a person, with glowing eyes, a jaw
that hangs open, and arms that reach past its knees. It's taller than the door frames, so it
stoops to get through them. Signs it's close: heavy footsteps in 3D audio, lights going
haywire, your flashlight flickering, and your heartbeat. It can't follow you into the
stairwells. It waits at the door.

**Wounds.** How many hits you can take depends on the difficulty (see above). Each wound
makes it back off for a moment. While you're hurt you move 10% slower and limp: an uneven
stride, a dragged foot, the screen draining of colour.

**Med kits.** They're in apartments, often bathrooms (not on Hard or Peaceful, where you
can't be wounded). Picking one up while hurt heals a wound
right away. Otherwise you carry it (up to 3) and use it with H.

**Flares.** You have 3 on Easy and Medium. Lighting one makes the creature flee and keep away for 30 seconds while
it burns. After it burns out there's a 20-second recharge before you can light the next.

**The stairs.** The two stairwells are real, walkable stairs, but climbing or descending a full
storey brings you seamlessly back onto the same floor 4.

**Winning.** There are ten clocks. All of them have stopped except one, which shows the real
time and ticks. Press E on it and you lift it off the wall. Every stopped clock in the building
starts up at once and the lights surge. The noise brings the creature charging at you,
bursting the bulbs it passes, until time stops a step short of you. Then the apartment folds
in on itself, crushes the creature, and leaves you standing on an ordinary sunny city street.
Finding it:
- The ticking carries a long way and sounds muffled through walls, so you can follow it
  (headphones help a lot).
- On Peaceful and Easy, checking a stopped clock tells you where the ticking is coming
  from, such as "Ticking, somewhere not far — off to your left."
- When you get within earshot, you'll see "You can hear a clock ticking nearby…".

**Microphone (optional).** Click **Enable microphone** on the title screen and your real-world
noise feeds into the game. Talking, coughing, or laughing will draw it to you. Use headphones.

## Under the hood

The surfaces, furniture, and skies are real photoscanned assets from
[Poly Haven](https://polyhaven.com), all CC0 (public domain); see `assets/CREDITS.md`. A
faint world-space dust and tone layer and soft corner shadowing go on top of the photo
textures so no two walls look the same. The creature, the sounds, and the floor plan are all procedural.

- `src/level.js`: apartment floor-plan generation (corridors, units, rooms, doors, windows,
  stairwells), wall-edge collision, line of sight, A* pathfinding, sound propagation,
  and the looping stair height function
- `src/world.js`: batched wall/floor geometry with world-space UVs, furniture per room type
  (models baked into the batches), doors, windows, stairwells, clocks, med kits, lights
- `src/assets.js`: loads the textures, glTF models, and HDR skies
- `src/textures.js`: photo materials with the dust overlay, plus generated fabric, wood,
  metal, and skin textures
- `src/entity.js`: the creature's body, procedural animation, and its hearing/sight/flee AI
- `src/audio.js`: Web Audio synthesis, HRTF 3D sound, reverb, rain and thunder, mic input
- `src/main.js`: renderer and post-processing (anti-aliasing, ambient occlusion, bloom, film
  grain), dust in the flashlight beam, player, flare, wounds, the ending, and the game loop

To re-download the assets, run `python3 tools/fetch_assets.py` and then
`sh tools/optimize_models.sh` (needs Node; it simplifies the denser models for real-time use).

Add `?seed=123` to the URL to replay a specific layout. Add `?debug` to see the creature's AI state.
