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

Name (max 45): Stems for YouTube - hear one instrument

Short description (max 132):
Separate any YouTube song into six stems on your own GPU. Push the drums forward, or the piano.

Detailed description (rewritten 2026-10-27, compliant with the keyword policy - paste the whole
block, do not hand-edit the old one):

Ever loved the drums in a song and wished everything else would get out of the way? This does
that, on the original recording.

Click once on any YouTube video and the extension separates the song into its individual parts
with a neural network running on your own graphics card. Then it plays those parts back in sync
with the video, and you choose which part is in front.

Nothing is re-recorded. You are hearing the original performance, balanced differently.

How it works
- One pass over the song, about a minute, fully on your device
- Results are cached, so replays are instant
- Click a part to lift it 9 dB and pull the rest back 6 dB
- Playback stays in sync when you seek, pause, change speed or switch tabs

What you need
- A GPU with WebGPU support. Chrome 113 or newer.
- Around 7 GB of free memory while it works.

Honest limits
- This is not live monitoring. The model needs 7.8 seconds of audio at a time, so the first pass
  waits and the replays are instant.
- Separation is a best guess. Isolating a part can sound hollow on hard transients.
- Anything the model cannot isolate is collected on a single "other" track.
- It does not work on Spotify or other DRM services, because their audio cannot be captured.

Nothing is uploaded. No account, no server, no tracking.

Note: the part names are deliberately absent from the detailed description. They stay in the
product UI, where a screenshot shows them because that is what the product looks like. Do not add
a list back to the description to compensate - see the rejection log at the bottom of this file.

## Category

Productivity, or Tools. Not "Entertainment" - reviewers look harder there.

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

## Assets you still need

- At least one 1280x800 or 640x480 screenshot
- A 1280x800 small promo tile
- The extension icon at 128x128, 48, 32 and 16 px. Currently there is no icon at all, so the
  store will show a placeholder. That needs making before submission.

## Package

Built by scripts/package.sh. Current size is about 325 MB because the model is bundled.
The whole package must be under the store limit and should ideally be much smaller; the fp16
variant of the model is 136 MB and untested.

## Rejections

### 2026-10-27 - Keyword Spam (Yellow Argon), Chrome Web Store

Item `olnifboggoicaddocjndcingckajpihb`. The listing text was rejected; the package was not.

Flagged text: `drums, bass, vocals, guitar, piano, and a catch-all`. An automated metadata
classifier reads a comma-separated product list as keyword stuffing. Note the punctuation: it
matches `docs/amo-listing.txt:9` exactly rather than the older copy in this file, which had
"piano and a catch-all". Confirm which text the dashboard actually holds before pasting the new
description.

Fix applied: the enumeration is gone from the detailed description. "individual parts" carries
the meaning; the second enumeration in the honest-limits bullet ("strings, synths and organ") was
removed for the same reason. The item name and short description were left untouched - they are
prose, and neither was flagged.

Left alone on purpose, do not "fix" them into a rewrite: the short description and
`docs/privacy-tab.txt:4` also name parts. The privacy tab is a required permission justification
seen by reviewers, not store metadata, and it was not flagged.

Owner action, in the Developer Dashboard: select the item, Build > Status, edit the listing's
detailed description (replace all of it), then submit for review. A listing-text change needs no
new package; edit whichever revision the rejection names, draft or published.

Recommendation: resubmit, do not appeal. The text really is a comma list, the same reviewer
reading would likely stand by the call, and the appeal queue costs days without changing that. If
a second review rejects the same field, appeal then, arguing that each named part is a visible
feature of the product, and point at the screenshots.

Firefox accepted the same sentence (AMO listing, `docs/amo-listing.txt:9`). Two stores, two
metadata classifiers. Do not edit the AMO listing; it has passed review.

