# Orihon AI Agent demo

The demo has two execution paths:

- deterministic local scenarios, which need no model or key;
- `POST /api/agent`, which runs a provider-neutral tool loop through an OpenAI-compatible Chat Completions endpoint.

The API key stays in the server process. The browser receives only configuration status, normalized token usage, tool traces and Orihon SSE updates.

## Model configuration

PowerShell, hosted endpoint:

```powershell
$env:ORIHON_LLM_BASE_URL = "https://your-provider.example/v1"
$env:ORIHON_LLM_MODEL = "your-model"
$env:ORIHON_LLM_API_KEY = "your-key"
$env:ORIHON_LLM_PROVIDER = "your-provider"
npm run demo:ai
```

Local OpenAI-compatible endpoint (API key optional):

```powershell
$env:ORIHON_LLM_BASE_URL = "http://127.0.0.1:1234/v1"
$env:ORIHON_LLM_MODEL = "local-model"
Remove-Item Env:ORIHON_LLM_API_KEY -ErrorAction SilentlyContinue
npm run demo:ai
```

Open <http://127.0.0.1:4193/examples/ai-agent-demo/> and use **Через LLM**.

## Popups with place images

Point popups accept either the original plain string or safe declarative content:

```json
{
  "text": "Краткое описание места",
  "image": {
    "url": "https://images.example.org/place.jpg",
    "alt": "Название места",
    "caption": "Источник или подпись"
  }
}
```

Only HTTPS and local URLs (`/images/place.jpg`, `./images/place.jpg`) are accepted. Orihon renders the object through `popupContent()`; arbitrary HTML is not part of the AI contract.

For a photo with a short label shown on hover, use `visual` instead of `popup`:

```json
{
  "visual": {
    "image": { "url": "https://images.example.org/place.jpg", "shape": "circle", "fit": "cover", "borderWidth": 3 },
    "label": { "text": "Название", "display": "hover" },
    "size": 56,
    "collisionMode": "auto"
  }
}
```

AI labels default to hover tooltips. `display:"always"` remains available when persistent text is explicitly needed.

## Agent flow

1. The model receives `orihon_search_places` and `orihon_plan`.
2. Real-world coordinates must be resolved through the server-side Nominatim tool.
3. The compact semantic plan is validated and committed through `AIAgentRuntime`.
4. The existing SSE projection updates the browser map.
5. Provider-reported input, output and cached-input token counts are accumulated across every tool turn.

For a public deployment, set a policy-compliant `ORIHON_NOMINATIM_USER_AGENT`, add authentication and rate limiting to `/api/agent`, and replace the public Nominatim provider with the application's own place-search service when appropriate.
