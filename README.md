# ClipTweet

Live frontend: https://cliptweet.github.io/

Static HTML/CSS/JS only. Post metadata is resolved by Cloudflare at
https://cliptweet.clipdownload.workers.dev/api/resolve. Video rendering and
MP4 downloads happen in the browser. No credentials belong in this repository.

GitHub Pages publishes `main` at repository root with HTTPS. No custom workflow
or build dependencies are required. `.nojekyll` preserves static files.

Frontend is exported from the ClipTweet source project with:

`node tools/export-frontend.cjs output/pages-site https://cliptweet.github.io https://cliptweet.clipdownload.workers.dev`

Only exported static files should be updated here; backend remains on Cloudflare.
