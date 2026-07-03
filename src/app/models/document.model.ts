/**
 * Tipos compartilhados da POC.
 *
 * Mantemos os tipos isolados em um único arquivo para que serviços e
 * componentes dependam apenas do "contrato" de dados, e não uns dos outros.
 */

/** Natureza do arquivo carregado, usada para decidir o pipeline de preview/OCR. */
export type DocKind = 'pdf' | 'image' | null;

/** Classificação heurística do tipo de documento. */
export type TipoDocumento = 'CNPJ' | 'Certidão' | 'GPS' | 'Desconhecido';

/** Situação calculada a partir da data de validade. */
export type StatusDocumento = 'Válido' | 'Vencido' | 'Indeterminado';

/** Veredito da IA sobre a consistência do CNPJ extraído com o documento. */
export type CnpjConfere = 'sim' | 'não' | 'incerto';

/** Status de validação de um campo (documentos pessoais/clínicos). */
export type StatusValidacao = 'valido' | 'invalido' | 'incerto';

/** Avaliação da IA sobre um campo extraído: é válido/coerente? */
export interface ValidacaoCampo {
  /** Nome do campo avaliado (ex.: "CPF", "E-mail"). */
  campo: string;
  /** Valor avaliado. */
  valor: string;
  /** Veredito da IA sobre validade/coerência do valor. */
  status: StatusValidacao;
  /** Justificativa curta. */
  observacao: string;
}

/**
 * Resultado da análise TEXTUAL feita pela IA local. Ela lê o texto do OCR e:
 *  (1) identifica que documento é;
 *  (2) revisa o conteúdo presente;
 *  (3) avalia se o CNPJ extraído faz sentido para o documento.
 * Não emite juízo de "habilitação" (isso é mais confiável por regra).
 */
export interface LlmAnalysis {
  /** O que a IA identifica que é o documento, a partir do texto. */
  tipoIdentificado: string;
  /** Revisão do conteúdo: principais dados/seções presentes. */
  revisao: string[];
  /** O CNPJ extraído faz sentido para este documento? (modo CNPJ) */
  cnpjConfere: CnpjConfere;
  /** Justificativa curta sobre a consistência do CNPJ. (modo CNPJ) */
  cnpjObservacao: string;
  /**
   * Validação campo a campo dos dados extraídos. Preenchido apenas no modo
   * "dados pessoais/clínicos" (documento fora dos tipos conhecidos).
   */
  validacoes?: ValidacaoCampo[];
  /** Parecer geral da IA sobre a consistência dos dados. (modo dados) */
  parecer?: string;
}

/**
 * Dados sensíveis (PII + saúde) extraídos quando o documento NÃO é um dos tipos
 * conhecidos (tipoDocumento === 'Desconhecido') — tipicamente fichas/documentos
 * clínicos. Best-effort por regra: cada campo é `null` (ou lista vazia) quando
 * não há confiança suficiente. Nada sai do navegador.
 */
export interface DadosSensiveis {
  /** CPF normalizado XXX.XXX.XXX-XX (DV validado), ou null. */
  cpf: string | null;
  /** Data de nascimento (ISO YYYY-MM-DD), ou null. */
  dataNascimento: string | null;
  /** E-mail, ou null. */
  email: string | null;
  /** Telefone/celular, ou null. */
  telefone: string | null;
  /** Endereço (linha completa próxima ao rótulo), ou null. */
  endereco: string | null;
  /** Nome da mãe / filiação, ou null. */
  nomeMae: string | null;
  /** Cartão SUS / CNS (15 dígitos), ou null. */
  cartaoSus: string | null;
  /** Convênio / plano de saúde / operadora, ou null. */
  convenio: string | null;
  /** Contato (campo "contato:" do documento), ou null. */
  contato: string | null;
  /** Hipótese diagnóstica / CID, ou null. */
  hipoteseDiagnostica: string | null;
  /** Trechos com indícios de dados de saúde (queixa, exames, medicação...). */
  dadosSaude: string[];
}

/**
 * Resultado da extração estruturada.
 *
 * É exatamente este objeto que é exibido como JSON na terceira coluna.
 */
export interface StructuredData {
  /** Tipo inferido do documento (CNPJ, Certidão ou Desconhecido). */
  tipoDocumento: TipoDocumento;
  /** CNPJ normalizado no formato XX.XXX.XXX/XXXX-XX, ou null se não encontrado. */
  cnpj: string | null;
  /** Razão social / nome empresarial detectado, ou null. */
  razaoSocial: string | null;
  /** Todas as datas encontradas, normalizadas para ISO (YYYY-MM-DD) e ordenadas. */
  datas: string[];
  /** Data de validade detectada (ISO YYYY-MM-DD), ou null. */
  dataValidade: string | null;
  /** Status calculado em relação à data de hoje. */
  status: StatusDocumento;
  /**
   * Dados sensíveis (PII + saúde). Só é preenchido quando
   * `tipoDocumento === 'Desconhecido'`; nos demais casos é `null`.
   */
  sensiveis: DadosSensiveis | null;
}
