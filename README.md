# The Visionary Group Summarizer

Cron GitHub Actions che ogni ora controlla il canale YouTube @thevisionarygrouptx (growth marketing e-commerce), riassume i nuovi video via Claude Sonnet 4.5 e manda la sintesi strutturata via mail a Pierpaolo.

Stessa architettura di [nate-herk-summarizer](https://github.com/PierpaoloMaggio/nate-herk-summarizer), con canale e prompt diversi. Channel ID: `UCy9j5kvO1BDxB6ZJ8eAe7lQ`.

## Architettura

```
GitHub Actions cron (orario)
  → fetch RSS canale YouTube
  → diff vs state.json
  → per ogni nuovo videoId non Short:
      Apify transcript → Claude Sonnet 4.5 → SMTP Gmail
  → commit state.json aggiornato
```

I video con trascrizione sotto 1500 caratteri (Shorts) o con `#shorts` nel titolo vengono saltati e marcati come processati.

## Secrets richiesti

`APIFY_TOKEN`, `OPENROUTER_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` (app password Gmail, 16 caratteri senza spazi).

## Primo avvio

Actions → "The Visionary Group Summarizer" → Run workflow. La prima run è il seed: registra i videoId attuali senza mandare mail. Dalla seconda processa solo i nuovi.

## Health check

Il run risulta verde anche quando fallisce (gli errori sono catturati per video). Per verificare davvero: leggere il log dello step "Run summarizer" cercando `RSS entries`, `New videos`, `ERROR`, `mail sent`.
