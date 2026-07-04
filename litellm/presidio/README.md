# Guardrail de PII/LGPD — Microsoft Presidio (Fase 1)

Mascaramento de **dados pessoais brasileiros** antes de o texto sair para um LLM
externo. É a camada técnica de **minimização** que a LGPD pede (Art. 6): dado
pessoal é **mascarado por padrão**; só o texto já anonimizado trafega.

```
Angular → proxy Node → LiteLLM (:4000)
                          │  guardrail "presidio-lgpd-br" (pre_call, default_on)
                          ├── presidio-analyzer  (custom: pt-BR + recognizers BR)  → acha a PII
                          └── presidio-anonymizer (imagem oficial)                 → mascara
                          ↓
                        LLM (OCI / OpenAI / Cohere) recebe já mascarado
```

## Por que uma imagem custom do analyzer

O Presidio oficial vem afinado para inglês e **não valida dígito verificador**.
Aqui o `analyzer/` sobe um `AnalyzerEngine` em **português** (spaCy
`pt_core_news_lg`, com os labels `PER/LOC/ORG` mapeados para as entidades do
Presidio) e registra **recognizers brasileiros**. O **anonymizer não é
customizado** — mascarar é agnóstico de idioma, então usamos a imagem oficial.

### Entidades reconhecidas

| Entidade | Como detecta | Falso-positivo |
| --- | --- | --- |
| `BR_CPF`, `BR_CNPJ`, `BR_PIS` | regex **+ validação de DV (checksum)** | baixíssimo — só casa número válido |
| `BR_CNH`, `BR_CNS`, `BR_CEP`, `BR_PLACA` | regex **+ palavras de contexto** | médio — precisa de contexto perto |
| `PERSON`, `LOCATION` | NER do spaCy pt | depende do modelo |
| `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IP_ADDRESS` | recognizers built-in | baixo |

> **DV = a mesma ideia do front.** A `extraction.service.ts` já valida o DV do
> CNPJ para não aceitar lixo do OCR. Aqui o `validate_result` faz o mesmo: número
> inválido é **descartado**; número válido tem o score elevado a 1.0.

> **ORGANIZATION fica de fora** do mascaramento de propósito — esconder a razão
> social atrapalharia a própria extração de CNPJ. É um ajuste de política, não
> uma limitação.

## Como funciona o mascaramento

- `mode: pre_call` → roda **antes** da chamada, no texto de entrada.
- `default_on: true` → aplica em **todo** request que passa pelo gateway.
- `output_parse_pii: true` → **re-hidrata** os valores na resposta: o usuário vê
  o dado real, mas o **log fica mascarado**.

Exemplo (entrada → o que o LLM recebe):

```
"O CPF do titular é 111.444.777-35 e o e-mail joao@acme.com"
→ "O CPF do titular é <BR_CPF> e o e-mail <EMAIL_ADDRESS>"
```

### Trade-off que você precisa saber

Se o objetivo do request for **extrair o próprio CPF**, o LLM recebe `<BR_CPF>` e
devolve `<BR_CPF>` — que o `output_parse_pii` remapeia para o valor real. Funciona
para *pass-through*. Mas o modelo **não consegue raciocinar** sobre o número (ex.:
validar, comparar) porque não o enxerga. É o comportamento correto para LGPD; se
algum fluxo precisar do dado em claro, desligue o guardrail **só** para ele.

## Rodar

```bash
# sobe analyzer (build) + anonymizer (oficial) + litellm + db
docker compose -f litellm/docker-compose.yml up -d --build

# saúde do analyzer custom:
docker exec presidio-analyzer python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:3000/health').read())"
```

### Testar o analyzer isolado

```bash
docker exec presidio-analyzer python -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:3000/analyze',
  data=json.dumps({'text':'CPF 111.444.777-35, CNPJ 11.222.333/0001-81','language':'pt'}).encode(),
  headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req).read().decode())"
```

### Testar o mascaramento ponta-a-ponta (via LiteLLM)

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"lite-gpt-4o-mini","messages":[
        {"role":"user","content":"Repita: CPF 111.444.777-35 e e-mail joao@acme.com"}]}'
# o modelo recebe <BR_CPF>/<EMAIL_ADDRESS>; com output_parse_pii, a resposta
# re-hidrata os valores originais.
```

## Ajustes

- **Entidades e ação (MASK/BLOCK)**: `guardrails:` no `litellm/config.yaml`.
- **Novos recognizers BR** (RG, título de eleitor, chave PIX): `analyzer/br_recognizers.py`.
- **Thresholds de score**: `presidio_score_thresholds` no `config.yaml`.
- **Modelo spaCy** (trocar `lg`→`md` p/ build mais leve): build-arg `SPACY_MODEL`.

## Onde este guardrail se encaixa

Este README cobre a **camada de PII (Presidio)**. As Fases 2/3 do desenho já
estão ligadas no `litellm/config.yaml` e documentadas em
[`../README.md`](../README.md#guardrails-de-piilgpd-o-stack-completo):
**secret detection**, **prompt injection**, **moderação de saída** e **log
mascarado**. Todos OSS, todos no mesmo gateway.

## Limitações conhecidas (roadmap)

- ⚠️ **O guardrail atua no TEXTO, não no anexo.** PDF/imagem viajam em base64,
  que o Presidio não lê (não faz OCR). Se você mandar o **documento** a um modelo
  de visão, a PII de dentro dele vai **sem máscara**. Fluxo LGPD-seguro: **OCR
  local → mascara o texto → envia texto**; se precisar de visão, redija a imagem
  antes (`presidio-image-redactor`) ou roteie p/ modelo in-country.
- **Residência de dado:** os modelos `oci-*` do gateway já rodam em
  **`sa-saopaulo-1`** (Brasil). Para dado sensível, roteie o request para um alias
  `oci-*` em vez de OpenAI (EUA) — evita transferência internacional (Art. 33).
  A seleção de rota mora no proxy/`server`, não no browser (ver por-modelo em `../README.md`).
- `BR_CNH`, `BR_CNS` e título de eleitor ainda **sem checksum** (padrão+contexto).
- **CNPJ alfanumérico** (vigente jul/2026): valida o formato numérico clássico;
  o alfanumérico é o próximo hardening.
- Guardrail cobre **só o tráfego que passa pelo LiteLLM**. OCI-compat e OpenAI
  chamados direto pelo proxy Node não passam por aqui (ver "unificar no LiteLLM").
