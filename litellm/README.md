# LiteLLM Gateway (container local)

Gateway **OpenAI-compatible** que roteia para a OCI via **assinatura nativa**
(Signature v1, usando a `.pem` do `~/.oci/config`). Com isso alcança **Cohere
chat e embeddings** — que o endpoint OpenAI-compat da OCI **não** entrega.

```
Angular → proxy Node (server/) → provider `litellm` → este container :4000 → OCI (nativo) / OpenAI / ...
```

O nosso proxy Node continua na frente (guardrail CleanPredict + anexo de imagem);
o LiteLLM é upstream, aparecendo no combo como `LiteLLM · <modelo>`.

## Configurar

```bash
cd litellm
cp litellm.env.example litellm.env
# preencha litellm.env com os valores do seu ~/.oci/config [genai]:
#   OCI_USER, OCI_FINGERPRINT, OCI_TENANCY, OCI_REGION, OCI_COMPARTMENT_ID
# a .pem é montada automaticamente de ~/.oci/cert.pem (ver docker-compose.yml)
```

Modelos servidos: veja/edite `config.yaml` (`model_name` é o alias que o combo
envia; `model: oci/...` é o id real na OCI).

## Rodar

```bash
docker compose -f litellm/docker-compose.yml up -d
# modelos servidos:
curl http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
# teste de chat (inclui Cohere, que o compat da OCI bloqueia):
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"oci-cohere-command","messages":[{"role":"user","content":"oi"}]}'
```

Para o app enxergar esses modelos, o `server/.env` precisa de
`LITELLM_BASE_URL=http://localhost:4000/v1` + `LITELLM_MASTER_KEY` (mesma master
key), e o backend reiniciado.

## UI admin

`http://localhost:4000/ui` — login com `UI_USERNAME`/`UI_PASSWORD` do `litellm.env`
(`UI_USERNAME`/`UI_PASSWORD` que você definir no `litellm.env`). A UI exige o Postgres (serviço
`db` do compose); sem ele o login falha com "Check UI_USERNAME/UI_PASSWORD".

## Guardrails de PII/LGPD (o stack completo)

O gateway tem **quatro guardrails ligados por padrão** (`default_on`), todos
**OSS** e configurados em `config.yaml`. Rodam em todo request que passa pelo
LiteLLM:

| Camada | Guardrail | O que faz | Modo |
| --- | --- | --- | --- |
| **PII** | `presidio-lgpd-br` | mascara CPF/CNPJ/PIS (com DV), e-mail, telefone, nome… e **re-hidrata** na resposta | `pre_call` |
| **Segredos** | `secrets-input` | mascara chave/senha (`sk-`, AWS, GitHub, PEM) coladas no prompt | `pre_call` |
| **Injeção** | `detect_prompt_injection` | **bloqueia** prompt injection (heurística + similaridade) | `pre_call` |
| **Moderação** | `moderation-output` | **bloqueia** saída nociva (self-harm/violência/armas) | `post_call` |

Mais **log mascarado** (`turn_off_message_logging`): metadados/tokens são logados,
o conteúdo da mensagem não.

- A camada de **PII** sobe no compose (`presidio-analyzer` custom pt-BR +
  `presidio-anonymizer` oficial). Detalhes/entidades/trade-offs:
  [`presidio/README.md`](presidio/README.md).
- As demais são **built-in** do LiteLLM (`litellm_content_filter` + callback de
  injeção) — não precisam de container extra nem de Enterprise.

**Ponto cego (importante):** os guardrails atuam no **texto**, não no **anexo**
(PDF/imagem em base64). Documento cru enviado a modelo de visão passa **sem
máscara** — ver o roadmap em [`presidio/README.md`](presidio/README.md).

**Ajustar por modelo:** `default_on: false` + `guardrails: [...]` no `litellm_params`
de cada modelo liga/desliga por alias (validado no `main-latest`; quebra em
versões ≤ 1.80.10).

## Notas

- **Streaming**: mesmo via LiteLLM, os modelos OCI mandam prompts-JSON como
  `tool_calls` (conteúdo vazio no stream). Por isso o backend trata o provider
  `litellm` como **não-streaming** (a resposta vem inteira).
- **Segredos**: `litellm.env` (credenciais de assinatura + master key) e a `.pem`
  ficam fora do container control/commit; a `.pem` é montada read-only.
- **Embeddings**: não usados pelo app hoje, mas o gateway já os expõe
  (`oci/cohere.embed-*`) se você evoluir para busca/RAG.
