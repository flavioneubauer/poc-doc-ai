# Presidio Analyzer custom: pt-BR + recognizers brasileiros (CPF/CNPJ/PIS c/ DV).
# O anonymizer NÃO é buildado aqui — usamos a imagem oficial no docker-compose.
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Modelo spaCy em português (NER: PERSON/LOCATION/ORGANIZATION). ~560MB no lg.
ARG SPACY_MODEL=pt_core_news_lg
ENV SPACY_MODEL=${SPACY_MODEL}
RUN python -m spacy download ${SPACY_MODEL}

COPY br_recognizers.py server.py ./

EXPOSE 3000
# 1 worker: o engine (spaCy) é carregado uma vez no --preload. Timeout alto p/ o
# 1º request, que dispara a inicialização preguiçosa de alguns recognizers.
CMD ["gunicorn", "-b", "0.0.0.0:3000", "-w", "1", "-t", "180", "--preload", "server:app"]
