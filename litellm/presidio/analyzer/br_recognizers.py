"""Recognizers brasileiros para o Presidio Analyzer.

Cada identificador com dígito verificador (CPF, CNPJ, PIS/PASEP/NIT) é validado
por checksum em `validate_result`: quando o número é válido, o Presidio eleva o
score para 1.0; quando é inválido, DESCARTA o match. É a mesma ideia que a
`extraction.service.ts` do front usa para o CNPJ — valida o DV para não mascarar
sequências de dígitos que só *parecem* um documento (mata falso-positivo).

Identificadores sem checksum universal (CNH, CNS, CEP, placa) entram por
padrão + palavras de contexto, com score baixo que só cruza o threshold quando
há contexto por perto (ex.: a palavra "CNH" ao lado do número).
"""

import re

from presidio_analyzer import Pattern, PatternRecognizer

LANG = "pt"


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def _all_same(digits: str) -> bool:
    return len(set(digits)) == 1


# --------------------------------------------------------------------------- #
# Validadores de dígito verificador
# --------------------------------------------------------------------------- #
def validate_cpf(text: str):
    cpf = _digits(text)
    if len(cpf) != 11 or _all_same(cpf):
        return False
    n = [int(c) for c in cpf]
    d1 = (sum(n[i] * (10 - i) for i in range(9)) * 10) % 11 % 10
    if d1 != n[9]:
        return False
    d2 = (sum(n[i] * (11 - i) for i in range(10)) * 10) % 11 % 10
    return d2 == n[10]


def validate_cnpj(text: str):
    cnpj = _digits(text)
    if len(cnpj) != 14 or _all_same(cnpj):
        return False
    n = [int(c) for c in cnpj]
    w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    r = sum(n[i] * w1[i] for i in range(12)) % 11
    d1 = 0 if r < 2 else 11 - r
    if d1 != n[12]:
        return False
    w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    r = sum(n[i] * w2[i] for i in range(13)) % 11
    d2 = 0 if r < 2 else 11 - r
    return d2 == n[13]


def validate_pis(text: str):
    pis = _digits(text)
    if len(pis) != 11 or _all_same(pis):
        return False
    n = [int(c) for c in pis]
    w = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    r = sum(n[i] * w[i] for i in range(10)) % 11
    d = 0 if r < 2 else 11 - r
    return d == n[10]


# --------------------------------------------------------------------------- #
# Recognizers com checksum (DV)
# --------------------------------------------------------------------------- #
class CpfRecognizer(PatternRecognizer):
    def __init__(self):
        patterns = [
            Pattern("CPF (formatado)", r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b", 0.6),
            Pattern("CPF (11 dígitos)", r"\b\d{11}\b", 0.3),
        ]
        context = ["cpf", "c.p.f", "cadastro de pessoa", "contribuinte"]
        super().__init__(
            supported_entity="BR_CPF", patterns=patterns,
            context=context, supported_language=LANG,
        )

    def validate_result(self, pattern_text: str):
        return validate_cpf(pattern_text)


class CnpjRecognizer(PatternRecognizer):
    def __init__(self):
        patterns = [
            Pattern("CNPJ (formatado)", r"\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b", 0.6),
            Pattern("CNPJ (14 dígitos)", r"\b\d{14}\b", 0.3),
        ]
        context = ["cnpj", "c.n.p.j", "inscrição", "razão social", "matriz", "filial"]
        super().__init__(
            supported_entity="BR_CNPJ", patterns=patterns,
            context=context, supported_language=LANG,
        )

    def validate_result(self, pattern_text: str):
        return validate_cnpj(pattern_text)


class PisRecognizer(PatternRecognizer):
    def __init__(self):
        patterns = [
            Pattern("PIS (formatado)", r"\b\d{3}\.\d{5}\.\d{2}-\d{1}\b", 0.6),
            Pattern("PIS (11 dígitos)", r"\b\d{11}\b", 0.3),
        ]
        context = ["pis", "pasep", "nit", "nis", "inss"]
        super().__init__(
            supported_entity="BR_PIS", patterns=patterns,
            context=context, supported_language=LANG,
        )

    def validate_result(self, pattern_text: str):
        return validate_pis(pattern_text)


# --------------------------------------------------------------------------- #
# Recognizers por padrão + contexto (sem checksum universal)
# --------------------------------------------------------------------------- #
class CnhRecognizer(PatternRecognizer):
    # CNH tem 11 dígitos; sem DV universal barato aqui → depende do contexto.
    def __init__(self):
        patterns = [Pattern("CNH (11 dígitos)", r"\b\d{11}\b", 0.3)]
        context = ["cnh", "habilitação", "carteira de motorista", "registro", "detran"]
        super().__init__(
            supported_entity="BR_CNH", patterns=patterns,
            context=context, supported_language=LANG,
        )


class CnsRecognizer(PatternRecognizer):
    # Cartão Nacional de Saúde: 15 dígitos iniciando em 1,2,7,8 ou 9.
    def __init__(self):
        patterns = [Pattern("CNS (15 dígitos)", r"\b[1-2789]\d{2}[\s.]?\d{4}[\s.]?\d{4}[\s.]?\d{4}\b", 0.4)]
        context = ["cns", "cartão nacional de saúde", "cartão do sus", "sus"]
        super().__init__(
            supported_entity="BR_CNS", patterns=patterns,
            context=context, supported_language=LANG,
        )


class CepRecognizer(PatternRecognizer):
    def __init__(self):
        patterns = [Pattern("CEP", r"\b\d{5}-?\d{3}\b", 0.3)]
        context = ["cep", "endereço", "logradouro", "rua", "avenida", "bairro"]
        super().__init__(
            supported_entity="BR_CEP", patterns=patterns,
            context=context, supported_language=LANG,
        )


class PlacaRecognizer(PatternRecognizer):
    def __init__(self):
        patterns = [
            Pattern("Placa Mercosul", r"\b[A-Z]{3}\d[A-Z]\d{2}\b", 0.5),
            Pattern("Placa antiga", r"\b[A-Z]{3}-?\d{4}\b", 0.4),
        ]
        context = ["placa", "veículo", "automóvel", "carro", "moto", "renavam"]
        super().__init__(
            supported_entity="BR_PLACA", patterns=patterns,
            context=context, supported_language=LANG,
        )


def all_recognizers():
    """Instâncias registradas no analyzer (todas em pt)."""
    return [
        CpfRecognizer(),
        CnpjRecognizer(),
        PisRecognizer(),
        CnhRecognizer(),
        CnsRecognizer(),
        CepRecognizer(),
        PlacaRecognizer(),
    ]
