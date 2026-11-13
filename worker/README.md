# Live flight search

Trip Picker gets live one-way fares from Google Flights through [SerpApi](https://serpapi.com/google-flights-api). The SerpApi key can't sit in the page, because anyone could read it there. A small Cloudflare Worker (`worker.js`) holds the key: the page asks the Worker, and the Worker asks SerpApi.

What the Worker does:

- It only answers requests from https://tgal1.github.io.
- It remembers each search (start, destination and date) for 6 hours, so repeat searches cost nothing.
- It allows 8 new searches a day. The free SerpApi plan gives 250 a month, so strangers can't use it up.
- It asks for economy fares for one adult in A$, and sends back up to 10 flights per destination: the cheapest, plus the two quickest.

Each destination is one search, so a trip with two destinations uses two searches each time the start or date changes. Airport transfers are not part of the search. They come from each destination's saved details.

## Cost

Both services are free at this level of use.

- SerpApi free plan: 250 searches a month, 50 an hour. If that runs short, the next plan is US$25 a month for 1,000.
- Cloudflare Workers free plan: 100,000 requests a day.

## Setting it up

1. **SerpApi.** Sign up at https://serpapi.com/users/sign_up (it asks to confirm your email and phone number). Then open https://serpapi.com/manage-api-key and copy your private API key.
2. **Cloudflare.** Sign up at https://dash.cloudflare.com/sign-up and confirm your email.
3. **Create the Worker.** In the Cloudflare dashboard, go to **Compute (Workers) > Workers & Pages > Create > Start with Hello World**. Name it `trip-picker-flights` and click **Deploy**.
4. **Put in the code.** Click **Edit code**. Delete everything in the editor and paste in the contents of [worker.js](https://raw.githubusercontent.com/tgal1/trip-picker/main/worker/worker.js). Click **Deploy**.
5. **Add the key.** Go back to the Worker and open **Settings > Variables and Secrets > Add**. Set the type to **Secret** and the name to `SERPAPI_KEY`, paste the SerpApi key as the value, and click **Deploy**.
6. **Send the address.** The Worker's address is shown on its page, for example `https://trip-picker-flights.your-name.workers.dev`. Put it in `FLIGHTS_API` near the top of the script in `index.html`. That turns on the **Search live flights** button and the automatic search.

Optional settings, under **Settings > Variables and Secrets** (as plain text):

- `DAILY_LIMIT`: new searches allowed per day. The default is 8.
- `ALLOWED_ORIGINS`: the sites allowed to use the search, separated by commas. The default is `https://tgal1.github.io`.

Optional: to make the daily count exact everywhere, add a KV store.

1. Go to **Storage & Databases > KV > Create** and create one called `trip-picker-counts`.
2. In the Worker, go to **Settings > Bindings > Add > KV namespace**. Set the variable name to `COUNTS` and pick that store.

Without the store, the count is kept separately in each Cloudflare data centre. That is fine for one person's use.

## Checking it works

```bash
curl -H "Origin: https://tgal1.github.io" "https://trip-picker-flights.your-name.workers.dev/search?from=MEL&to=CTS&date=2027-02-06"
```
