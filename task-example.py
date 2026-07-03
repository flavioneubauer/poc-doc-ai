"""
Exemplos de uso da OCI Generative AI pelo endpoint compatível com OpenAI.

Pré-requisitos:
    pip install openai

    export OCI_GENAI_API_KEY="sua-chave-generative-ai"
    export OCI_COMPARTMENT_ID="ocid1.compartment.oc1..xxxx"   # o do compartment GenerativeAI

Rode um exemplo por vez chamando a função no final do arquivo, ou
descomente o bloco do __main__.
"""

import os
import json
from openai import OpenAI

REGION = "sa-saopaulo-1"
MODEL = "meta.llama-3.3-70b-instruct"   # troque pelo id que você quer usar
# Preencha via ambiente (export OCI_GENAI_API_KEY=... / OCI_COMPARTMENT_ID=...).
OCI_GENAI_API_KEY = os.environ.get("OCI_GENAI_API_KEY", "sk-...")
OCI_COMPARTMENT_ID = os.environ.get("OCI_COMPARTMENT_ID", "ocid1.compartment.oc1..xxxx")

client = OpenAI(
    base_url=f"https://inference.generativeai.{REGION}.oci.oraclecloud.com/openai/v1",
    api_key=os.environ["OCI_GENAI_API_KEY"],
    default_headers={"opc-compartment-id": os.environ["OCI_COMPARTMENT_ID"]},
)


# ---------------------------------------------------------------------------
# 1. Chat básico
# ---------------------------------------------------------------------------
def chat_basico():
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "Explique o que é a OCI (Oracle) em uma frase."}],
    )
    print(resp.choices[0].message.content)
    # uso de tokens, útil pra acompanhar custo
    print(resp.usage)


# ---------------------------------------------------------------------------
# 2. System prompt + parâmetros (temperature, max_tokens, top_p)
# ---------------------------------------------------------------------------
def com_parametros():
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Você responde sempre de forma curta e técnica, em português."},
            {"role": "user", "content": "O que é um compartment na OCI?"},
        ],
        temperature=0.2,
        max_tokens=200,
        top_p=0.9,
    )
    print(resp.choices[0].message.content)


# ---------------------------------------------------------------------------
# 3. Streaming (resposta token a token)
# ---------------------------------------------------------------------------
def streaming():
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "Escreva um parágrafo sobre cloud computing."}],
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            print(delta, end="", flush=True)
    print()


# ---------------------------------------------------------------------------
# 4. Conversa multi-turno (mantendo histórico)
# ---------------------------------------------------------------------------
def conversa():
    historico = [
        {"role": "system", "content": "Você é um assistente prestativo."},
    ]

    def perguntar(texto):
        historico.append({"role": "user", "content": texto})
        resp = client.chat.completions.create(model=MODEL, messages=historico)
        resposta = resp.choices[0].message.content
        historico.append({"role": "assistant", "content": resposta})
        return resposta

    print(perguntar("Meu nome é André."))
    print(perguntar("Qual é o meu nome?"))   # ele lembra porque o histórico vai junto


# ---------------------------------------------------------------------------
# 5. Saída estruturada em JSON (parsing confiável)
# ---------------------------------------------------------------------------
def saida_json():
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "system",
                "content": "Responda APENAS com JSON válido, sem texto extra nem ```.",
            },
            {
                "role": "user",
                "content": "Extraia nome e cidade de: 'André mora em Brasília'. "
                           "Use as chaves 'nome' e 'cidade'.",
            },
        ],
        temperature=0,
    )
    bruto = resp.choices[0].message.content
    dados = json.loads(bruto)
    print(dados["nome"], "-", dados["cidade"])


# ---------------------------------------------------------------------------
# 6. Tool / function calling
# ---------------------------------------------------------------------------
def tool_calling():
    tools = [
        {
            "type": "function",
            "function": {
                "name": "consultar_clima",
                "description": "Retorna o clima atual de uma cidade",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cidade": {"type": "string", "description": "Nome da cidade"},
                    },
                    "required": ["cidade"],
                },
            },
        }
    ]

    mensagens = [{"role": "user", "content": "Como está o clima em São Paulo?"}]

    resp = client.chat.completions.create(model=MODEL, messages=mensagens, tools=tools)
    msg = resp.choices[0].message

    if msg.tool_calls:
        chamada = msg.tool_calls[0]
        args = json.loads(chamada.function.arguments)
        print("Modelo pediu:", chamada.function.name, args)

        # aqui você executaria a função de verdade; vamos simular:
        resultado = json.dumps({"cidade": args["cidade"], "temp_c": 27})

        # devolve o resultado pro modelo concluir a resposta
        mensagens.append(msg)
        mensagens.append({
            "role": "tool",
            "tool_call_id": chamada.id,
            "content": resultado,
        })
        final = client.chat.completions.create(model=MODEL, messages=mensagens, tools=tools)
        print(final.choices[0].message.content)
    else:
        print(msg.content)


# ---------------------------------------------------------------------------
# 7. Embeddings  (ATENÇÃO: testar suporte na sua região)
# ---------------------------------------------------------------------------
# A exposição de /embeddings pelo endpoint compatível com OpenAI varia.
# Se der erro de path/404, use o SDK nativo da OCI (oci.generative_ai_inference)
# com um modelo de embedding como "cohere.embed-v4.0" / "cohere.embed-multilingual-v3.0".
def embeddings():
    resp = client.embeddings.create(
        model="cohere.embed-multilingual-v3.0",
        input=["primeiro texto", "segundo texto"],
    )
    for item in resp.data:
        print(len(item.embedding), "dimensões")


# ---------------------------------------------------------------------------
# 8. Responses API (necessária para alguns modelos de reasoning)
# ---------------------------------------------------------------------------
# Modelos só-Responses (ex.: alguns de reasoning) NÃO respondem via chat.completions.
def responses_api():
    resp = client.responses.create(
        model="openai.gpt-oss-120b",   # exemplo; confirme disponibilidade na região
        input="Escreva uma frase sobre unicórnios.",
    )
    print(resp.output_text)


if __name__ == "__main__":
    chat_basico()
    # com_parametros()
    # streaming()
    # conversa()
    # saida_json()
    # tool_calling()
    # embeddings()
    # responses_api()


