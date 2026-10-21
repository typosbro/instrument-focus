# Firefox AMO submission

## Status

The extension runs in Firefox. Verified 157.0.1 on Linux, headful, on a real YouTube song:
213 s of audio, six stems separated in 67.6 s, playback in sync at -7 ms drift, cached replay 1 ms.

## The one thing you must know before submitting

Firefox does not have WebGPU on by default on Linux yet. On Linux users see "WebGPU unavailable"
unless they enable it:

    about:config -> dom.webgpu.enabled -> true

Verified here: with the pref on, headful, `requestAdapter()` and `requestDevice()` both succeed.
Headless always returns a null adapter, so do not test it headless.

Firefox 141 shipped WebGPU on Windows by default. Linux is still pending per Mozilla's own
announcement. macOS status is unverified by us.

Put that in the listing description rather than hiding it. The panel already fails with a clear
message, so users are not left guessing.

## Upload

1. Create an account at https://addons.mozilla.org/developers/ (free, no fee)
2. Submit a New Add-on, choose "On this site"
3. Upload dist/stems-for-youtube-firefox-0.1.0.xpi
4. Source code: AMO may ask for it because the package includes a 241 MB model and a compiled
   runtime. Point them at https://github.com/typosbro/instrument-focus and say the model is a data
   file from StemSplitio (MIT), not compiled code.
5. Fill the listing. You can reuse the Chrome description, adding the Linux pref note.

## Listing fields

Name: Stems for YouTube

Summary (250 char max):
Separate any YouTube song into six stems on your own GPU. Push the drums forward, or the piano.
Runs locally, nothing is uploaded. Not live monitoring: one pass, then instant replays.

Description: reuse docs/chrome-submission.md, and add:

    FIREFOX ON LINUX
    Mozilla has not yet enabled WebGPU on Linux by default. Until they do, enable it yourself:
    type about:config in the address bar, search for dom.webgpu.enabled, and set it to true.
    On Windows, Firefox 141 and newer already have it enabled.

Category: Music and Audio (AMO has real audio categories), or Productivity.

Tags: youtube, stems, audio, separation, music, webgpu, instrument

## Screenshots

AMO wants up to 10, at most 1920x1080. The 1280x800 Chrome shots in ~/Desktop/instrument-focus-store
work. Use the Firefox one for at least one image so users see it running in their browser:

    /home/typosbro/Documents/ultra/firefox-test/shots/15-firefox-drums-playing.png

## What to expect

AMO reviews new add-ons by hand before they go public, and a 195 MB package that bundles a large
model will get extra attention. Expect days, not hours. They may ask about the bundled be
model — answer that it is MIT licensed weight data, not executable code, and that no code is
fetched at runtime.

The one policy risk is the same as Chrome's: extracting audio from YouTube may be judged a
violation of their terms. AMO tends to be more permissive than the Chrome Web Store, but it is
the same argument either way.

## Signing note

Release Firefox refuses unsigned sideloads entirely. To test on your Mac before AMO approval you
must use about:debugging -> This Firefox -> Load Temporary Add-on, which works but disappears on
restart. There is no way to permanently install an unsigned build.
