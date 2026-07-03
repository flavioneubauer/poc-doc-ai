import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import OpenAI from 'openai';

/*
 * Proxy mínimo entre o frontend Angular e a OpenAI, com guardrail CleanPredict.
 *
 * IMPORTANTE: o CleanPredict NÃO é um proxy de LLM. Ele é um middleware de
 * segurança/observabilidade que roda AO LADO da chamada ao modelo (ver doc,
 * cap. 5.3). O fluxo de cada análise é:
 *
 *   1) evaluate (pré)  -> CleanPredict diz se o prompt pode ir para o LLM
 *   2) se liberado     -> chamamos a OpenAI DIRETAMENTE (lib `openai`)
 *   3) evaluate (pós)  -> reenviamos com os tokens reais p/ popular métricas
 *
 * Este backend existe para manter as DUAS chaves (OpenAI e CleanPredict) fora
 * do navegador. O frontend só fala com este proxy (localhost).
 */

const {
  // Provedor default: qual modelo já vem selecionado no combo do frontend.
  LLM_PROVIDER = 'openai',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  OPENAI_MODELS, // opcional: lista CSV; se vazio, usa OPENAI_MODEL
  // OCI Generative AI (endpoint compatível com OpenAI). Ver task-example.py.
  OCI_GENAI_API_KEY,
  OCI_COMPARTMENT_ID,
  OCI_REGION = 'sa-saopaulo-1',
  // Modelos que respondem no modo compat em sa-saopaulo-1 (sondados). Ajuste por região.
  OCI_MODELS = 'meta.llama-3.3-70b-instruct,meta.llama-3.2-90b-vision-instruct',
  // LiteLLM gateway (container). É OpenAI-compatible; via OCI nativo alcança
  // Cohere/embeddings (que o compat da OCI não entrega). Ver litellm/.
  LITELLM_BASE_URL, // ex.: http://localhost:4000/v1
  LITELLM_MASTER_KEY,
  LITELLM_MODELS = 'oci-llama-3.3-70b,oci-llama-3.2-90b-vision,oci-cohere-command',
  CLEANPREDICT_API_KEY,
  CLEANPREDICT_BASE_URL = 'https://api.cleanpredict.com/api/v1',
  CLEANPREDICT_WORKSPACE_SLUG,
  PORT = 3001,
  ALLOWED_ORIGIN = 'http://localhost:4200',
} = process.env;

const csv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Um client `openai` por provedor COM credencial. Nos dois casos é a mesma lib;
// a OCI só muda base_url, a chave (bearer) e o header opc-compartment-id.
const clients = {};
if (OPENAI_API_KEY) clients.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
if (OCI_GENAI_API_KEY && OCI_COMPARTMENT_ID) {
  clients.oci = new OpenAI({
    apiKey: OCI_GENAI_API_KEY,
    baseURL: `https://inference.generativeai.${OCI_REGION}.oci.oraclecloud.com/openai/v1`,
    defaultHeaders: { 'opc-compartment-id': OCI_COMPARTMENT_ID },
  });
}
// O LiteLLM já é OpenAI-compatible: só base_url + a master key como bearer.
if (LITELLM_BASE_URL && LITELLM_MASTER_KEY) {
  clients.litellm = new OpenAI({ baseURL: LITELLM_BASE_URL, apiKey: LITELLM_MASTER_KEY });
}

// Registro dos modelos oferecidos ao frontend (só entra o provedor configurado).
// `vision` marca quem aceita imagem — habilita o "Enviar arquivo à IA".
const MODELS = [];
const addOci = () => {
  if (!clients.oci) return;
  // stream:false — no modo compat da OCI, prompts que pedem JSON encerram como
  // "tool_calls" e o conteúdo NÃO vem nos deltas do stream (resposta vazia).
  // A chamada não-streaming traz o texto normalmente em message.content.
  for (const id of csv(OCI_MODELS))
    MODELS.push({ id, provider: 'oci', label: `OCI · ${id}`, vision: /vision/i.test(id), pdf: false, stream: false });
};
const addOpenai = () => {
  if (!clients.openai) return;
  const ids = csv(OPENAI_MODELS).length ? csv(OPENAI_MODELS) : [OPENAI_MODEL];
  for (const id of ids)
    MODELS.push({ id, provider: 'openai', label: `OpenAI · ${id}`, vision: /gpt-4o|gpt-4\.1|vision/i.test(id), pdf: /gpt-4o|gpt-4\.1/i.test(id), stream: true });
};
const addLitellm = () => {
  if (!clients.litellm) return;
  // stream:false — os modelos OCI atrás do LiteLLM também mandam JSON como
  // "tool_calls" no stream (conteúdo vazio); a chamada não-streaming traz o texto.
  for (const id of csv(LITELLM_MODELS))
    MODELS.push({ id, provider: 'litellm', label: `LiteLLM · ${id}`, vision: /vision|gpt-4o|gpt-4\.1/i.test(id), pdf: /gpt-4o|gpt-4\.1/i.test(id), stream: false });
};
// O provedor default (LLM_PROVIDER) aparece primeiro no combo; depois o resto.
const adders = { openai: addOpenai, oci: addOci, litellm: addLitellm };
for (const p of [LLM_PROVIDER, ...Object.keys(adders).filter((x) => x !== LLM_PROVIDER)]) adders[p]?.();

if (!MODELS.length) {
  console.error('[proxy] Nenhum provedor configurado. Preencha OPENAI_API_KEY, OCI_GENAI_API_KEY+OCI_COMPARTMENT_ID, ou LITELLM_BASE_URL+LITELLM_MASTER_KEY no .env.');
  process.exit(1);
}

const byId = new Map(MODELS.map((m) => [m.id, m]));
const DEFAULT_MODEL = MODELS[0].id;

// O CleanPredict é OPCIONAL: só liga se as duas envs estiverem presentes.
// Sem elas, o proxy vai direto ao LLM (útil para testar os modelos da OCI).
const guardrailOn = !!(CLEANPREDICT_API_KEY && CLEANPREDICT_WORKSPACE_SLUG);

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, models: MODELS.map((m) => m.id), default: DEFAULT_MODEL, guardrail: guardrailOn ? 'cleanpredict' : 'off' }),
);

// Lista os modelos disponíveis para o combo do frontend.
app.get('/api/models', (_req, res) => res.json({ models: MODELS, default: DEFAULT_MODEL }));

/**
 * Chama o guardrail do CleanPredict. Sem `usage` é a avaliação PRÉ-LLM (decide
 * se pode chamar o modelo); com `usage` é a PÓS-LLM (popula métricas de custo,
 * higiene e energia com os tokens reais).
 */
async function cleanpredictEvaluate(question, modelName, usage) {
  const payload = {
    route_key: 'chat/completions',
    question,
    workspace_slug: CLEANPREDICT_WORKSPACE_SLUG,
    // A OCI é chamada pelo caminho compatível com OpenAI, então reportamos
    // 'openai' como provider para o guardrail e o id real do modelo.
    model_provider: 'openai',
    model_name: modelName,
    metadata: { source: 'poc-doc-ai-local', model: modelName },
  };
  if (usage) {
    payload.cached_tokens = usage.cached_tokens ?? 0;
    payload.uncached_tokens = usage.uncached_tokens ?? 0;
    payload.output_tokens = usage.output_tokens ?? 0;
    payload.message_count = usage.message_count ?? 1;
  }

  const resp = await fetch(`${CLEANPREDICT_BASE_URL}/guardrail/evaluate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLEANPREDICT_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`CleanPredict retornou ${resp.status}. ${detalhe}`);
  }
  return resp.json();
}

/*
 * Recebe { messages, temperature, max_tokens } no mesmo formato que o frontend
 * já montava. Faz o fluxo guardrail -> OpenAI -> guardrail e devolve o texto
 * em streaming (text/plain). Se o CleanPredict bloquear, devolve JSON com a
 * decisão (e NÃO chama a OpenAI).
 */
app.post('/api/analyze', async (req, res) => {
  const {
    messages,
    temperature = 0.3,
    max_tokens = 700,
    file,
    model: modelReq,
    question: questionOverride,
  } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Campo "messages" (array) é obrigatório.' });
  }

  // Resolve o modelo pedido pelo frontend (combo). Desconhecido -> default.
  const model = byId.has(modelReq) ? modelReq : DEFAULT_MODEL;
  if (modelReq && !byId.has(modelReq)) {
    console.warn(`[proxy] modelo "${modelReq}" não registrado; usando ${DEFAULT_MODEL}.`);
  }
  const meta = byId.get(model);
  const client = clients[meta.provider];

  // O CleanPredict só avalia TEXTO (não recebe arquivo). Por padrão usamos a
  // última mensagem `user`; mas no modo arquivo o frontend manda `question`
  // com o TEXTO do documento (OCR), para o guardrail poder avaliar o conteúdo.
  // Obs.: o que o OCR NÃO capturar (ex.: texto oculto no PDF) o guardrail não vê.
  const idxUser = messages.map((m) => m.role).lastIndexOf('user');
  const question =
    (questionOverride && String(questionOverride).trim()) ||
    (idxUser >= 0 ? messages[idxUser].content : '') ||
    '';

  // Anexa o arquivo (PDF/imagem) à última mensagem do usuário, se enviado.
  let finalMessages = messages;
  if (file?.dataUrl && idxUser >= 0) {
    const isPdf = file.dataUrl.startsWith('data:application/pdf');
    const parte = isPdf
      ? { type: 'file', file: { filename: file.filename || 'documento.pdf', file_data: file.dataUrl } }
      : { type: 'image_url', image_url: { url: file.dataUrl } };
    finalMessages = messages.map((m, i) =>
      i === idxUser
        ? { ...m, content: [{ type: 'text', text: String(m.content ?? '') }, parte] }
        : m,
    );
  }

  try {
    // 1) Avaliação PRÉ-LLM (só se o guardrail estiver ligado).
    if (guardrailOn) {
      const decision = await cleanpredictEvaluate(question, model);
      console.info('[proxy] decisão CleanPredict:', decision.decision, '| allow:', decision.allowed_to_call_llm);

      if (!decision.allowed_to_call_llm) {
        // Bloqueado: responde JSON (o frontend detecta pelo content-type).
        return res.status(200).json({
          blocked: true,
          decision: {
            decision: decision.decision,
            reason_codes: decision.reason_codes,
            alignment_score: decision.alignment_score,
            primary_intent: decision.primary_intent,
          },
        });
      }
    }

    // 2) Liberado: chama o modelo. A resposta sai sempre como text/plain.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    let usage = null;
    if (meta.stream) {
      // Streaming (OpenAI): tokens ao vivo. `include_usage` só quando o guardrail
      // precisa dos tokens reais no passo pós-LLM.
      const stream = await client.chat.completions.create({
        model,
        temperature,
        max_tokens,
        stream: true,
        ...(guardrailOn ? { stream_options: { include_usage: true } } : {}),
        messages: finalMessages,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (delta) res.write(delta);
        if (chunk.usage) usage = chunk.usage;
      }
    } else {
      // Não-streaming (OCI): evita o bug de resposta vazia com prompts JSON.
      // O texto vem inteiro em message.content e a usage direto na resposta.
      const resp = await client.chat.completions.create({
        model,
        temperature,
        max_tokens,
        messages: finalMessages,
      });
      res.write(resp.choices?.[0]?.message?.content ?? '');
      usage = resp.usage ?? null;
    }
    res.end();

    // 3) Avaliação PÓS-LLM com tokens reais (não bloqueia a resposta ao cliente).
    if (guardrailOn && usage) {
      cleanpredictEvaluate(question, model, {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        uncached_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        message_count: messages.length,
      }).catch((e) => console.error('[proxy] evaluate pós-LLM falhou:', e.message));
    }
  } catch (e) {
    console.error('[proxy] erro:', e);
    if (res.headersSent) return res.end();
    res.status(502).json({ error: e?.message ?? 'Falha no proxy.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] rodando em http://0.0.0.0:${PORT}`);
  console.log(`[proxy] modelos: ${MODELS.map((m) => m.id).join(', ')}`);
  console.log(`[proxy] default: ${DEFAULT_MODEL} | guardrail: ${guardrailOn ? 'CleanPredict' : 'desligado'} | origem: ${ALLOWED_ORIGIN}`);
});
