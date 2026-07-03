import { computed, inject, Injectable, NgZone, signal } from '@angular/core';
import type {
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm';

import {
  LlmAnalysis,
  StatusValidacao,
  StructuredData,
  ValidacaoCampo,
} from '../models/document.model';

/** Estados do ciclo de vida da análise por IA. */
export type LlmStatus =
  | 'idle'
  | 'baixando-modelo'
  | 'analisando'
  | 'pronto'
  | 'erro';

/**
 * Um modelo oferecido pelo backend (combo).
 *  - `vision`: aceita imagem (image_url);
 *  - `pdf`: ingere PDF nativo (tipo `file`, multipágina) — família gpt-4o.
 */
export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  vision: boolean;
  pdf: boolean;
}

/**
 * Modelo instruct local. Variante `q4f32` (compatível mesmo sem `shader-f16`).
 * 1.5B segue bem melhor a semântica dos campos que o 0.5B (~1.1 GB, cacheado).
 * Em GPUs fracas dá para descer para `Qwen2.5-0.5B-Instruct-q4f32_1-MLC`.
 */
const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';

/**
 * Provedor da análise:
 *  - 'local'        → modelo no navegador (WebLLM/WebGPU), original da POC.
 *  - 'cleanpredict' → modelo da OpenAI via proxy CleanPredict, atrás do nosso
 *                     backend Node (server/), que guarda a API key.
 *
 * Troque aqui para alternar. Para o CleanPredict, suba o proxy: ver server/.
 */
const PROVIDER: 'local' | 'cleanpredict' = 'cleanpredict';

/**
 * Endpoint do nosso proxy Node (server/index.js). Caminho relativo: o ng serve
 * faz proxy de `/api` para o backend (ver proxy.conf.json), então front e API
 * ficam na mesma origem — sem CORS.
 */
const PROXY_URL = '/api/analyze';

/**
 * Análise de habilitação/conformidade do documento usando um LLM **local**
 * (WebLLM/WebGPU). Recebe os dados já extraídos + um trecho do OCR e devolve um
 * parecer de negócio. Nada é enviado para servidores — apenas os arquivos do
 * modelo são baixados (uma vez, cacheados) do CDN do HuggingFace.
 *
 * Princípio: as validações DURAS (DV do CNPJ, status por data) já foram feitas
 * por regra e são tratadas como verdade. O LLM faz a camada de análise/parecer.
 */
@Injectable({ providedIn: 'root' })
export class LlmAnalysisService {
  /**
   * Análise disponível? No modo CleanPredict só depende do proxy (sempre true);
   * no modo local, exige WebGPU.
   */
  readonly supported =
    PROVIDER === 'cleanpredict' ||
    (typeof navigator !== 'undefined' && 'gpu' in navigator);

  // Worker do WebLLM roda FORA da zona do Angular; os updates de signal vindos
  // dos callbacks/stream precisam rodar dentro de NgZone para a UI atualizar.
  private readonly zone = inject(NgZone);

  private engine: MLCEngineInterface | null = null;

  private readonly _status = signal<LlmStatus>('idle');
  private readonly _progress = signal(0); // 0..1 (download do modelo)
  private readonly _progressText = signal('');
  private readonly _result = signal<LlmAnalysis | null>(null);
  private readonly _error = signal<string | null>(null);
  private readonly _partial = signal(''); // texto sendo gerado (streaming)

  readonly status = this._status.asReadonly();
  readonly progressText = this._progressText.asReadonly();
  readonly result = this._result.asReadonly();
  readonly error = this._error.asReadonly();
  readonly partial = this._partial.asReadonly();

  readonly progressPercent = computed(() => Math.round(this._progress() * 100));
  readonly busy = computed(
    () => this._status() === 'baixando-modelo' || this._status() === 'analisando',
  );

  // --- Seleção de modelo (combo), só no modo backend/OpenAI-compat ------------
  private readonly _models = signal<ModelInfo[]>([]);
  /** Lista de modelos disponíveis (OCI + OpenAI), vinda de GET /api/models. */
  readonly models = this._models.asReadonly();
  /** Id do modelo selecionado no combo (gravável: o componente faz o binding). */
  readonly selectedModelId = signal<string>('');
  /** O modelo selecionado, resolvido na lista (ou null). */
  readonly selectedModel = computed(
    () => this._models().find((m) => m.id === this.selectedModelId()) ?? null,
  );
  /** O modelo selecionado aceita imagem? Habilita o "Enviar arquivo à IA". */
  readonly selectedVision = computed(() => this.selectedModel()?.vision ?? false);
  /** O modelo selecionado ingere PDF nativo (multipágina)? Se não, mandamos imagem. */
  readonly selectedPdf = computed(() => this.selectedModel()?.pdf ?? false);

  constructor() {
    // No modo backend, busca a lista de modelos que o proxy expõe (reflete quais
    // provedores estão configurados). No modo local (WebLLM) não há combo.
    if (PROVIDER === 'cleanpredict') void this.loadModels();
  }

  /** Carrega os modelos do backend e seleciona o default. Falha silenciosa. */
  private async loadModels(): Promise<void> {
    try {
      const resp = await fetch('/api/models');
      if (!resp.ok) return;
      const body = (await resp.json()) as { models?: ModelInfo[]; default?: string };
      const models = body.models ?? [];
      this.zone.run(() => {
        this._models.set(models);
        this.selectedModelId.set(body.default || models[0]?.id || '');
      });
    } catch (e) {
      console.warn('[LlmAnalysis] não foi possível listar modelos:', e);
    }
  }

  /** Limpa o resultado/erro ao trocar de documento (mantém o modelo carregado). */
  clearResult(): void {
    this._result.set(null);
    this._error.set(null);
    this._partial.set('');
    if (this._status() !== 'baixando-modelo') this._status.set('idle');
  }

  /**
   * Roda a análise. Faz lazy-load do modelo na primeira chamada (modo local).
   *
   * `opts.rawOnly`: quando true, envia SOMENTE o texto cru do OCR para a IA
   * (sem injetar os campos já extraídos por regra) — a IA trabalha direto do
   * texto. Quando false (padrão), inclui os campos parseados no prompt.
   */
  async analisar(
    ocrText: string,
    structured: StructuredData,
    opts: {
      rawOnly?: boolean;
      file?: { filename: string; dataUrl: string };
      prompt?: string;
    } = {},
  ): Promise<void> {
    if (!this.supported) {
      this._error.set('WebGPU indisponível neste navegador.');
      this._status.set('erro');
      return;
    }

    this._error.set(null);
    try {
      const rawOnly = opts.rawOnly ?? false;
      const file = opts.file;
      // Documento fora dos tipos conhecidos (ex.: ficha/doc pessoal): a IA
      // VALIDA os dados. Caso contrário, segue a análise de CNPJ.
      const modoDados = !!structured.sensiveis;

      // O envio direto do arquivo (sem OCR) só faz sentido via backend/OpenAI.
      if (file && PROVIDER !== 'cleanpredict') {
        throw new Error('Enviar o arquivo à IA requer o backend (OpenAI).');
      }

      // Modo arquivo: o prompt do usuário (ou uma instrução padrão) vai como
      // texto JUNTO do arquivo para o modelo. Senão: prompt com os campos
      // parseados (ou só OCR cru).
      const userContent = file
        ? (opts.prompt?.trim() || this.instrucaoArquivo())
        : this.userPrompt(ocrText, structured, rawOnly);

      // O CleanPredict avalia TEXTO. No modo arquivo, mandamos como `question`
      // o prompt do usuário + o texto do documento (OCR), para o guardrail
      // poder bloquear. (Texto que o OCR não capturar, ele não vê.)
      const questionGuardrail = file
        ? [userContent, ocrText.trim()].filter(Boolean).join(
            '\n\n--- TEXTO DO DOCUMENTO (OCR) ---\n',
          )
        : undefined;

      const messages = [
        { role: 'system' as const, content: this.systemPrompt(modoDados) },
        { role: 'user' as const, content: userContent },
      ];

      const content =
        PROVIDER === 'cleanpredict'
          ? await this.inferViaProxy(messages, file, questionGuardrail)
          : await this.inferLocal(messages);

      console.info('[LlmAnalysis] saída do modelo:', content);
      if (!content.trim()) {
        throw new Error('O modelo não retornou texto (saída vazia).');
      }
      this.zone.run(() => {
        this._result.set(this.parse(content, modoDados));
        this._status.set('pronto');
      });
    } catch (e) {
      console.error('[LlmAnalysis] falha:', e);
      this.zone.run(() => {
        this._error.set(
          e instanceof Error ? e.message : 'Falha ao rodar a análise.',
        );
        this._status.set('erro');
      });
    }
  }

  /** Inferência via modelo da OpenAI atrás do proxy CleanPredict (server/). */
  private async inferViaProxy(
    messages: { role: 'system' | 'user'; content: string }[],
    file?: { filename: string; dataUrl: string },
    question?: string,
  ): Promise<string> {
    this.zone.run(() => {
      this._status.set('analisando');
      this._partial.set('');
    });
    console.info('[LlmAnalysis] chamando proxy CleanPredict…', file ? '(com arquivo)' : '');

    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `file`/`question`/`model` são omitidos do JSON quando undefined.
      body: JSON.stringify({
        model: this.selectedModelId() || undefined,
        temperature: 0.3,
        max_tokens: 700,
        messages,
        file,
        question,
      }),
    });

    if (!resp.ok || !resp.body) {
      const detalhe = await resp.text().catch(() => '');
      throw new Error(
        `Proxy retornou ${resp.status}. ${detalhe || 'O backend (server/) está rodando?'}`,
      );
    }

    // O guardrail (CleanPredict) pode barrar o prompt: nesse caso o backend
    // devolve JSON em vez do stream de texto. Detectamos pelo content-type.
    if (resp.headers.get('content-type')?.includes('application/json')) {
      const body = await resp.json().catch(() => null);
      if (body?.blocked) {
        const codes = body.decision?.reason_codes?.length
          ? ` (${body.decision.reason_codes.join(', ')})`
          : '';
        throw new Error(`Prompt bloqueado pelo guardrail CleanPredict${codes}.`);
      }
      throw new Error('Resposta inesperada do proxy.');
    }

    // O proxy devolve texto cru em chunks; lemos o stream e atualizamos a UI.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
      this.zone.run(() => this._partial.set(content));
    }
    return content;
  }

  /** Inferência via modelo local (WebLLM/WebGPU), original da POC. */
  private async inferLocal(
    messages: { role: 'system' | 'user'; content: string }[],
  ): Promise<string> {
    const engine = await this.ensureEngine();

    this.zone.run(() => {
      this._status.set('analisando');
      this._partial.set('');
    });
    console.info('[LlmAnalysis] iniciando inferência local…');
    // Streaming: dá feedback visível (tokens chegando) e evita a sensação de
    // "travou" durante o 1º passe (compilação de shaders + prefill).
    // NÃO usamos `response_format`/JSON-schema nativo — quebra o GrammarCompiler
    // ("Cannot pass non-string to std::string"). O JSON é garantido por prompt
    // + parsing tolerante.
    const stream = await engine.chat.completions.create({
      temperature: 0.3,
      max_tokens: 700,
      stream: true,
      messages,
    });

    let content = '';
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content ?? '';
      this.zone.run(() => this._partial.set(content));
    }
    return content;
  }

  /** Cria o engine (download + init do modelo) uma única vez. */
  private async ensureEngine(): Promise<MLCEngineInterface> {
    if (this.engine) return this.engine;

    this._status.set('baixando-modelo');
    this._progress.set(0);
    console.info('[LlmAnalysis] carregando modelo:', MODEL_ID);

    // Import dinâmico: mantém o WebLLM fora do bundle inicial — só carrega
    // quando o usuário pede a análise.
    const webllm = await import('@mlc-ai/web-llm');
    const worker = new Worker(new URL('./llm.worker', import.meta.url), {
      type: 'module',
    });

    this.engine = await webllm.CreateWebWorkerMLCEngine(worker, MODEL_ID, {
      initProgressCallback: (r: InitProgressReport) =>
        this.zone.run(() => {
          this._progress.set(r.progress);
          this._progressText.set(r.text);
        }),
    });
    console.info('[LlmAnalysis] engine pronto.');
    return this.engine;
  }

  private systemPrompt(modoDados: boolean): string {
    return modoDados ? this.systemPromptDados() : this.systemPromptCnpj();
  }

  /** Prompt para documentos pessoais/clínicos: a IA VALIDA os dados extraídos. */
  private systemPromptDados(): string {
    return [
      'Você analisa um documento PESSOAL/CLÍNICO a partir do TEXTO extraído por',
      'OCR e de CAMPOS já extraídos por regra. Trabalhe SOMENTE com o que está no',
      'texto e nos dados — NÃO invente. Português do Brasil, conciso.',
      '',
      'Faça quatro coisas:',
      '1) tipoIdentificado: diga QUE documento é (ex.: "Documento de identificação',
      '   pessoal", "Ficha de atendimento", "Receituário"). Se não der, "Não identificado".',
      '2) revisao: liste os principais dados/seções que VOCÊ VÊ no texto.',
      '3) validacoes: considere os dados sensíveis presentes — use o bloco',
      '   CAMPOS_SENSIVEIS_EXTRAIDOS quando ele vier; se não vier, identifique-os',
      '   você mesmo no TEXTO_OCR (CPF, data de nascimento, e-mail, telefone,',
      '   endereço, nome da mãe, cartão SUS, convênio, hipótese diagnóstica).',
      '   Para CADA dado, avalie se é VÁLIDO e COERENTE quanto a FORMATO e',
      '   PLAUSIBILIDADE:',
      '   - CPF/Cartão SUS: NÃO afirme se o dígito verificador está correto — isso',
      '     é checado por regra determinística. Avalie só o formato (qtde de',
      '     dígitos e máscara); se o formato estiver ok, use "incerto" quanto à',
      '     validade real e diga que o DV é verificado à parte.',
      '   - E-mail: formato local@dominio válido (sinalize se o "@" parece corrompido);',
      '   - Telefone: DDD + número plausível;',
      '   - Data de nascimento: data real e plausível (não futura);',
      '   - Endereço/Nome da mãe/Convênio: coerência e completude.',
      '   Para cada um devolva: campo, valor, status ("valido"|"invalido"|"incerto")',
      '   e observacao curta justificando.',
      '4) parecer: conclusão geral sobre a consistência/qualidade dos dados.',
      '',
      'Responda SOMENTE com JSON válido (sem texto fora do JSON), neste molde:',
      '{"tipoIdentificado":"<o que é>","revisao":["<ponto>"],"validacoes":[{"campo":"<campo>","valor":"<valor>","status":"<valido|invalido|incerto>","observacao":"<justificativa>"}],"parecer":"<conclusão>"}',
    ].join('\n');
  }

  /** Prompt original (documentos empresariais): análise de CNPJ. */
  private systemPromptCnpj(): string {
    return [
      'Você analisa um documento a partir do TEXTO extraído por OCR.',
      'Trabalhe SOMENTE com o que está no texto e nos dados fornecidos — NÃO',
      'invente nomes, números ou fatos. Seja conciso e use português do Brasil.',
      '',
      'Faça três coisas:',
      '1) tipoIdentificado: diga QUE documento é, com base no texto (ex.:',
      '   "Comprovante de Inscrição no CNPJ", "Guia da Previdência Social (GPS)",',
      '   "Certidão..."). Se não der para saber, diga "Não identificado".',
      '2) revisao: liste os principais dados/seções que VOCÊ VÊ no texto',
      '   (ex.: razão social, endereço, CNAE, situação cadastral, valores...).',
      '3) cnpjConfere: avalie o CNPJ do documento — use o CNPJ_EXTRAIDO quando ele',
      '   vier; se não vier, localize o CNPJ no próprio TEXTO_OCR. Ele é coerente',
      '   com a empresa/tipo do documento? Responda "sim", "não" ou "incerto" e',
      '   explique em cnpjObservacao. Se não houver CNPJ, use "incerto".',
      '',
      'Responda SOMENTE com JSON válido (sem texto fora do JSON), neste molde',
      '(troque os <placeholders> pelos valores reais):',
      '{"tipoIdentificado":"<o que é o documento>","revisao":["<ponto>","<ponto>"],"cnpjConfere":"<sim|não|incerto>","cnpjObservacao":"<justificativa curta>"}',
    ].join('\n');
  }

  private userPrompt(
    ocrText: string,
    structured: StructuredData,
    rawOnly: boolean,
  ): string {
    // A revisão é baseada na leitura do documento. 6000 chars (~1,8k tokens)
    // cobre documentos maiores e cabe folgado no contexto de 32K do 1.5B.
    const trecho = (ocrText ?? '').slice(0, 6000);

    // Modo "OCR cru": só o texto, sem os campos pré-extraídos por regra — a IA
    // identifica e avalia os dados diretamente do texto.
    if (rawOnly) {
      return ['TEXTO_OCR:', `"""${trecho}"""`].join('\n');
    }

    const partes = [
      `CNPJ_EXTRAIDO: ${structured.cnpj ?? '(não extraído)'}`,
      `RAZAO_SOCIAL_EXTRAIDA: ${structured.razaoSocial ?? '(não extraída)'}`,
    ];

    // Documento fora dos tipos conhecidos: passamos os campos sensíveis já
    // capturados por regra para a IA avaliar/decidir em cima deles.
    const bloco = this.camposSensiveis(structured);
    if (bloco) partes.push('', 'CAMPOS_SENSIVEIS_EXTRAIDOS (por regra):', bloco);

    partes.push('', 'TEXTO_OCR:', `"""${trecho}"""`);
    return partes.join('\n');
  }

  /** Instrução para o modo "enviar arquivo à IA" (sem OCR; o arquivo vai anexo). */
  private instrucaoArquivo(): string {
    return [
      'Analise o DOCUMENTO ANEXADO (o arquivo enviado junto; NÃO há texto OCR).',
      'Leia o conteúdo do próprio arquivo e siga as instruções do sistema.',
      'Responda SOMENTE com o JSON pedido.',
    ].join('\n');
  }

  /** Formata os campos sensíveis não-nulos para o prompt, ou '' se não houver. */
  private camposSensiveis(structured: StructuredData): string {
    const s = structured.sensiveis;
    if (!s) return '';
    const linhas: string[] = [];
    const add = (rotulo: string, valor: string | null) => {
      if (valor) linhas.push(`- ${rotulo}: ${valor}`);
    };
    add('CPF', s.cpf);
    add('Data de nascimento', s.dataNascimento);
    add('E-mail', s.email);
    add('Telefone', s.telefone);
    add('Contato', s.contato);
    add('Endereço', s.endereco);
    add('Nome da mãe', s.nomeMae);
    add('Cartão SUS', s.cartaoSus);
    add('Convênio', s.convenio);
    add('Hipótese diagnóstica', s.hipoteseDiagnostica);
    if (s.dadosSaude.length) add('Dados de saúde', s.dadosSaude.join(' | '));
    return linhas.join('\n');
  }

  /** Faz parse tolerante do JSON do modelo, com defaults seguros. */
  private parse(content: string, modoDados: boolean): LlmAnalysis {
    // O modelo às vezes manda string única em vez de array — normaliza.
    const toArray = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.map(String).map((s) => s.trim()).filter(Boolean)
        : typeof v === 'string' && v.trim()
          ? [v.trim()]
          : [];

    try {
      // Extrai o 1º objeto JSON (modelos às vezes embrulham em ```json … ```).
      const match = content.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(match ? match[0] : content) as Record<string, unknown>;

      const tipoIdentificado =
        typeof obj['tipoIdentificado'] === 'string' ? obj['tipoIdentificado'] : '';
      const revisao = toArray(obj['revisao']);

      if (modoDados) {
        return {
          tipoIdentificado,
          revisao,
          cnpjConfere: 'incerto',
          cnpjObservacao: '',
          validacoes: this.parseValidacoes(obj['validacoes']),
          parecer: typeof obj['parecer'] === 'string' ? obj['parecer'] : '',
        };
      }

      // Aceita variações ("nao", "no", "yes"…) normalizando pela 1ª letra.
      const c = String(obj['cnpjConfere'] ?? '').trim().toLowerCase();
      const cnpjConfere =
        c.startsWith('s') || c.startsWith('y')
          ? 'sim'
          : c.startsWith('n')
            ? 'não'
            : 'incerto';

      return {
        tipoIdentificado,
        revisao,
        cnpjConfere,
        cnpjObservacao:
          typeof obj['cnpjObservacao'] === 'string' ? obj['cnpjObservacao'] : '',
      };
    } catch {
      // Modelo não devolveu JSON válido — mostra o texto cru em vez de quebrar.
      return {
        tipoIdentificado:
          content.trim().slice(0, 400) || 'Sem resposta utilizável do modelo.',
        revisao: [],
        cnpjConfere: 'incerto',
        cnpjObservacao: '',
        ...(modoDados ? { validacoes: [], parecer: '' } : {}),
      };
    }
  }

  /** Normaliza o array de validações vindo do modelo (tolerante a variações). */
  private parseValidacoes(v: unknown): ValidacaoCampo[] {
    if (!Array.isArray(v)) return [];
    return v
      .map((item): ValidacaoCampo => {
        const o = (item ?? {}) as Record<string, unknown>;
        const s = String(o['status'] ?? '').trim().toLowerCase();
        const status: StatusValidacao = /inv|n[aã]o/.test(s)
          ? 'invalido'
          : /^v|sim|ok|coer/.test(s)
            ? 'valido'
            : 'incerto';
        return {
          campo: String(o['campo'] ?? '').trim(),
          valor: String(o['valor'] ?? '').trim(),
          status,
          observacao: String(o['observacao'] ?? '').trim(),
        };
      })
      .filter((x) => x.campo || x.valor);
  }
}
