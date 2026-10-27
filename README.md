# Instrument Focus

Hear one player inside a song.

A finished mix is a single stereo file. You cannot turn the drums up, because drums and piano share
the same frequencies. EQ moves frequency, not instruments. This project separates the mix into the
instruments it was made of, then lets you push one forward and pull the rest back. Nothing is
re-recorded and nothing is re-performed: you are hearing the original take, balanced differently.

Think of it as what a drummer does when they cover a song with their own instrument pushed to the
front, except the original is still playing and you choose who is in front.

## Status

Working, and honest about what is not done.

| part | state |
|---|---|
| Six-stem separation, measured per stem | working |
| Adaptive mixer page, one self-contained HTML per song | working |
| Batch pipeline: link in, page out | working |
| Browser-side separation on WebGPU | measured, RTF 0.191 |
| Browser extension, Chrome MV3, separation on your own GPU | working, measured |

## Try it

    git clone https://github.com/typosbro/instrument-focus
    cd instrument-focus
    ./scripts/fetch_assets.sh          # 325 MB of model and runtime, once

Then in Chrome: chrome://extensions, turn on Developer mode, Load unpacked, pick the extension
folder. Open any YouTube video and click the pill in the bottom right.

You need WebGPU. An 8 GB integrated-graphics laptop will struggle: see the limits below.

## How it works

    link  ->  audio  ->  HTDemucs-6s  ->  six stems  ->  measure  ->  manifest  ->  page

The important part is **measure**. A separation model always returns six stems, even when the song
has no guitar. So each stem is measured over the whole song, and anything below -45 dBFS is reported
as absent rather than offered as a fader that does nothing. The page reads the manifest and builds
its channels from it, so a song with no piano simply has no piano fader. There is no hardcoded
instrument list anywhere.

Then the page mixes live in the browser. A preset lifts the chosen instrument by 9 dB, pulls the
others back by 6 dB, and trims the whole mix so it sits at the same loudness as the others, so you
are judging balance rather than volume. The trim is clamped so the output never exceeds -1 dBFS.

## Measured numbers

Separation throughput in a browser, on an RTX 4060 via ONNX Runtime Web and WebGPU:

    RTF 0.191    (0.191 / 0.191 / 0.189 over three runs)
    5,734 ms to separate 30.0 s of audio, four segments of 343,980 samples
    output verified against native ONNX Runtime: piano stem RMS 0.2446 vs input 0.2455

Server-side batch pipeline, CPU only, for a 271-second song:

    resolve 2.6 s | download 3.9 s | separate 77.7 s | measure 0.9 s | render 38.5 s
    total 141.7 s, page 26 MB, all six stems present

## The extension

On a YouTube watch page it takes the audio, separates it into six stems on your own GPU, caches the
result by video id, and then plays the stems in sync with the video. No server is involved and no
audio leaves the machine.

Measured on a 3:32 song:

    click to ready   64.2 s   (37 windows of 7.8 s, 1.397 s per window, compute RTF 0.179)
    cached replay     0.29 s
    memory           ~6.45 GB summed Chrome RSS
    sync             settled drift 0 ms, transient max 57 ms
    cache            224 MB, about 1.06 MB per second of music

It survives seek, pause, rate change, tab switch and ad breaks without drifting.

## What actually limits this

**Six stems is the model's ceiling.** Strings, synths, organ and brass all land in *other*. That
fader is a bucket, not an instrument. A finer split needs a different model, not a tweak.

**Separation is a best guess.** Solo one instrument and it can sound hollow where the model dropped
a transient. There is bleed between channels. It is very good and it is not a studio multitrack.

**The model is not causal.** Its input is a fixed 7.8-second window, so 7.8 s is the latency floor no
GPU can beat. This rules out live monitoring and DJ use. What it allows is: separate once, cache it,
then every replay is instant.

**The browser path needs WebGPU.** The float32 model is 258 MB and exceeds the wasm32 heap, so a pure
WASM fallback dies with std::bad_alloc. Apple Silicon, modern discrete GPUs and recent Linux drivers
are fine. Old integrated graphics are not.

**DRM sites cannot be captured.** YouTube, SoundCloud and Bandcamp expose their audio to the Web
Audio API. Spotify does not, and no extension can change that.

## Quick start

You need: ffmpeg, Python 3 with demucs installed, and yt-dlp.

    pip install demucs yt-dlp
    python3 engine/build_song.py --url "<youtube link>" --out songs/mysong

That writes `songs/mysong/manifest.json` plus the stems. Then build the page:

    python3 web/src/build_offline.py --manifest songs/mysong/manifest.json --out songs/mysong/page.html

Open `page.html`. It is one file, works offline, and makes no network requests.

To run it as a service instead:

    python3 engine/server/server.py

then open port 8484, paste a link, and wait about two and a half minutes.

## Browser separation

The ONNX export is published by [StemSplitio](https://huggingface.co/StemSplitio/htdemucs-6s-onnx)
(MIT): `htdemucs_6s.onnx`, 258 MB fp32, 136 MB fp16.

It does not load in a browser as published. The stock export computes its inverse STFT in float64
and ONNX Runtime Web ships no float64 kernels, so it fails with a shape error that tells you nothing.
`engine/webgpu/make_web_model.py` rewrites the doubles to float32; parity against the original is
5.96e-08.

One warning that cost real time: **headless Chrome cannot use WebGPU.** `navigator.gpu` is undefined
and Vulkan is disabled. It works headful under `xvfb-run` with
`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=native`. A headless-only test will
tell you WebGPU is impossible when it is not.

## Promo video

`promo/` builds the vertical demo reel from two screen recordings: beat-synced cuts, an animated
mixer driven by the recording's own audio, English and Uzbek. See [promo/README.md](promo/README.md).

## Credits

[Demucs](https://github.com/facebookresearch/demucs) and HTDemucs-6s by Meta AI Research.
ONNX export by [StemSplitio](https://huggingface.co/StemSplitio/htdemucs-6s-onnx).
Prior browser work that proved the approach: [sevagh/demucs.onnx](https://github.com/sevagh/demucs.onnx),
[timcsy/demucs-web](https://github.com/timcsy/demucs-web),
[Max Graf's Demucs WebGPU](https://maxgraf.space/projects/demucs-webgpu/).

## Licence

MIT for this code. The model has its own licence, see the Hugging Face page.

Nothing in this repository contains audio. Separation is a derivative work of whatever you feed it,
so point it at recordings you have the right to use.
