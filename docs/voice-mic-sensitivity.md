# Voice microphone sensitivity — how it works and how to make it less sensitive

This documents how lfg decides when the microphone is "hearing you" and how to
tune it so the mic is **less** sensitive (ignores background noise / room tone,
waits longer before deciding you've stopped talking).

Sensitivity lives in one place: the browser dictation path.

| Path | Where | What it is | Where sensitivity lives |
|------|-------|-----------|------------------------|
| **Browser dictation** | `web/src/App.tsx` | Push-to-talk / hands-free dictation in the web UI. Custom Web Audio VAD → streaming STT. | `VOICE_RMS_THRESHOLD`, `silenceMs` |

---

## 1. Browser dictation

This is the tap-to-talk / hands-free dictation built into the web app. It runs a
small **voice-activity detector (VAD)** entirely in the browser: every audio
frame it computes the RMS (loudness) of a 4096-sample window, decides "speech vs
silence", and after enough continuous silence it auto-submits.

Two constants govern sensitivity, both in `web/src/App.tsx`.

### a) Loudness threshold — `VOICE_RMS_THRESHOLD`

`web/src/App.tsx:391`

```ts
// RMS below this on a 4096-sample window counts as silence. Speech sits well
// above (~0.05–0.2); room tone / mic hiss sits below.
const VOICE_RMS_THRESHOLD = 0.01;
```

This is the dividing line between "talking" and "silence". Audio quieter than
`0.01` RMS is treated as silence; anything louder marks speech (sets the `spoke`
flag and resets the silence clock — see `App.tsx:552`).

**To make the mic LESS sensitive** (so background hum, fans, keyboard, distant
voices don't register as speech), **raise** this value:

| Value | Effect |
|-------|--------|
| `0.01` (default) | Picks up quiet/normal speech; also catches some ambient noise |
| `0.02` | ~2× louder required — ignores most room tone |
| `0.03`–`0.05` | Only clear, deliberate speech registers; best in a noisy room |

Trade-off: too high and genuinely quiet speech (soft voice, far from mic) gets
missed.

> Note: this is a **fixed** threshold, not adaptive/noise-floor-relative. It does
> not auto-calibrate to your room, so in a consistently loud environment raising
> it is the correct fix.

### b) Silence timeout — `silenceMs`

`web/src/App.tsx:454` (default) and the two call sites that set it.

```ts
const silenceMs = opts.silenceMs ?? 2500;   // default 2.5s
```

After speech has been heard, this is how long the mic must stay below
`VOICE_RMS_THRESHOLD` before it decides you're done and auto-submits. The VAD
checks every 200 ms and only fires once you've actually spoken
(`App.tsx:559-564`), so silence before your first word never triggers it.

The two places that pass this prop today both hardcode `2500`:
- `web/src/App.tsx:3336` — message field dictation
- `web/src/App.tsx:4852` — session composer dictation

**To make the mic LESS twitchy** (more patient — won't cut you off during a
thinking pause), **raise** `silenceMs`:

| Value | Effect |
|-------|--------|
| `1500`–`2000` | Snappy; submits quickly but may cut off mid-thought |
| `2500` (default) | Balanced |
| `3500`–`4000` | Tolerates long pauses; you can stop and think mid-sentence |

Change both call sites (3336 and 4852) to keep the two surfaces consistent, e.g.
`silenceMs={3500}`.

### Related visual-only tuning (does NOT affect sensitivity)

These shape the mic-button glow/scale animation and have **no** effect on
detection — listed so they're not mistaken for sensitivity knobs:
- `LEVEL_FULL_SCALE = 0.22` (`App.tsx:401`) — RMS that maps to full glow intensity
- `LEVEL_ATTACK = 0.55` (`App.tsx:405`) — how fast the glow rises
- `LEVEL_RELEASE = 0.1` (`App.tsx:406`) — how slow the glow falls

### Applying the change

These are frontend constants, so after editing rebuild the web bundle (served
live from disk, no restart needed per the deploy process):

```bash
npm --prefix web run build
```

---

## 2. Summary — "make the mic less sensitive"

1. **Ignores background noise** → raise `VOICE_RMS_THRESHOLD` (`App.tsx:391`)
   from `0.01` to `0.02`–`0.03`.
2. **Cuts me off when I pause** → raise `silenceMs` from `2500` to `3500`
   (`App.tsx:3336` and `App.tsx:4852`).
3. Rebuild: `npm --prefix web run build`.

## 3. Not currently user-tunable (no settings UI)

None of these are exposed in a settings panel — all require a code/env change
plus rebuild/restart. If you want a user-facing "mic sensitivity" control, the
clean path is:
- thread a tunable `VOICE_RMS_THRESHOLD` + `silenceMs` through the `useDictation`
  hook (it already accepts `silenceMs` as a prop), and
- persist the choice in `localStorage` (precedent: earpiece mode,
  `lfg_voice_earpiece`).
