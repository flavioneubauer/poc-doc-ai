import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import { CnpjConfere, StatusValidacao } from '../../models/document.model';
import { DocumentProcessingService } from '../../services/document-processing.service';
import { LlmAnalysisService } from '../../services/llm-analysis.service';

/**
 * Painel "Análise do documento (IA local)".
 *
 * Mostra um botão sob demanda (o modelo só baixa quando o usuário pede) e, ao
 * final, o parecer de negócio produzido pelo LLM local. Lê os dados extraídos
 * do `DocumentProcessingService` e delega ao `LlmAnalysisService`.
 */
@Component({
  selector: 'app-llm-analysis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>🤖 Análise (IA local)</h2>

    @if (!llm.supported) {
      <p class="empty">
        WebGPU não disponível neste navegador — a análise por IA local fica
        indisponível. A extração por regra segue funcionando.
      </p>
    } @else {
        @if (llm.models().length) {
          <label class="model-label" for="modeloIa">Modelo</label>
          <select
            id="modeloIa"
            class="model-select"
            [value]="llm.selectedModelId()"
            (change)="llm.selectedModelId.set($any($event.target).value)"
            [disabled]="llm.busy()"
          >
            @for (m of llm.models(); track m.id) {
              <option [value]="m.id">{{ m.label }}</option>
            }
          </select>
        }

        <label class="prompt-label" for="promptIa">
          Prompt (usado no “Enviar arquivo à IA” — vai junto com o arquivo e é o
          texto que o guardrail avalia):
        </label>
        <textarea
          id="promptIa"
          class="prompt-input"
          rows="2"
          [value]="promptIa()"
          (input)="promptIa.set($any($event.target).value)"
          placeholder="Ex.: Extraia e valide os dados deste documento…"
        ></textarea>

        <div class="botoes">
          <button type="button" [disabled]="!podeAnalisar() || llm.busy()" (click)="analisar()">
            {{ botaoLabel() }}
          </button>
          <button
            type="button"
            class="secundario"
            title="Envia só o texto bruto do OCR para a IA, sem os campos já extraídos por regra"
            [disabled]="!podeAnalisar() || llm.busy()"
            (click)="analisarCru()"
          >
            Analisar OCR cru
          </button>
          <button
            type="button"
            class="secundario"
            title="Envia o documento à IA sem OCR. PDF: vai INTEIRO (nativo) em modelos gpt-4o; nos demais (visão) vai a 1ª página como imagem. Requer modelo com visão. O guardrail não enxerga o conteúdo."
            [disabled]="!podeAnalisar() || llm.busy() || !arquivoIaUrl() || !llm.selectedVision()"
            (click)="analisarArquivo()"
          >
            Enviar arquivo à IA
          </button>
        </div>

        @if (docProc.docKind() === 'pdf' && llm.selectedVision()) {
          <p class="hint">
            @if (enviaraPdfNativo()) {
              📄 PDF inteiro (nativo) → o modelo lê todas as páginas.
            } @else {
              🖼️ Só a 1ª página (imagem) — este modelo não ingere PDF; escolha um gpt-4o para o PDF inteiro.
            }
          </p>
        }

        @if (!podeAnalisar() && !llm.busy()) {
          <p class="hint">Carregue e processe um documento para habilitar a análise.</p>
        }

        @if (arquivoIaUrl() && !llm.selectedVision()) {
          <p class="hint">
            O modelo selecionado não lê imagens — escolha um modelo com visão
            (ex.: “…vision…” na OCI, ou gpt-4o) para usar “Enviar arquivo à IA”.
          </p>
        }

        @if (llm.busy()) {
          <div class="progress-wrap" role="status" aria-live="polite">
            <p class="status">{{ statusLabel() }}</p>
            @if (llm.status() === 'baixando-modelo') {
              <div class="progress-bar">
                <div class="progress-fill" [style.width.%]="llm.progressPercent()"></div>
              </div>
              <p class="pct">{{ llm.progressText() }}</p>
            }
            @if (llm.status() === 'analisando' && llm.partial()) {
              <pre class="ia-stream">{{ llm.partial() }}</pre>
            }
          </div>
        }

        @if (llm.error()) {
          <div class="error" role="alert">⚠️ {{ llm.error() }}</div>
        }

        @if (llm.result(); as r) {
          <div class="ia-result">
            <h3>Tipo identificado pela IA</h3>
            <p class="resumo">{{ r.tipoIdentificado || '—' }}</p>

            @if (r.revisao.length) {
              <h3>Revisão do conteúdo</h3>
              <ul>
                @for (item of r.revisao; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            }

            @if (r.validacoes?.length) {
              <h3>Validação dos dados</h3>
              <table class="kv">
                <thead>
                  <tr><th>Campo</th><th>Valor</th><th>Status</th><th>Observação</th></tr>
                </thead>
                <tbody>
                  @for (v of r.validacoes; track v.campo) {
                    <tr>
                      <td>{{ v.campo }}</td>
                      <td>{{ v.valor }}</td>
                      <td>
                        <span class="badge" [class]="validacaoClass(v.status)">
                          {{ validacaoLabel(v.status) }}
                        </span>
                      </td>
                      <td>{{ v.observacao || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              @if (r.parecer) {
                <h3>Parecer</h3>
                <p class="resumo">{{ r.parecer }}</p>
              }
            } @else {
              <h3>O CNPJ extraído confere com o documento?</h3>
              <p class="parecer-linha">
                <span class="badge" [class]="cnpjClass(r.cnpjConfere)">
                  {{ cnpjLabel(r.cnpjConfere) }}
                </span>
                <span class="conf">
                  CNPJ extraído: {{ docProc.structured()?.cnpj ?? '—' }}
                </span>
              </p>
              @if (r.cnpjObservacao) {
                <p class="resumo">{{ r.cnpjObservacao }}</p>
              }
            }

            <p class="disclaimer">
              Análise textual gerada por IA — apoio à leitura, não decisão final.
              As validações determinísticas (DV do CNPJ/CPF, status por data) vêm
              das regras (colunas acima).
            </p>
          </div>
        }
      }
  `,
})
export class LlmAnalysisComponent {
  protected readonly docProc = inject(DocumentProcessingService);
  protected readonly llm = inject(LlmAnalysisService);

  /** Só dá para analisar quando há dados extraídos e nada processando. */
  protected readonly podeAnalisar = computed(
    () => !!this.docProc.structured() && !this.docProc.isProcessing(),
  );

  /**
   * O que mandar no "Enviar arquivo à IA":
   *  - imagem  → o arquivo original;
   *  - PDF + modelo que ingere PDF nativo (gpt-4o) → o PDF cru (multipágina, tipo `file`);
   *  - PDF + modelo só-visão (OCI, que NÃO aceita PDF) → a 1ª página rasterizada (imagem).
   */
  protected readonly arquivoIaUrl = computed(() => {
    if (this.docProc.docKind() !== 'pdf') return this.docProc.fileDataUrl();
    return this.llm.selectedPdf()
      ? this.docProc.fileDataUrl() // PDF cru → backend anexa como type:file
      : this.docProc.canvasUrl(); // rasteriza a 1ª página
  });

  /** True quando o envio vai levar o PDF inteiro (nativo), não só a 1ª página. */
  protected readonly enviaraPdfNativo = computed(
    () => this.docProc.docKind() === 'pdf' && this.llm.selectedPdf(),
  );

  protected readonly botaoLabel = computed(() => {
    switch (this.llm.status()) {
      case 'baixando-modelo':
        return 'Baixando modelo…';
      case 'analisando':
        return 'Analisando…';
      default:
        return this.llm.result() ? 'Analisar novamente' : 'Analisar com IA';
    }
  });

  constructor() {
    // Ao trocar de documento, limpa a análise anterior (mantém o modelo em RAM).
    // `untracked` evita que as leituras de signal dentro de clearResult() virem
    // dependências do efeito — senão ele re-executaria a cada mudança de status
    // e apagaria o próprio resultado.
    effect(() => {
      this.docProc.fileName(); // única dependência: troca de documento
      untracked(() => this.llm.clearResult());
    });
  }

  protected analisar(): void {
    const structured = this.docProc.structured();
    console.info(
      '[LlmAnalysis] botão clicado — tem dados extraídos?',
      !!structured,
    );
    if (!structured) return;
    void this.llm.analisar(this.docProc.ocrText(), structured);
  }

  /** Analisa SÓ o texto cru do OCR, sem os campos parseados por regra. */
  protected analisarCru(): void {
    const structured = this.docProc.structured();
    if (!structured) return;
    void this.llm.analisar(this.docProc.ocrText(), structured, {
      rawOnly: true,
    });
  }

  /** Prompt enviado junto com o arquivo (e avaliado pelo guardrail). */
  protected readonly promptIa = signal(
    'Analise o documento anexado e responda SOMENTE com o JSON pedido.',
  );

  /** Envia o documento como imagem à IA (ver `arquivoIaUrl`), com o prompt acima. */
  protected analisarArquivo(): void {
    const structured = this.docProc.structured();
    const dataUrl = this.arquivoIaUrl();
    if (!structured || !dataUrl) return;
    void this.llm.analisar(this.docProc.ocrText(), structured, {
      file: { filename: this.docProc.fileName() ?? 'documento', dataUrl },
      prompt: this.promptIa(),
    });
  }

  protected statusLabel(): string {
    return this.llm.status() === 'baixando-modelo'
      ? 'Baixando o modelo (uma vez, depois fica em cache)…'
      : 'Analisando o documento…';
  }

  protected cnpjClass(v: CnpjConfere): string {
    switch (v) {
      case 'sim':
        return 'badge-ok';
      case 'não':
        return 'badge-bad';
      default:
        return 'badge-neutral';
    }
  }

  protected cnpjLabel(v: CnpjConfere): string {
    switch (v) {
      case 'sim':
        return 'Faz sentido';
      case 'não':
        return 'Não confere';
      default:
        return 'Incerto';
    }
  }

  protected validacaoClass(v: StatusValidacao): string {
    switch (v) {
      case 'valido':
        return 'badge-ok';
      case 'invalido':
        return 'badge-bad';
      default:
        return 'badge-neutral';
    }
  }

  protected validacaoLabel(v: StatusValidacao): string {
    switch (v) {
      case 'valido':
        return 'Válido';
      case 'invalido':
        return 'Inválido';
      default:
        return 'Incerto';
    }
  }
}
