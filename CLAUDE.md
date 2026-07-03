# CLAUDE.md

Guia para agentes de IA (Claude Code) e para quem chega no repo. Contexto rápido,
comandos que funcionam e **as regras de segurança inegociáveis**. Detalhes longos
ficam nos READMEs de cada pasta — este arquivo é o mapa.

## O que é

POC de **Doc AI**: OCR + extração estruturada + análise por LLM de documentos
brasileiros (CNPJ/CPF/certidões etc.). Nasceu **100% local no navegador** (OCR e
heurísticas sem backend) e ganhou uma **camada opcional de LLM** via proxy próprio
e, acima dele, um **gateway LiteLLM**.

## Arquitetura (3 camadas, cada uma opcional acima da anterior)

```
Navegador (Angular 20, standalone + signals)
  ├── OCR local: pdf.js + tesseract.js + heurísticas   ← funciona SEM backend
  └── Análise por LLM (opcional):
        → server/ (proxy Node/Express, guarda as chaves)
             ├── OpenAI  (SDK openai, streaming)
             ├── OCI GenAI (endpoint OpenAI-compat, header opc-compartment-id)
             └── litellm/ (gateway :4000, OpenAI-compat)
                   → OCI nativo (assinatura .pem → desbloqueia Cohere), OpenAI, ...
```

- O **frontend** escolhe o modelo por request num combo (`GET /api/models`).
- **Regra de ouro do produto:** conteúdo do documento é processado **local por
  padrão**; só vai a um LLM externo de forma **explícita e posterior ao OCR**.

## Como rodar

Pré-requisito: **Node** `^20.19` / `^22.12` / `>=24` (exigência do Angular 20).
Se `node` não estiver no PATH, provavelmente está atrás de um version manager
(mise/nvm/asdf) — ative-o antes.

```bash
# 1) Frontend (raiz) — sobe em http://localhost:17000, faz proxy de /api p/ :13001
npm install
npm start                      # = ng serve (porta/host em angular.json)

# 2) Proxy de LLM (opcional) — sobe em 0.0.0.0:13001
cd server && npm install && npm start
curl http://localhost:13001/health

# 3) Gateway LiteLLM (opcional) — container :4000 + Postgres
docker compose -f litellm/docker-compose.yml up -d
curl http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

Só a camada 1 já é uma demo funcional. As camadas 2 e 3 só ligam se os `.env`
correspondentes existirem (veja abaixo).

## Segredos — LEIA ANTES DE COMMITAR 🔒

Este repo já foi limpo com cuidado. **Nunca** versione chave/credencial.

- **Nunca commitar:** `server/.env`, `litellm/litellm.env`, qualquer `*.env`
  (exceto `*.env.example`), `*.pem`, `*.key`, e o `task.md` (tem chave real colada).
  Tudo isso está no `.gitignore`.
- **Config versionada só referencia ambiente**, nunca valores: em
  `litellm/config.yaml` as credenciais são `os.environ/NOME` — mantenha assim.
- **Para configurar:** copie os `*.example` e preencha localmente:
  `cp server/.env.example server/.env` e `cp litellm/litellm.env.example litellm/litellm.env`.
- **Antes de qualquer exposição externa (ngrok/deploy):** rotacione a master key
  do LiteLLM, a senha da UI admin e as API keys — as atuais são de POC local.
- **Ao terminar uma mudança, antes de `git add`:** confira o que vai entrar
  (`git status`, `git diff --cached`) e faça um scan de segredo
  (`git grep -nE 'sk-|ocid1|-----BEGIN'` nos arquivos staged). Se aparecer valor
  real, pare.

## Mapa do repositório

| Caminho | Papel |
| --- | --- |
| `src/app/services/` | OCR local: `pdf.service`, `image.service` (Otsu), `ocr.service`, `extraction.service`, `document-processing.service` (facade c/ signals) |
| `src/app/services/llm-analysis.service.ts` | Cliente da análise por LLM; combo de modelos; `PROVIDER` alterna `'cleanpredict'` (proxy) vs `'local'` (WebLLM) |
| `src/app/components/llm-analysis/` | UI do combo de modelo + envio de arquivo à IA |
| `server/index.js` | Proxy Node: registry de modelos (`MODELS[]`), roteamento por provider, `GET /api/models`, `POST /api/analyze` |
| `server/README.md` | Detalhes do proxy, OCI compat, smoke tests |
| `litellm/config.yaml` | `model_list` do gateway (aliases → `oci/...`, `openai/...`) |
| `litellm/README.md` | Subir o gateway, UI admin, notas de OCI nativo/streaming |
| `README.md` (raiz) | Doc completa da POC local (pipeline de OCR, robustez, roadmap) |

## Convenções e armadilhas conhecidas

- **Angular:** standalone components (sem NgModule), **signals** para todo estado,
  `ChangeDetectionStrategy.OnPush`. A facade expõe signals **read-only**.
- **Modelos (flags no `server/index.js`):** `vision` (aceita `image_url`), `pdf`
  (PDF nativo via `type:"file"`), `stream`.
  - **OCI não aceita PDF anexo** no modo compat → o PDF vai como **1ª página
    rasterizada** (imagem). Só a família **gpt-4o/gpt-4.1** (direto ou via LiteLLM)
    lê **PDF nativo**.
  - **Streaming OFF para OCI e LiteLLM:** com prompts que pedem JSON, os modelos
    OCI respondem `finish_reason:"tool_calls"` com conteúdo vazio no stream. O
    backend trata esses providers como **não-streaming** de propósito — não
    "conserte" ligando streaming.
  - **Cohere é text-only** aqui: `vision=false` é intencional (ligar dropava a
    imagem em silêncio).
- **Portas:** frontend `17000`, proxy `13001`, LiteLLM `4000`. O front acessa o
  proxy via `/api` (ver `proxy.conf.json`), então tudo cabe numa URL só: `:17000`.
- **CleanPredict** é guardrail opcional (roda ao lado da chamada, não é proxy de
  LLM). Sem `CLEANPREDICT_*` no `.env`, o proxy vai direto ao modelo.

## Ao usar a API da Anthropic no código

Modelos recentes: **Claude Opus 4.8** (`claude-opus-4-8`), Sonnet 5
(`claude-sonnet-5`), Haiku 4.5 (`claude-haiku-4-5-20251001`). Prefira o mais
capaz e recente. Chamada de LLM **sempre no backend/proxy** — nunca com a chave no
navegador.
