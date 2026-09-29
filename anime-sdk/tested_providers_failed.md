The following providers were implemented but failed to work reliably in standard server/browser environments due to aggressive Cloudflare and DDoS-Guard protection (even with FlareSolverr integration for some). They have been removed from the SDK to maintain stability:

- AnimePahe (animepahe.com)
- AnimeFire (animefire.plus)
- KickAssAnime (kaa.lt)

Reason for failure: 403 Forbidden on initial search/request.
Tested date: June 2026.
