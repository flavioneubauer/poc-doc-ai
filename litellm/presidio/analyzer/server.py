"""Presidio Analyzer custom — pt-BR + recognizers brasileiros.

Sobe um AnalyzerEngine configurado para português (spaCy pt_core_news_lg, com
mapeamento dos labels do NER PT → entidades Presidio) e registra os recognizers
brasileiros de `br_recognizers`. Expõe o mesmo contrato REST do Presidio oficial
(`/analyze`, `/health`) que o LiteLLM consome via PRESIDIO_ANALYZER_API_BASE.

O anonymizer NÃO é customizado — usa a imagem oficial (mascaramento é agnóstico
de idioma; só precisa das posições que este analyzer devolve).
"""

import os

from flask import Flask, jsonify, request
from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import (
    CreditCardRecognizer,
    EmailRecognizer,
    IpRecognizer,
    PhoneRecognizer,
    SpacyRecognizer,
)

import br_recognizers

LANG = "pt"
SPACY_MODEL = os.getenv("SPACY_MODEL", "pt_core_news_lg")

# spaCy pt usa labels CoNLL (PER/LOC/ORG/MISC); o Presidio espera PERSON/LOCATION/…
# → mapeamos aqui, senão o NER não vira entidade nenhuma.
_nlp_conf = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": LANG, "model_name": SPACY_MODEL}],
    "ner_model_configuration": {
        "model_to_presidio_entity_mapping": {
            "PER": "PERSON",
            "PERSON": "PERSON",
            "LOC": "LOCATION",
            "GPE": "LOCATION",
            "LOCATION": "LOCATION",
            "ORG": "ORGANIZATION",
            "ORGANIZATION": "ORGANIZATION",
            "MISC": "MISC",
        },
        "labels_to_ignore": ["MISC"],
    },
}
_nlp_engine = NlpEngineProvider(nlp_configuration=_nlp_conf).create_engine()

_registry = RecognizerRegistry()
_registry.supported_languages = [LANG]  # senão nasce ['en'] e briga com o engine pt
# Built-ins agnósticos de idioma, registrados para pt.
_registry.add_recognizer(CreditCardRecognizer(supported_language=LANG))
_registry.add_recognizer(EmailRecognizer(supported_language=LANG))
_registry.add_recognizer(IpRecognizer(supported_language=LANG))
_registry.add_recognizer(
    PhoneRecognizer(
        supported_language=LANG,
        supported_regions=["BR"],
        context=["telefone", "celular", "tel", "fone", "whatsapp", "contato"],
    )
)
# NER (PERSON/LOCATION/ORGANIZATION) a partir do spaCy pt.
_registry.add_recognizer(SpacyRecognizer(supported_language=LANG))
# Recognizers brasileiros (CPF/CNPJ/PIS com DV; CNH/CNS/CEP/placa por contexto).
for rec in br_recognizers.all_recognizers():
    _registry.add_recognizer(rec)

analyzer = AnalyzerEngine(
    registry=_registry,
    nlp_engine=_nlp_engine,
    supported_languages=[LANG],
)

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "language": LANG, "model": SPACY_MODEL})


@app.post("/analyze")
def analyze():
    payload = request.get_json(force=True) or {}
    text = payload.get("text", "")
    language = payload.get("language") or LANG
    entities = payload.get("entities") or None
    score_threshold = payload.get("score_threshold")

    # Só pede o que este analyzer sabe produzir — evita ValueError se o LiteLLM
    # mandar uma entidade fora da nossa lista.
    if entities:
        supported = set(analyzer.get_supported_entities(language=language))
        entities = [e for e in entities if e in supported] or None

    results = analyzer.analyze(
        text=text,
        language=language,
        entities=entities,
        score_threshold=score_threshold,
        return_decision_process=False,
    )
    # Mesmo formato do Presidio oficial: lista de RecognizerResult serializados.
    return jsonify([r.to_dict() for r in results])
