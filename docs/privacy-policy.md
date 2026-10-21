# Privacy Policy — Stems for YouTube

Last updated: 21 October 2026

## The short version

This extension does not collect, transmit, sell or share any personal data. There is no server.
There is no account. Nothing leaves your computer.

## What the extension processes

To separate a song, the extension reads the audio of the YouTube video you are currently
watching and runs a machine learning model on it. That audio is processed **entirely on your
device**, inside your browser, using WebGPU. It is never uploaded anywhere.

The separated tracks are cached in your browser's local storage (IndexedDB) under the video's
identifier, so that replaying the same video does not require separating it again. This cache
stays on your machine. You can clear it by removing the extension or clearing site data.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics
- No identifiers, cookies, or fingerprinting
- No browsing history
- No audio, video, or derived audio ever leaves the device
- No advertising, and no data shared with advertisers or any third party

## Permissions, and why each one exists

- **Access to youtube.com pages** — needed to display the panel on the video page and to read
  the video identifier so results can be cached per video.
- **Access to googlevideo.com** — YouTube serves media from this domain; the extension requests
  the audio stream from it, using the same session your browser already has.
- **Storage** — used to cache separated tracks locally so replays are instant.

No permission is used for any purpose other than the ones listed above.

## Third-party components

The extension bundles an open-source model (HTDemucs-6s, MIT licence) published by StemSplitio,
and ONNX Runtime Web (MIT licence). Both run locally. Neither contacts a server.

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

If this policy ever changes, the updated version will be published at this same URL.

## Contact

Open an issue at https://github.com/typosbro/instrument-focus/issues
