# ZapCartes

Liste tes cartes Pokémon en quelques secondes (France, Canada, États-Unis), avec reconnaissance par photo.

## Mise en ligne (Netlify + GitHub)
1. Netlify → Add new project → Import an existing project → GitHub → ce dépôt → Deploy.
2. Project configuration → Environment variables :
   - `GEMINI_API_KEY` = clé gratuite de aistudio.google.com (tests), et/ou
   - `ANTHROPIC_API_KEY` = clé de console.anthropic.com (payant).
   - `AI_PROVIDER` = `gemini` pour forcer Gemini quand les deux clés existent.
3. Deploys → Trigger deploy.

ZapCartes est un outil indépendant, non affilié à Nintendo, Creatures, GAME FREAK ou The Pokémon Company.
