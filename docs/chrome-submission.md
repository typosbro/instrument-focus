# Chrome Web Store submission

## What you have to do yourself

Two things I cannot do for you:

1. Create the developer account at https://chrome.google.com/webstore/devconsole and pay the
   one-time five dollar registration fee. This is a real charge to your card, once.
2. Press submit, and own the account the extension ships under.

## Before you submit, decide this

Publishing an extension that extracts audio from YouTube is the risky part of this project.
Chrome Web Store policy prohibits extensions that infringe copyright or violate a third party's
terms of service, and YouTube's terms prohibit extracting audio. Extensions that do this get
removed, sometimes months after approval.

The honest defence: this extension does not download videos, does not redistribute anything, and
all processing happens locally on the user's own machine for their own listening. That is a
material difference from a downloader. It may still be judged a violation, and if it is, the
extension comes down and the account gets a strike.

If you want the lowest-risk path, ship on GitHub and skip the store. The README already has
install instructions, and "load unpacked" is the whole install.

## Listing copy

Title and summary are package fields, not listing fields. The dashboard shows them as "Title
from package" and "Summary from package" (`extension/manifest.json` `name` and `description`:
"Stems for YouTube" and the six-stem summary). Changing either means changing the manifest and
uploading a new 325 MB package, and neither was flagged on 2026-10-27. Leave both alone. The
editable fields are description, category, language, graphics and URLs.

Description - replace all 2,026 characters with this. Long lines are intentional; copy as-is.

Ever loved the drums in a song and wished everything else would get out of the way? This does that, on the original recording.

Click once on any YouTube video and Stems separates the song into its individual parts with a neural network running on your own graphics card. Then it plays those parts back in sync with the video, and you decide what is in front.

Nothing is re-recorded. You are hearing the original performance, balanced differently.

WHY NOT JUST USE AN EQUALISER
An equaliser moves frequency bands, not instruments. Two parts can occupy the same frequency range, so turning up "high" does not turn up the piano. This separates the actual parts, which is why pushing the drums forward sounds like more drums rather than more treble.

HOW IT WORKS
- One pass over the song, about a minute, entirely on your own device
- The result is cached, so replays of the same video are instant
- Click a part to lift it 9 dB and pull the rest back 6 dB. The whole mix is then levelled to a fixed loudness, so you compare balance rather than volume
- Seek, pause, change playback speed or switch tabs - playback stays locked to the video

WHAT YOU NEED
- Chrome 113 or newer, with WebGPU
- Around 7 GB of free memory while it works
- A reasonably recent graphics processor. Integrated graphics from several years ago may be too slow.

HONEST LIMITS
- This is not live monitoring. The model needs 7.8 seconds of audio at a time, so the first pass waits and every replay after that is instant.
- Separation is a best guess. Soloing one part can sound hollow where the model dropped a transient.
- The "other" track is a bucket, not an instrument: anything the model cannot isolate lands there.
- It does not work on Spotify or other DRM services, because their audio cannot be captured.

PRIVACY
Nothing is uploaded. No account, no server, no analytics, no tracking. The audio never leaves your computer.

Open source, MIT licensed: github.com/typosbro/instrument-focus

Three edits from the rejected copy, nothing else changed:
- "six parts - drums, bass, vocals, guitar, piano, and a catch-all -" became "its individual parts"
- "Bass, mid and treble move frequency" became "An equaliser moves frequency bands"
- "strings, synths and organ all land there" became "anything the model cannot isolate lands there"

Keep the part names out of the description. They stay in the product UI, where screenshots show
them because that is what the product looks like.

## Category

Entertainment (the value in the dashboard on 2026-10-27). The earlier note here said
Productivity/Tools, but Entertainment was what got submitted and the category was not part of the
rejection. Leave it for the resubmission; changing category mid-review adds a review question for
no gain. Revisit after approval if discovery matters.

## Single purpose statement

One purpose: separate the audio of a YouTube video into instrument tracks and play them back
with user-chosen emphasis.

## Permission justification (paste into the form)

- youtube.com: to show the control panel on the video page and to identify the current video for
  caching.
- googlevideo.com: to request the media stream that YouTube serves, using the session the browser
  already has.
- storage: to cache separated stems locally so replays are instantaneous.
- No remote code. The model and the runtime are both bundled in the package.

## Privacy practices form

- Does the extension collect user data? No.
- Does it sell or transfer data? No.
- Is it used for purposes unrelated to the single purpose? No.
- Privacy policy URL: https://github.com/typosbro/instrument-focus/blob/main/docs/privacy-policy.md

## Assets

The dashboard form on 2026-10-27 shows:

- Store icon, 128x128, required
- At least one screenshot, 1280x800 or 640x400, JPEG or 24-bit PNG without alpha, up to five
- Small promo tile 440x280, optional
- Marquee promo tile 1400x560, optional
- Global promo video, optional

The earlier note here said there was no icon at all. If the Store icon slot is still empty, fill
it before resubmitting; a missing required asset blocks independently of the description.

## Package

Built by scripts/package.sh. Current size is about 325 MB because the model is bundled.
The whole package must be under the store limit and should ideally be much smaller; the fp16
variant of the model is 136 MB and untested.

## Rejections

### 2026-10-27 - Keyword Spam (Yellow Argon), Chrome Web Store

Item `olnifboggoicaddocjndcingckajpihb`. The listing text was rejected; the package was not.

Flagged text: `drums, bass, vocals, guitar, piano, and a catch-all`. An automated metadata
classifier reads a comma-separated product list as keyword stuffing. Confirmed 2026-10-27 02:50:
the dashboard was holding the AMO description verbatim (2,026 characters, including the
equaliser paragraph and the strings/synths/organ bucket), so the AMO copy had been pasted into
Chrome. The replacement in Listing copy keeps that structure and changes three spots.

Fix applied: the six-part list, the EQ-band list and the bucket list are gone from the
description. Title and summary are package fields, never editable in the listing, and neither was
flagged.

Left alone on purpose, do not rewrite them: `docs/privacy-tab.txt:4` names parts inside a
required permission justification, which is not store metadata and was not flagged. The same goes
for the AMO listing, which passed review.

Owner action, in the Developer Dashboard: select the item, Build > Status, edit the listing's
detailed description (replace all of it), then submit for review. A listing-text change needs no
new package; edit whichever revision the rejection names, draft or published.

Recommendation: resubmit, do not appeal. The text really is a comma list, the same reviewer
reading would likely stand by the call, and the appeal queue costs days without changing that. If
a second review rejects the same field, appeal then, arguing that each named part is a visible
feature of the product, and point at the screenshots.

Firefox accepted the same sentence (AMO listing, `docs/amo-listing.txt:9`). Two stores, two
metadata classifiers. Do not edit the AMO listing; it has passed review.

