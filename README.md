# datepoll

Find a date that works for everyone. No login, no accounts.

- Create a poll: a title and some dates. You get a unique link.
- Anyone with the link votes Yes, Maybe or No for each date.
- Votes are final: once submitted, they can't be changed.
- Optionally, add a phone number that voters can tap to call. Such a poll needs a delete-by date.
- All polls are deleted 6 months after they're created, or earlier if a delete-by date is set. Plain polls can't set one.

## How it works

- `web/`: a static page (plain HTML/CSS/JS, no build step), served by GitHub Pages.
- `worker/`: a Cloudflare Worker with one [Durable Object](https://developers.cloudflare.com/durable-objects/) per poll, which stores the poll and its votes in SQLite. Votes are insert-only, one per name (case-insensitive).

Each poll sets an alarm for its expiry, which deletes it on time even if nobody opens it again. Every request also checks the expiry and deletes the poll on the spot if the alarm hasn't run yet, so an expired poll is never served. There's no list of all polls to sweep; each one cleans up after itself.

A poll link looks like `https://mufflon.github.io/datepoll/#/<id>`, where the id is 128 random bits. Knowing the link is what lets you vote, so there are no secrets in the repo or in links.

Without logins, "can't change a vote" means the server rejects a second vote under the same name. Nothing stops someone voting under a different name, or under someone else's name before they do.

## Run locally

```sh
cd worker && npm install && npx wrangler dev    # API on http://localhost:8787
python3 -m http.server 8000 -d web              # site on http://localhost:8000
```

Open http://localhost:8000. The page talks to the local Worker when served from `localhost`.

## Deploy

Worker (run from `worker/`, not the repo root; the page is served by GitHub Pages):

```sh
cd worker
npx wrangler login
npx wrangler deploy
```

It deploys to `https://datepoll.mufflon.workers.dev`, which is what `API` at the top of `web/app.js` points to. When a change touches both, deploy the Worker before pushing the page.

Site: in the GitHub repo settings, set Pages → Source to **GitHub Actions**. Every push to `main` that touches `web/` publishes it.

`ALLOWED_ORIGINS` in `worker/wrangler.jsonc` lists the sites allowed to call the API from a browser.
