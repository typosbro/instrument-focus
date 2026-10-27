# Promo reel

A 24-second vertical video (1080x1920, 30 fps) that shows the extension working on a real song:
the full mix, then vocals only, drums only, bass only, a custom mix, the real panel being clicked,
and an end card. Cuts land on the beat, the mixer graphic is drawn from the recording's own
audio, and the same composition renders in English and Uzbek.

It is built with [Remotion](https://www.remotion.dev): the video is a React component and every
frame is rendered in headless Chrome. Nothing here contains audio or video; the recordings, the
media cut from them, and the data measured from them are all ignored by git.

    record (OBS)  ->  prepare.sh  ->  beats.mjs  ->  timeline.ts  ->  render.sh  ->  out/reel_en.mp4

## 1. Record

Two takes in OBS of the same YouTube video, with the extension's cache already filled (play the
song through once first, so `Load cached stems` is instant on camera).

Settings:

- Video: canvas and output at the display's native resolution, 60 fps. The panel is small, and
  the reveal shot zooms into it 2.5x, so resolution is what keeps it sharp.
- Sources: macOS Screen Capture of the browser window, and Application Audio Capture of the
  browser only. Mute the mic and desktop audio; play the song and check only that meter moves.
- Browser: one window, one tab, Do Not Disturb on, page zoom 125 to 150%, mouse moving slowly.
- Pick the loudest section of the song where every instrument plays, and start both takes there.

Takes:

| file | what to do |
|---|---|
| flat | the song playing normally, panel closed, 20 s |
| demo | panel open with stems active. Flat for 4 s, click the Drums preset. Then for each of drums, vocals and bass: push its fader to +12, drag the other five to -24, hold 8 s. Also hold one two-stem mix (bass and vocals) for 4 s. |

## 2. Prepare

    cd promo
    npm ci
    scripts/prepare.sh ~/Desktop/flat.mov ~/Desktop/demo.mov

This copies both recordings into `work/` (the originals are only read), crops the YouTube player
into `public/`, and writes per-band loudness and onset data to `src/data/`.

The crop of the player and the coordinates of the panel are measured in source pixels, so a take
with a different canvas, zoom or window position needs them updated: `PLAYER_CROP` in
`scripts/prepare.sh` and `REVEAL` in `src/timeline.ts`. `scripts/sheet.sh` writes contact sheets
to `out/sheets/` to read them from.

## 3. Find the beat

    node tools/beats.mjs demo 49 66

Give it a window where the drums are soloed: the tempo fit is cleanest there. It writes
`src/data/tempo.json` and prints, for every 4 s window of each clip, the time of the first beat.
The phase drifts between sections, so snap each segment's start to the beat printed for its own
window.

## 4. Edit the timeline

`src/timeline.ts` lists the segments: which clip, the start time in the recording, the length in
beats, and the fader state the recording shows at that point (read it off `scripts/sheet.sh`).
Avoid windows with gaps in the music; a soloed stem often has rests. Then preview:

    npm run studio

On-screen text for both languages is in `src/copy.ts`.

## 5. Render

    npm run render            # both languages
    npm run render -- uz      # one

Writes `out/reel_en.mp4` and `out/reel_uz.mp4`, about two minutes each on an M1 Pro, with audio
mastered to -14 LUFS.

## Posting

- Instagram can mute a Reel that plays a commercial track for this long. Post it as a Reel with
  the original audio, and keep a cut ready in case it is flagged.
- For an A/B test, post the two languages at the same time of day on different days, with the
  same cover and hashtags, and compare average watch time, shares and saves after 48 hours.
- Point people at recordings they have the right to use, as the main README says.
