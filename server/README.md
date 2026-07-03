# Proxy OpenAI + guardrail CleanPredict (backend mínimo)

Backend Node que fica entre o frontend Angular e a **OpenAI**, com o **CleanPredict**
atuando como guardrail. Existe por dois motivos: a POC roda 100% no navegador e
as **duas chaves** (OpenAI e CleanPredict) precisam ficar do lado do servidor.

> ⚠️ O CleanPredict **não é um proxy de LLM**. É um middleware de
> segurança/observabilidade que roda **ao lado** da chamada ao modelo. A OpenAI
> é chamada **diretamente**.

## Fluxo (doc CleanPredict, cap. 5.3)

```
Angular → este proxy (localhost:3001):
  1. evaluate (pré)  → CleanPredict diz se o prompt pode ir ao LLM
  2. se liberado     → chama a OpenAI DIRETO (lib openai), em streaming
  3. evaluate (pós)  → reenvia com tokens reais p/ popular métricas
```

Se o guardrail bloquear, o passo 2 não acontece e o proxy devolve um JSON
`{ "blocked": true, ... }` (o frontend trata e mostra a mensagem).

## Configurar

```bash
cp .env.example .env
# edite .env: OPENAI_API_KEY, CLEANPREDICT_API_KEY, CLEANPREDICT_WORKSPACE_SLUG
```

## OCI + OpenAI juntos (modelo selecionável no frontend)

A OCI expõe um endpoint **compatível com OpenAI**, então usamos a mesma lib
`openai`; só muda a base_url, a chave e o header do compartment. O proxy sobe
**os dois provedores ao mesmo tempo** (cada um que tiver chave no `.env`) e o
frontend escolhe o modelo por request, via um combo. Para habilitar a OCI:

```bash
OCI_GENAI_API_KEY=sk-...            # API Key bearer da OCI (Generative AI -> API Keys)
OCI_COMPARTMENT_ID=ocid1.compartment.oc1..xxxx
OCI_REGION=sa-saopaulo-1
# opcional: lista dos modelos oferecidos no combo (CSV). Default = os 2 abaixo,
# que respondem em sa-saopaulo-1 (sondados; models.list() não funciona no compat).
OCI_MODELS=meta.llama-3.3-70b-instruct,meta.llama-3.2-90b-vision-instruct
# LLM_PROVIDER define só QUAL provedor já vem selecionado no combo (oci|openai).
LLM_PROVIDER=oci
# CLEANPREDICT_* é opcional: vazio = proxy vai direto ao LLM (sem guardrail).
```

O frontend lê `GET /api/models` e popula o combo. "Enviar arquivo à IA" só
aparece habilitado em modelos com **visão** (`…vision…` na OCI, ou gpt-4o):
como a OCI **não aceita PDF anexo** no modo compat, o PDF é enviado como a
**1ª página rasterizada** (imagem); imagens vão direto.

Validar a conexão isolada, sem subir o app:

```bash
OCI_GENAI_API_KEY=sk-... OCI_COMPARTMENT_ID=ocid1... node oci-smoke-test.mjs
# quais modelos respondem na sua região:
OCI_GENAI_API_KEY=sk-... OCI_COMPARTMENT_ID=ocid1... node oci-probe-models.mjs
```

Limites do caminho OpenAI-compat: **embeddings, rerank e Cohere chat não passam**
por aqui, e `models.list()` quebra. Para esses casos é preciso o SDK nativo da
OCI (autenticação por `~/.oci/config` + `.pem`), fora do escopo deste proxy.

## Rodar

```bash
cd server
npm install
npm start
# saúde:
curl http://localhost:13001/health
```

O backend sobe em `0.0.0.0:13001`. O frontend (`ng serve`) sobe em
`0.0.0.0:17000` e faz proxy de `/api` para cá (ver `proxy.conf.json` na raiz),
então tudo fica acessível por uma única URL: **http://&lt;host&gt;:17000**.

## Endpoints

`GET /api/models` — lista `{ models: [{ id, provider, label, vision }], default }`
para o combo do frontend (só os provedores configurados).

`POST /api/analyze` — recebe `{ messages, model?, temperature?, max_tokens?, file? }`.
O `model` escolhe o provedor (OCI ou OpenAI); ausente/desconhecido → o default.
Devolve o texto em **streaming** (`text/plain`), ou JSON de bloqueio se o
guardrail barrar.

## Frontend

Em `src/app/services/llm-analysis.service.ts`, a constante `PROVIDER` controla
de onde vem a análise: `'cleanpredict'` (este proxy) ou `'local'` (WebLLM, modo
original). Já vem em `'cleanpredict'`.
