# ECO

A tiny browser game about echolocation, written in vanilla JavaScript — no
dependencies, no build step.

You are a small creature lost in a pitch-black cave. Press **SPACE** to emit a
ping: the sound wave expands outward and briefly lights up the walls it
touches. When a wave crosses the exit you hear a chime — panned toward it,
louder the closer you are. Navigate by memory and by ear.

From level 2 onward something else lives in the cave. It is blind too, but it
hears every ping you emit — and it comes looking. Pings reveal it only as a
snapshot of where it *was*.

## Run

Serve the folder with any static server and open it in a browser:

```
python3 -m http.server 8123
```

Then visit http://localhost:8123.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | move |
| SPACE | ping |
| R | regenerate the current level |

## How it works

- **Cave generation** — cellular automata smoothed over random noise; only the
  largest connected region is kept. Start and exit are placed at the two ends
  of the cave's graph diameter (double BFS), so the walk is always the longest
  one available.
- **Ping** — 540 rays are raycast on the grid (DDA) when the ping is emitted;
  each hit is revealed only when the expanding wavefront actually reaches it,
  so the ring visually gets absorbed where it meets rock.
- **Predator** — BFS pathfinding on the grid. It wanders when idle and hunts
  the origin of the last sound it heard: your pings, or your footsteps at
  close range. Its proximity is telegraphed by your own heartbeat.
- **Audio** — everything is synthesized live with WebAudio oscillators; there
  are no sound files.
