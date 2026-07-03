import { Injectable } from '@angular/core';
import {
  DadosSensiveis,
  StatusDocumento,
  StructuredData,
  TipoDocumento,
} from '../models/document.model';

/**
 * Serviço de extração estruturada.
 *
 * Recebe o TEXTO BRUTO do OCR e aplica heurísticas simples (regex + busca por
 * palavras-chave) para extrair campos de interesse. Não há nenhuma chamada
 * externa: é puro processamento de string no navegador.
 *
 * Como OCR é ruidoso, todas as heurísticas são tolerantes a falhas e retornam
 * `null` quando não há confiança suficiente.
 */
@Injectable({ providedIn: 'root' })
export class ExtractionService {
  /**
   * Regex única para encontrar datas em dois formatos:
   *  - dd/mm/aaaa, dd-mm-aaaa, dd.mm.aaaa  (formato brasileiro)
   *  - aaaa-mm-dd                          (formato ISO)
   */
  private readonly DATE_RE =
    /\b\d{2}[/\-.]\d{2}[/\-.]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g;

  /**
   * Rótulos que antecedem a razão social. Variantes cobrem layouts diferentes:
   *  - Comprovante de CNPJ: "Razão Social", "Nome Empresarial"
   *  - GPS / guias: "Nome ou Razão Social ...", "Denominação", "Nome do Contribuinte"
   * O grupo 2 captura o que sobra da MESMA linha (pode ser resíduo de rótulo).
   */
  // Ancoramos no token mais distintivo de cada rótulo. Ex.: usamos
  // "empresarial" (não "nome empresarial") porque o OCR erra o "nome"
  // ("NOVE EMPRESARIAL"), mas raramente a palavra "empresarial".
  private readonly RAZAO_LABELS =
    /(nome ou raz[aã]o social|raz[aã]o social|empresarial|nome do contribuinte|denomina[cç][aã]o)\s*[:\-/]?\s*(.*)/i;

  /**
   * Detecta linhas que ainda são CONTINUAÇÃO do rótulo (não são o valor).
   * Ex.: na GPS o cabeçalho é "NOME OU RAZÃO SOCIAL / FONE / ENDEREÇO" e o OCR
   * costuma quebrar deixando "/ FONE / ENDEREÇO" sozinho numa linha.
   */
  private readonly ROTULO_RESIDUAL =
    /^[/\s]*((nome|fone|denomina[cç][aã]o|e?\s*endere[cç]o)[/\s]*)+$/i;

  /**
   * Palavras de CAMPO/cabeçalho que NÃO podem ser razão social — usadas para
   * pular linhas de CNPJ, valores e títulos da guia durante a busca pelo valor.
   */
  private readonly CAMPOS_DOC =
    /\b(c\.?n\.?p\.?j|cnpj|identificador|valor|compet[eê]ncia|vencimento|c[oó]digo|autentica[cç][aã]o|total|previd[eê]ncia social|minist[eé]rio|instituto nacional|secretaria)\b/i;

  /**
   * Termos societários, do MAIS confiável (LTDA) ao mais ambíguo (ME). A ordem
   * importa: uma linha com "LTDA" deve vencer uma linha que só tenha "ME".
   * Todos usam \b para evitar casar "me" dentro de "Nome", "ME" em "SAO", etc.
   */
  private readonly TERMOS_SOCIETARIOS = [
    /\bLTDA\b/i,
    /\bEIRELI\b/i,
    /\bS[./]?A\b/i,
    /\bEPP\b/i,
    /\bMEI\b/i,
    /\bME\b/i,
    /\bCIA\b/i,
    /\bSOCIEDADE\b/i,
    /\bASSOCIA[CÇ][AÃ]O\b/i,
  ];

  /**
   * Confusões clássicas do OCR (letra lida no lugar de dígito). Conservador —
   * só as trocas mais comuns. A validação do DV abaixo é o que torna seguro
   * aplicar essas substituições de forma agressiva.
   */
  private readonly OCR_DIGIT_FIX: Record<string, string> = {
    O: '0', o: '0', D: '0', Q: '0',
    I: '1', l: '1', i: '1', '|': '1',
    Z: '2', z: '2',
    S: '5', s: '5',
    G: '6',
    T: '7',
    B: '8',
  };

  /** Ponto de entrada: transforma texto bruto no objeto estruturado. */
  extract(rawText: string): StructuredData {
    const text = rawText ?? '';
    const lower = text.toLowerCase();

    const cnpj = this.extractCnpj(text);
    const datas = this.extractDates(text);
    const dataValidade = this.extractValidade(text);
    const razaoSocial = this.extractRazaoSocial(text);
    const tipoDocumento = this.detectTipo(lower);
    const status = this.computeStatus(dataValidade);

    // Documento fora dos tipos conhecidos: tenta extrair PII + dados de saúde
    // (cenário de ficha/documento clínico).
    const sensiveis =
      tipoDocumento === 'Desconhecido' ? this.extractSensiveis(text) : null;

    return {
      tipoDocumento,
      cnpj,
      razaoSocial,
      datas,
      dataValidade,
      status,
      sensiveis,
    };
  }

  // ---------------------------------------------------------------------------
  // CNPJ
  // ---------------------------------------------------------------------------

  /**
   * Procura um CNPJ no texto. Aceita o número com ou sem pontuação (o OCR às
   * vezes "come" pontos e barras) e o normaliza para XX.XXX.XXX/XXXX-XX.
   */
  // Público para permitir um 2º passe de OCR focado apenas no número.
  extractCnpj(text: string): string | null {
    // 1) Caminho feliz: CNPJ legível (com/sem pontuação; vírgula tolerada).
    const direto = text.match(
      /(\d{2})[.,\s]?(\d{3})[.,\s]?(\d{3})[/\s]?(\d{4})[-\s]?(\d{2})/,
    );
    const fmtDireto = direto
      ? `${direto[1]}.${direto[2]}.${direto[3]}/${direto[4]}-${direto[5]}`
      : null;
    if (fmtDireto && this.cnpjValido(fmtDireto)) return fmtDireto;

    // 2) Resgate de OCR: o Tesseract troca dígito por letra (O→0, S→5, B→8...).
    //    Procuramos tokens "com cara de CNPJ", corrigimos letra→dígito e só
    //    aceitamos se os DÍGITOS VERIFICADORES baterem — isso torna a correção
    //    agressiva segura (não aceita CNPJ inválido por acaso).
    const candidatos =
      text.match(/[0-9OoDQIli|ZzSsGTB][0-9OoDQIli|ZzSsGTB.,/\s-]{12,24}/g) ?? [];
    for (const bruto of candidatos) {
      const digitos = [...bruto]
        .map((c) => this.OCR_DIGIT_FIX[c] ?? c)
        .join('')
        .replace(/\D/g, '');
      if (digitos.length !== 14) continue;
      const fmt = this.formatCnpj(digitos);
      if (this.cnpjValido(fmt)) return fmt;
    }

    // 3) Último recurso: devolve o match legível mesmo sem DV válido (pode ser
    //    erro de OCR só nos 2 últimos dígitos), se existir.
    return fmtDireto;
  }

  /** Formata 14 dígitos como XX.XXX.XXX/XXXX-XX. */
  private formatCnpj(d: string): string {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
  }

  /** Validação dos dígitos verificadores do CNPJ (módulo 11). */
  private cnpjValido(cnpj: string): boolean {
    const n = cnpj.replace(/\D/g, '');
    if (n.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(n)) return false; // rejeita 00000000000000 etc.

    const dv = (base: string, pesos: number[]): number => {
      const soma = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0);
      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    const d1 = dv(n.slice(0, 12), p1);
    if (d1 !== Number(n[12])) return false;
    const d2 = dv(n.slice(0, 13), p2);
    return d2 === Number(n[13]);
  }

  // ---------------------------------------------------------------------------
  // Datas
  // ---------------------------------------------------------------------------

  /** Extrai TODAS as datas válidas, normaliza para ISO e remove duplicatas. */
  private extractDates(text: string): string[] {
    const found = new Set<string>();
    for (const token of text.match(this.DATE_RE) ?? []) {
      const iso = this.parseDate(token);
      if (iso) found.add(iso);
    }
    return [...found].sort();
  }

  /** Converte um token de data (BR ou ISO) para ISO YYYY-MM-DD, validando faixas. */
  private parseDate(token: string): string | null {
    let m = token.match(/^(\d{2})[/\-.](\d{2})[/\-.](\d{4})$/);
    if (m) return this.toIso(+m[3], +m[2], +m[1]); // dd mm aaaa

    m = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return this.toIso(+m[1], +m[2], +m[3]); // aaaa mm dd

    return null;
  }

  /** Monta a string ISO se a data for plausível; caso contrário, descarta. */
  private toIso(year: number, month: number, day: number): string | null {
    if (year < 1900 || year > 2200) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  // ---------------------------------------------------------------------------
  // Data de validade
  // ---------------------------------------------------------------------------

  /**
   * Procura uma data PRÓXIMA a uma palavra-chave de validade. Olhamos uma
   * "janela" de 80 caracteres após a palavra para pegar a primeira data ali.
   */
  private extractValidade(text: string): string | null {
    const keywords = [
      'validade',
      'válida até',
      'valida até',
      'válido até',
      'valido até',
      'vencimento',
      'expira',
    ];
    const lower = text.toLowerCase();

    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx < 0) continue;

      const window = text.slice(idx, idx + 80);
      const dateToken = window.match(this.DATE_RE)?.[0];
      const iso = dateToken ? this.parseDate(dateToken) : null;
      if (iso) return iso;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Razão social
  // ---------------------------------------------------------------------------

  /**
   * Tenta achar a razão social em duas estratégias complementares:
   *
   *  1) POR RÓTULO — acha a linha do rótulo ("Razão Social", "Nome ou Razão
   *     Social", "Denominação"...) e procura o VALOR na mesma linha ou nas
   *     linhas seguintes, PULANDO resíduos de rótulo e linhas de campo/CNPJ.
   *     (Necessário para guias como a GPS, onde o nome fica 2 linhas abaixo,
   *      depois da linha do C.N.P.J.)
   *
   *  2) FALLBACK por SUFIXO societário (LTDA, EIRELI, S/A…), do mais forte ao
   *     mais fraco. Resolve documentos sem rótulo reconhecível.
   *
   * Antes de tudo, cada linha é normalizada para remover artefatos de borda de
   * tabela do OCR (`|`, `[`, `]`), muito comuns em guias.
   */
  private extractRazaoSocial(text: string): string | null {
    const lines = text
      .split(/\r?\n/)
      .map((l) => this.cleanLine(l))
      .filter((l) => l.length > 0);

    // 1) Estratégia por rótulo.
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(this.RAZAO_LABELS);
      if (!m) continue;

      // Valor na mesma linha (ex.: "Razão Social: EMPRESA XPTO LTDA").
      const inline = this.clean(m[2]);
      if (this.ehValorDeNome(inline)) return inline;

      // Senão, procura nas próximas linhas (a janela cobre o gap rótulo→valor).
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (this.ehValorDeNome(lines[j])) return lines[j];
      }
    }

    // 2) Fallback por sufixo societário (LTDA vence ME, etc.).
    for (const termo of this.TERMOS_SOCIETARIOS) {
      const linha = lines.find((l) => termo.test(l) && l.length > 3);
      if (linha) return linha;
    }

    return null;
  }

  /**
   * Decide se uma string parece o VALOR de um nome/razão social — e não um
   * resíduo de rótulo, uma linha de CNPJ ou um campo da guia.
   */
  private ehValorDeNome(value: string): boolean {
    const v = this.clean(value);
    if (v.length < 3) return false;
    if (!/[a-zà-ú]/i.test(v)) return false; // precisa ter letras
    if (this.ROTULO_RESIDUAL.test(v)) return false; // "/ FONE / ENDEREÇO"
    if (/^\d/.test(v)) return false; // começa com número (valor/CEP/campo)
    if (/\d{2}[.,]?\d{3}[.,]?\d{3}[/.]\d{4}/.test(v)) return false; // contém CNPJ
    if (this.CAMPOS_DOC.test(v)) return false; // linha de campo/cabeçalho
    return true;
  }

  /** Normaliza espaços e remove caracteres de borda inúteis (pontuação final). */
  private clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim().replace(/[.,;:\-]+$/, '').trim();
  }

  /** Como `clean`, mas também remove artefatos de borda de tabela do OCR. */
  private cleanLine(value: string): string {
    return this.clean(value.replace(/[|[\]]/g, ' '));
  }

  // ---------------------------------------------------------------------------
  // Tipo do documento
  // ---------------------------------------------------------------------------

  /** Heurística de classificação por palavras-chave (acentos opcionais). */
  private detectTipo(lower: string): TipoDocumento {
    if (
      lower.includes('comprovante de inscrição') ||
      lower.includes('comprovante de inscricao')
    ) {
      return 'CNPJ';
    }
    if (lower.includes('certidão') || lower.includes('certidao')) {
      return 'Certidão';
    }
    if (
      lower.includes('guia da previdência social') ||
      lower.includes('guia da previdencia social') ||
      /\bgps\b/.test(lower)
    ) {
      return 'GPS';
    }
    return 'Desconhecido';
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Calcula o status comparando a data de validade com hoje:
   *  - sem validade            => Indeterminado
   *  - validade < hoje         => Vencido
   *  - validade >= hoje        => Válido
   */
  private computeStatus(dataValidade: string | null): StatusDocumento {
    if (!dataValidade) return 'Indeterminado';

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    // 'T00:00:00' força interpretação no fuso local (evita deslocamento de UTC).
    const validade = new Date(`${dataValidade}T00:00:00`);

    return validade.getTime() < hoje.getTime() ? 'Vencido' : 'Válido';
  }

  // ---------------------------------------------------------------------------
  // Dados sensíveis (PII + saúde) — só para documentos "Desconhecido"
  // ---------------------------------------------------------------------------

  // Aceita o '@' OU o '&' (confusão clássica do OCR) como separador local@domínio.
  private readonly EMAIL_RE = /[A-Za-z0-9._%+-]+[@&][A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  /** Telefone formatado: exige separador (parênteses ou hífen/espaço entre grupos). */
  private readonly TELEFONE_RE =
    /(?:\(\d{2}\)\s?|\d{2}[\s-])?\d{4,5}[-.\s]\d{4}\b/;
  /** Indícios de dados de saúde, usados para coletar linhas clínicas. */
  private readonly SAUDE_KW =
    /\b(queixa|sintoma|diagn[oó]stic|\bcid\b|press[aã]o arterial|glicemia|medica[cç][aã]o|medicamento|alergi|exame|hemograma|anamnese|conduta|prescri[cç][aã]o)\b/i;

  /** Extrai PII + dados de saúde de fichas/documentos clínicos. Best-effort. */
  private extractSensiveis(text: string): DadosSensiveis {
    const lines = text
      .split(/\r?\n/)
      .map((l) => this.cleanLine(l))
      .filter((l) => l.length > 0);

    return {
      cpf: this.extractCpf(text),
      dataNascimento: this.dataPorRotulo(text, [
        'data de nascimento',
        'nascimento',
        'nasc.',
        'dt nasc',
        'd.n.',
      ]),
      email: text.match(this.EMAIL_RE)?.[0].replace('&', '@') ?? null,
      telefone: this.extractTelefone(text),
      endereco: this.valorAposRotulo(lines, /(endere[cç]o|logradouro|residente em)/),
      nomeMae: this.valorAposRotulo(lines, /(nome da m[aã]e|filia[cç][aã]o|\bm[aã]e\b)/),
      cartaoSus: this.extractSus(text),
      convenio: this.valorAposRotulo(lines, /(conv[eê]nio|plano de sa[uú]de|operadora)/),
      contato: this.valorAposRotulo(lines, /(telefone de contato|pessoa de contato|\bcontato\b)/),
      hipoteseDiagnostica: this.valorAposRotulo(
        lines,
        /(hip[oó]tese diagn[oó]stica|diagn[oó]stico|\bhd\b|\bcid\b)/,
      ),
      dadosSaude: this.extractDadosSaude(lines),
    };
  }

  /**
   * Extrai CPF e só aceita se os DV baterem. Tolerante ao OCR:
   *  1) separadores flexíveis (ponto, vírgula, espaço, traço) entre os grupos —
   *     o OCR troca '.' por ',' ou insere espaços ("123 456 789 00");
   *  2) resgate letra→dígito (O→0, S→5, B→8...) para tokens "com cara de CPF".
   */
  private extractCpf(text: string): string | null {
    // 1) Caminho direto, com separadores flexíveis.
    const diretos =
      text.match(/\d{3}[.,\s]?\d{3}[.,\s]?\d{3}[-.,\s]?\d{2}/g) ?? [];
    for (const d of diretos) {
      const n = d.replace(/\D/g, '');
      if (n.length === 11 && this.cpfValido(n)) return this.formatCpf(n);
    }

    // 2) Resgate de OCR: corrige letras confundidas com dígitos e revalida o DV.
    const candidatos =
      text.match(/[0-9OoDQIli|ZzSsGTB][0-9OoDQIli|ZzSsGTB.,\s-]{8,18}/g) ?? [];
    for (const bruto of candidatos) {
      const n = [...bruto]
        .map((c) => this.OCR_DIGIT_FIX[c] ?? c)
        .join('')
        .replace(/\D/g, '');
      if (n.length === 11 && this.cpfValido(n)) return this.formatCpf(n);
    }

    // 3) Último recurso: CPF em formato CANÔNICO (XXX.XXX.XXX-XX) mesmo sem DV
    //    válido — cobre CPFs de teste/sintéticos e erro de OCR no dígito
    //    verificador. A máscara estrita evita casar telefone, valor ou RG.
    const canonico = text.match(/\b\d{3}\.\d{3}\.\d{3}[-.]\d{2}\b/);
    return canonico ? this.formatCpf(canonico[0].replace(/\D/g, '')) : null;
  }

  /** Formata 11 dígitos como XXX.XXX.XXX-XX. */
  private formatCpf(n: string): string {
    return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9, 11)}`;
  }

  /** Validação dos dígitos verificadores do CPF (módulo 11). */
  private cpfValido(n: string): boolean {
    if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false;
    const dv = (len: number): number => {
      let soma = 0;
      for (let i = 0; i < len; i++) soma += Number(n[i]) * (len + 1 - i);
      const r = (soma * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(n[9]) && dv(10) === Number(n[10]);
  }

  /** Telefone/celular formatado (evita casar runs crus de CPF/SUS). */
  private extractTelefone(text: string): string | null {
    const m = text.match(this.TELEFONE_RE);
    return m ? this.clean(m[0]) : null;
  }

  /** Cartão SUS / CNS: 15 dígitos, perto do rótulo ou isolado. */
  private extractSus(text: string): string | null {
    const lower = text.toLowerCase();
    const rotulos = [
      'cartão nacional de saúde',
      'cartao nacional de saude',
      'cartão sus',
      'cartao sus',
      'cns',
      'sus',
    ];
    for (const kw of rotulos) {
      const idx = lower.indexOf(kw);
      if (idx < 0) continue;
      const win = text.slice(idx, idx + 60);
      const m = win.match(/(?:\d[\s.]?){15}/);
      const n = m?.[0].replace(/\D/g, '') ?? '';
      if (n.length === 15) {
        return n.replace(/(\d{3})(\d{4})(\d{4})(\d{4})/, '$1 $2 $3 $4');
      }
    }
    const solto = text.match(/\b\d{15}\b/);
    return solto ? solto[0] : null;
  }

  /** Procura a 1ª data numa janela após uma das palavras-chave dadas. */
  private dataPorRotulo(text: string, kws: string[]): string | null {
    const lower = text.toLowerCase();
    for (const kw of kws) {
      const idx = lower.indexOf(kw);
      if (idx < 0) continue;
      const win = text.slice(idx, idx + 60);
      const token = win.match(this.DATE_RE)?.[0];
      const iso = token ? this.parseDate(token) : null;
      if (iso) return iso;
    }
    return null;
  }

  /**
   * Acha a linha de um rótulo e devolve o valor na mesma linha (após `:`/`-`)
   * ou, se vazio, a próxima linha plausível. `label` é um grupo de alternativas.
   */
  private valorAposRotulo(lines: string[], label: RegExp): string | null {
    const re = new RegExp(`${label.source}\\s*[:\\-]?\\s*(.*)`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      const inline = this.clean(m[m.length - 1] ?? '');
      if (inline.length >= 2) return inline;
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const v = this.clean(lines[j]);
        if (v.length >= 2) return v;
      }
    }
    return null;
  }

  /** Coleta até 8 linhas com indícios clínicos (queixa, exames, medicação...). */
  private extractDadosSaude(lines: string[]): string[] {
    const out: string[] = [];
    for (const l of lines) {
      if (l.length > 4 && this.SAUDE_KW.test(l)) out.push(l);
      if (out.length >= 8) break;
    }
    return out;
  }
}
