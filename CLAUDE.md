# Cruise Weather repo

Static GitHub Pages site. See README.md for how it works.

Adding a cruise: research the itinerary (ship, IMO, day-by-day ports and times), confirm the ports with the owner before committing (cruise lines change itineraries), write `cruises/<slug>.json` with port terminal coordinates and estimated noon positions for sea days, and add the slug to `cruises/index.json`. Use slugs that don't encode dates. Keep README.md in sync with any code change.
