# POC — Doc AI Local 🔒

Prova de conceito em **Angular 20 (standalone)** que demonstra **processamento de
documentos 100% no navegador**, sem backend e **sem enviar nenhum dado para APIs
externas**.

O usuário faz upload de um **PDF, JPG ou PNG**; a aplicação renderiza o
documento, **pré-processa a imagem** (para melhorar a leitura), executa **OCR
local em português** (tesseract.js) e aplica heurísticas para **extrair dados
estruturados** (CNPJ, razão social, datas, validade, tipo e status).

Para casos difíceis há robustez extra, tudo local: **binarização Otsu** antes do
OCR, um **2º passe de OCR** que recupera o CNPJ quando o layout embaralha o
número, e **validação dos dígitos verificadores** do CNPJ. Veja
[Robustez de OCR](#-robustez-de-ocr-como-lidamos-com-imagem-ruim).

```
┌────────────────────┬────────────────────┬────────────────────┐
│ Documento Original │     Texto OCR      │  Dados Estruturados │
│ (imagem ou canvas) │ (texto bruto + %)  │  (tabela + JSON)    │
└────────────────────┴────────────────────┴────────────────────┘
```

---

## ✅ Garantias de privacidade

- O **conteúdo do documento nunca sai do navegador**. Não há `HttpClient`, não
  há upload, não há servidor.
- O PDF é processado por **pdf.js** num **web worker local** (copiado de
  `node_modules` para `/assets` na build — sem CDN).
- O OCR roda em **WebAssembly no próprio navegador**.

> **Nota honesta sobre o tesseract.js:** na _primeira_ execução, o tesseract.js
> baixa **uma única vez** (e depois usa o cache do navegador) o _core_ WASM e o
> modelo de idioma `por.traineddata`. Esse download é apenas de **arquivos
> estáticos do motor open-source** — **nenhum dado do seu documento trafega**.
> Para um cenário **100% offline**, veja [Modo totalmente offline](#-modo-totalmente-offline-opcional).

---

## 🚀 Como executar

### Pré-requisitos

- **Node.js** `^20.19` ou `^22.12` ou `>=24` (exigência do Angular 20)
- **npm** 10+

### Instalação e execução

```bash
# 1) Instalar dependências
npm install

# 2) Subir o servidor de desenvolvimento
npm start
# (atalho para `ng serve`)

# 3) Abrir no navegador
# http://localhost:4200
```

### Build de produção

```bash
npm run build
# saída em dist/poc-doc-ai-local/
```

---

## 🧱 Estrutura do projeto

```
poc-doc-ai-local/
├── angular.json                # build/serve + cópia do worker do pdf.js p/ /assets
├── package.json
├── tsconfig.json / tsconfig.app.json
├── public/                     # assets estáticos (vazio nesta POC)
└── src/
    ├── index.html
    ├── main.ts                 # bootstrapApplication (standalone)
    ├── styles.css              # CSS global, sem frameworks
    └── app/
        ├── app.config.ts       # configuração global (sem router/HttpClient)
        ├── app.component.ts     # layout: header + banners + grid de 3 colunas
        ├── models/
        │   └── document.model.ts        # tipos compartilhados (StructuredData…)
        ├── services/
        │   ├── pdf.service.ts            # pdfjs-dist → renderiza 1ª página em canvas
        │   ├── image.service.ts          # pré-processa imagem (upscale + Otsu) p/ OCR
        │   ├── ocr.service.ts            # tesseract.js → OCR pt-BR (modo auto/sparse)
        │   ├── extraction.service.ts     # heurísticas (CNPJ c/ DV, datas, razão, tipo…)
        │   └── document-processing.service.ts  # FACADE com Signals (orquestra tudo)
        └── components/
            ├── file-upload/              # upload + drag&drop
            ├── document-preview/         # coluna 1 (toggle Original ⇄ Imagem do OCR)
            ├── ocr-panel/                # coluna 2 (progresso + texto)
            └── structured-data/          # coluna 3 (tabela + JSON)
```

### Decisões de arquitetura

- **Standalone components** + `bootstrapApplication` (sem NgModule).
- **Angular Signals** para todo o estado reativo da UI. O
  `DocumentProcessingService` é uma _facade_ que expõe os signals como
  somente-leitura; os componentes apenas **leem** o estado → baixo acoplamento.
- **`ChangeDetectionStrategy.OnPush`** em todos os componentes (combina bem com
  signals).
- Serviços de responsabilidade única: PDF, OCR e Extração são independentes e
  testáveis isoladamente.

---

## 🔍 Como funciona o pipeline

1. **Upload** (`file-upload`): aceita PDF/JPG/PNG (clique ou arrastar-e-soltar) e
   chama `DocumentProcessingService.process(file)`.
2. **Preparo da imagem:**
   - **PDF** → `PdfService` renderiza a **1ª página** num `<canvas>` (escala 2x).
   - **Imagem** → `ImageService` faz **upscale + escala de cinza + binarização
     Otsu** (preto-e-branco nítido, o formato que o Tesseract lê melhor).
3. **OCR (1º passe)** → `OcrService` roda o tesseract.js em **português** (modo
   `auto`), alimentando a **barra de progresso**.
4. **Texto bruto** é exibido na coluna 2.
5. **Extração** → `ExtractionService` aplica regex/heurísticas e devolve o
   objeto `StructuredData`.
6. **OCR (2º passe, condicional)** → se o CNPJ **não** foi encontrado, refaz o
   OCR em modo `sparse` (texto esparso) e tenta recuperar **apenas o número** —
   os demais campos continuam vindo do 1º passe.
7. **Resultado** é exibido como tabela + **JSON formatado** na coluna 3.

> A 1ª coluna tem um **toggle "Original ⇄ Imagem do OCR"** para inspecionar
> exatamente a imagem (pré-processada) que o Tesseract recebe — útil para
> entender por que uma leitura deu certo ou errado.

### Heurísticas de extração

| Campo            | Estratégia                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| **CNPJ**         | Regex tolerante a pontuação faltante/trocada; **corrige confusões de OCR** (`O→0`, `S→5`, `B→8`…) e **valida os dígitos verificadores** (só aceita CNPJ válido). Normaliza para `XX.XXX.XXX/XXXX-XX`. |
| **Datas**        | Detecta `dd/mm/aaaa`, `dd-mm-aaaa`, `dd.mm.aaaa` e `aaaa-mm-dd` → ISO.      |
| **Validade**     | Procura uma data numa janela após "validade/válida até/vencimento/…".      |
| **Razão Social** | Por **rótulo** (Razão Social, Nome Empresarial, Nome ou Razão Social, Denominação…), pulando resíduos de rótulo e linhas de campo/CNPJ; **fallback** por sufixo societário priorizado (LTDA → EIRELI → S/A → … → ME). Limpa artefatos de borda do OCR (`\|`, `[`, `]`). |
| **Tipo**         | `comprovante de inscrição` → **CNPJ**; `certidão` → **Certidão**; `guia da previdência social`/`GPS` → **GPS**; senão **Desconhecido**. |
| **Status**       | sem validade → **Indeterminado**; validade < hoje → **Vencido**; senão **Válido**. |

Exemplo de saída:

```json
{
  "tipoDocumento": "Certidão",
  "cnpj": "12.345.678/0001-90",
  "razaoSocial": "Empresa XPTO Ltda",
  "datas": ["2024-01-10", "2026-12-31"],
  "dataValidade": "2026-12-31",
  "status": "Válido"
}
```

> OCR é ruidoso por natureza. As heurísticas são **propositalmente simples** e
> retornam `null` quando não há confiança — o foco da POC é demonstrar o fluxo
> local, não atingir 100% de acurácia.

---

## 🔍 Robustez de OCR (como lidamos com imagem ruim)

Imagens de documento (foto/scan) costumam derrubar o Tesseract. A POC aplica
três camadas de robustez — **todas 100% locais**:

**1. Pré-processamento da imagem** (`ImageService`)
Antes do OCR, a imagem passa por:
- **upscale** até ~2200px no lado maior (texto maior = OCR melhor);
- **escala de cinza** (luminância Rec. 601);
- **binarização Otsu** — limiar automático que separa "tinta" de "fundo",
  gerando um preto-e-branco nítido (o formato que o Tesseract lê melhor).

**2. 2º passe de OCR em modo `sparse`** (`OcrService` + facade)
Em documentos densos (ex.: cartão CNPJ), a análise de layout automática às vezes
**embaralha a caixa do número de inscrição**. Quando o 1º passe (modo `auto`)
não encontra CNPJ, a aplicação refaz o OCR em **modo `sparse` (PSM 11 — texto
esparso)**, que ignora o layout e costuma recuperar o número isolado.
É **condicional**: só roda quando o CNPJ está faltando, e dali aproveita
**apenas o número**.

**3. CNPJ resiliente** (`ExtractionService`)
- normaliza confusões clássicas de OCR (`O→0`, `I→1`, `S→5`, `B→8`, `G→6`…);
- **valida os dígitos verificadores** (módulo 11) — só aceita CNPJ válido, o que
  torna a correção agressiva **segura** (não inventa número).

> 🔎 **Dica de debug:** o toggle **"Imagem do OCR"** na 1ª coluna mostra a imagem
> binarizada de fato enviada ao Tesseract. Se o campo estiver ilegível ali,
> o problema é a imagem de origem — não a extração.

**Quando nada disso basta.** Se o Tesseract destruir mesmo a região (texto vira
ruído), os próximos passos **ainda locais** seriam: **recorte da região** de
interesse + OCR de linha única, ou **limiar adaptativo (Sauvola)** no lugar do
Otsu para fotos com iluminação desigual. Além disso, um modelo de visão/LLM
resolveria — mas isso é a etapa externa descrita em
[Como evoluir](#-como-evoluir-esta-poc).

---

## 🛡️ Modo totalmente offline (opcional)

Para eliminar até o download dos arquivos do motor de OCR:

1. Copie os arquivos do tesseract.js para `public/tesseract/`:
   - `tesseract-core.wasm.js` (de `node_modules/tesseract.js-core`)
   - `worker.min.js` (de `node_modules/tesseract.js/dist`)
   - `por.traineddata.gz` (baixe do repositório `tessdata` e versione localmente)
2. Aponte os caminhos no `OcrService`:

```ts
const worker = await createWorker('por', OEM.LSTM_ONLY, {
  logger: (m) => onProgress?.(m.status, m.progress ?? 0),
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/tesseract-core.wasm.js',
  langPath: '/tesseract', // pasta com por.traineddata.gz
});
```

Assim, **nada** é buscado fora da aplicação.

---

## 🧭 Como evoluir esta POC

A POC para no OCR + heurísticas. Os próximos passos mantêm o princípio
**"local-first"**, adicionando inteligência sem abrir mão da privacidade.

### 1. Classificação de documentos com Transformers.js

[Transformers.js](https://huggingface.co/docs/transformers.js) roda modelos
Hugging Face em **WASM/WebGPU no navegador**. Em vez das heurísticas de
`detectTipo`, use **classificação zero-shot** ou um modelo de classificação de
texto:

```ts
import { pipeline } from '@huggingface/transformers';

const classifier = await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small');
const out = await classifier(ocrText, ['Certidão', 'Comprovante de CNPJ', 'Contrato', 'Nota Fiscal']);
// → rótulo + score, substituindo as palavras-chave por um modelo de verdade.
```

Os modelos são baixados uma vez e cacheados; o texto continua **no browser**.

### 2. Embeddings locais

Gere **vetores** do texto (ou de cada campo) com um modelo de _sentence
embeddings_ rodando localmente:

```ts
const embedder = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
const vector = await embedder(ocrText, { pooling: 'mean', normalize: true });
// vector: Float32Array — pronto para indexar.
```

### 3. Busca semântica local

Com os embeddings, monte um índice **no próprio navegador** (ex.: vetores em
`IndexedDB`) e busque por **similaridade de cosseno** — permitindo perguntas como
_"mostre documentos vencidos da empresa X"_ sem servidor. Para escala maior,
bibliotecas como `hnswlib-wasm` ou `voy` (Rust/WASM) fazem ANN no cliente.

### 4. Integração futura com LLMs (Claude/GPT) — **somente após o OCR**

Quando fizer sentido enviar dados a um LLM, faça-o de forma **explícita,
controlada e posterior ao OCR**:

- O OCR + extração continuam **locais**; só o **texto já reconhecido** (ou um
  resumo/campos selecionados) é enviado, **com consentimento do usuário**.
- Use o LLM para tarefas que as heurísticas não cobrem: normalização de razão
  social, validação cruzada de campos, perguntas em linguagem natural sobre o
  documento, ou structured output.
- Recomendado: rodar a chamada num **backend próprio** (proxy) que guarda a
  chave de API e aplica _redaction_ (remoção de PII) antes do envio.

Exemplo conceitual com a API da Anthropic (modelo recente: **Claude Opus 4.8**,
id `claude-opus-4-8`), com `tool use` para forçar saída estruturada:

```ts
// Executado em um backend/proxy — NUNCA com a chave no navegador.
const resp = await anthropic.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 1024,
  tools: [
    {
      name: 'registrar_documento',
      description: 'Extrai campos estruturados do documento.',
      input_schema: {
        type: 'object',
        properties: {
          tipoDocumento: { type: 'string' },
          cnpj: { type: 'string' },
          razaoSocial: { type: 'string' },
          dataValidade: { type: 'string' },
        },
      },
    },
  ],
  tool_choice: { type: 'tool', name: 'registrar_documento' },
  messages: [{ role: 'user', content: `Texto OCR:\n${ocrText}` }],
});
```

**Princípio-chave:** local por padrão; LLM externo apenas como **etapa
opcional e posterior**, com o mínimo de dados necessários.

---

## 📦 Dependências principais

| Pacote          | Papel                                        |
| --------------- | -------------------------------------------- |
| `@angular/*` 20 | Framework (standalone + signals)             |
| `pdfjs-dist`    | Renderização de PDF em canvas (web worker)   |
| `tesseract.js`  | OCR em WebAssembly (idioma português)        |

---

## 📝 Licença

POC educacional — use livremente.
