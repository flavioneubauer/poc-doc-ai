/* Sonda quais modelos de chat respondem no endpoint OpenAI-compat da OCI
 * na região configurada. models.list() não funciona no modo compat, então
 * testamos cada candidato com uma chamada mínima. */
import OpenAI from 'openai';

const {
  OCI_GENAI_API_KEY,
  OCI_COMPARTMENT_ID,
  OCI_REGION = 'sa-saopaulo-1',
} = process.env;

const client = new OpenAI({
  apiKey: OCI_GENAI_API_KEY,
  baseURL: `https://inference.generativeai.${OCI_REGION}.oci.oraclecloud.com/openai/v1`,
  defaultHeaders: { 'opc-compartment-id': OCI_COMPARTMENT_ID },
});

const candidates = [
  'meta.llama-3.3-70b-instruct',
  'meta.llama-3.2-90b-vision-instruct',
  'meta.llama-3.1-405b-instruct',
  'meta.llama-4-maverick-17b-128e-instruct-fp8',
  'meta.llama-4-scout-17b-16e-instruct',
  'cohere.command-r-plus-08-2024',
  'cohere.command-a-03-2025',
  'xai.grok-3',
  'xai.grok-3-mini',
  'xai.grok-4',
  'openai.gpt-oss-120b',
  'openai.gpt-oss-20b',
];

for (const model of candidates) {
  try {
    const r = await client.chat.completions.create({
      model,
      max_tokens: 3,
      messages: [{ role: 'user', content: 'oi' }],
    });
    console.log(`OK    ${model}  -> "${(r.choices[0]?.message?.content || '').replace(/\n/g, ' ').slice(0, 30)}"`);
  } catch (e) {
    const msg = (e?.status ? `${e.status} ` : '') + (e?.message || String(e)).split('\n')[0].slice(0, 90);
    console.log(`FAIL  ${model}  -> ${msg}`);
  }
}
