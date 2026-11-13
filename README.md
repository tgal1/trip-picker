# Trip Picker

Compare ways to get somewhere side by side: each flight plus the train, bus or car at the other end, with door-to-door time and full cost per person.

Live site: https://tgal1.github.io/trip-picker/

- Trips are saved in each visitor's own browser.
- **Copy share link** packs a whole trip into the link, so whoever opens it gets their own copy to change.
- **Search live flights** fills the table with one-way fares from Google Flights for each destination. It also runs by itself when you change the start or the date. It works through a small Cloudflare Worker that holds the search key: see [worker/README.md](worker/README.md).
- Airport transfers come from each destination's saved details.
- Prices are what Google Flights showed at the time listed, or what was entered by hand. Check them on the booking site before paying.

The whole app is one file, `index.html`, with no build step. The flight search Worker is `worker/worker.js`.
