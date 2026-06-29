# adcraftAI-backend

Supabase edge functions and migrations for AdCraft AI.

These functions run on Supabase (project `gfbkucmvrtkbumfvbgew`), not on Vercel.

Frontend repo: https://github.com/KadariPavani/adcraftAI-frontend

## Functions

- `analytics-summary` – aggregated analytics
- `enhance-image` – image enhancement
- `generate-content` – ad copy / campaign generation
- `generate-ecommerce-listing` – product listing generation
- `publish-post` – publish to social
- `track-click` – click tracking
- `voice-chat` – voice assistant

## Deploy (needs Supabase access)

```sh
npm i -g supabase
supabase login
supabase link --project-ref gfbkucmvrtkbumfvbgew
supabase functions deploy
```
