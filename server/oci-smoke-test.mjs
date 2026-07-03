/*
 * Smoke test do endpoint OpenAI-compatible da OCI Generative AI.
 *
 * Objetivo: provar, fora do app, que a lib `openai` do Node fala com a OCI
 * (chat + streaming). Espelha o task-example.py, mas em Node.
 *
 * Uso:
 *   export OCI_GENAI_API_KEY="sk-..."
 *   export OCI_COMPARTMENT_ID="ocid1.compartment.oc1..xxxx"
 *   export OCI_REGION="sa-saopaulo-1"                       # opcional (default abaixo)
 *   export OCI_MODEL="meta.llama-3.3-70b-instruct"          # opcional (default abaixo)
 *   node oci-smoke-test.mjs
 */

import OpenAI from 'openai';

const {
  OCI_GENAI_API_KEY,
  OCI_COMPARTMENT_ID,
  OCI_REGION = 'sa-saopaulo-1',
  OCI_MODEL = 'meta.llama-3.3-70b-instruct',
} = process.env;

for (const [k, v] of Object.entries({ OCI_GENAI_API_KEY, OCI_COMPARTMENT_ID })) {
  if (!v) {
    console.error(`Falta a env ${k}. Exporte antes de rodar (ver cabeçalho do arquivo).`);
    process.exit(1);
  }
}

const baseURL = `https://inference.generativeai.${OCI_REGION}.oci.oraclecloud.com/openai/v1`;

// Mesma receita do task-example.py: bearer key + compartment no header opc-compartment-id.
const client = new OpenAI({
  apiKey: OCI_GENAI_API_KEY,
  baseURL,
  defaultHeaders: { 'opc-compartment-id': OCI_COMPARTMENT_ID },
});

console.log(`[oci] base_url: ${baseURL}`);
console.log(`[oci] model:    ${OCI_MODEL}\n`);

// 1) Chat básico
console.log('=== 1) chat básico ===');
const resp = await client.chat.completions.create({
  model: OCI_MODEL,
  messages: [{ role: 'user', content: 'Explique o que é a OCI (Oracle) em uma frase, em português.' }],
});
console.log(resp.choices[0]?.message?.content);
console.log('usage:', resp.usage, '\n');

// 2) Streaming
console.log('=== 2) streaming ===');
const stream = await client.chat.completions.create({
  model: OCI_MODEL,
  messages: [{ role: 'user', content: 'Escreva um parágrafo curto sobre cloud computing.' }],
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta?.content ?? '';
  if (delta) process.stdout.write(delta);
}
console.log('\n\n[oci] OK — a OCI respondeu pelos dois modos.');
