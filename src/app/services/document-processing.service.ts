import { computed, inject, Injectable, signal } from '@angular/core';

import { DocKind, StructuredData } from '../models/document.model';
import { ExtractionService } from './extraction.service';
import { ImageService } from './image.service';
import { OcrService } from './ocr.service';
import { PdfService } from './pdf.service';

/** Conjunto de tipos MIME aceitos pela POC. */
const ACCEPTED = new Set(['application/pdf', 'image/jpeg', 'image/png']);

/**
 * Fachada (facade) que orquestra todo o pipeline e expõe o ESTADO via Signals.
 *
 * Os componentes apenas LEEM esses signals — isso mantém a UI reativa sem
 * acoplar os componentes entre si nem espalhar lógica de processamento.
 *
 * Pipeline: arquivo -> (PDF? renderiza canvas) -> OCR -> extração estruturada.
 */
@Injectable({ providedIn: 'root' })
export class DocumentProcessingService {
  private readonly pdf = inject(PdfService);
  private readonly image = inject(ImageService);
  private readonly ocr = inject(OcrService);
  private readonly extraction = inject(ExtractionService);

  // --- Estado reativo (signals graváveis internamente) -----------------------
  private readonly _fileName = signal<string | null>(null);
  /** Arquivo original em data URL (base64) — usado para enviar o PDF à IA sem OCR. */
  private readonly _fileDataUrl = signal<string | null>(null);
  private readonly _docKind = signal<DocKind>(null);
  private readonly _previewUrl = signal<string | null>(null); // imagens (objectURL)
  private readonly _canvasUrl = signal<string | null>(null); // PDF renderizado (dataURL)
  private readonly _ocrImageUrl = signal<string | null>(null); // imagem tratada p/ OCR
  private readonly _isProcessing = signal(false);
  private readonly _ocrStatus = signal('');
  private readonly _ocrProgress = signal(0); // 0..1
  private readonly _ocrText = signal('');
  private readonly _structured = signal<StructuredData | null>(null);
  private readonly _error = signal<string | null>(null);

  // --- Exposição somente-leitura para os componentes -------------------------
  readonly fileName = this._fileName.asReadonly();
  readonly fileDataUrl = this._fileDataUrl.asReadonly();
  readonly docKind = this._docKind.asReadonly();
  readonly previewUrl = this._previewUrl.asReadonly();
  readonly canvasUrl = this._canvasUrl.asReadonly();
  readonly ocrImageUrl = this._ocrImageUrl.asReadonly();
  readonly isProcessing = this._isProcessing.asReadonly();
  readonly ocrStatus = this._ocrStatus.asReadonly();
  readonly ocrText = this._ocrText.asReadonly();
  readonly structured = this._structured.asReadonly();
  readonly error = this._error.asReadonly();

  /** Progresso do OCR em porcentagem inteira (derivado), para a barra. */
  readonly progressPercent = computed(() => Math.round(this._ocrProgress() * 100));

  /**
   * Executa todo o pipeline para o arquivo informado.
   * Captura erros e os publica no signal `error` (tratamento centralizado).
   */
  async process(file: File): Promise<void> {
    this.reset();

    if (!ACCEPTED.has(file.type)) {
      this._error.set(
        `Formato não suportado (${file.type || 'desconhecido'}). Envie PDF, JPG ou PNG.`,
      );
      return;
    }

    this._fileName.set(file.name);
    this._isProcessing.set(true);

    // Guarda o arquivo original (base64) para o envio direto à IA (sem OCR).
    try {
      this._fileDataUrl.set(await this.fileToDataUrl(file));
    } catch {
      this._fileDataUrl.set(null);
    }

    try {
      // 1) Prepara a entrada do OCR e o preview, conforme o tipo do arquivo.
      let ocrInput: HTMLCanvasElement | File;

      if (file.type === 'application/pdf') {
        this._docKind.set('pdf');
        this._ocrStatus.set('Renderizando PDF...');
        // Renderiza a 1ª página em canvas; usamos o canvas tanto para preview
        // (convertido em dataURL) quanto como entrada do OCR.
        const canvas = await this.pdf.renderFirstPageToCanvas(file);
        this._canvasUrl.set(canvas.toDataURL('image/png'));
        ocrInput = canvas;
      } else {
        this._docKind.set('image');
        // Preview: imagem original (object URL local).
        this._previewUrl.set(URL.createObjectURL(file));
        // OCR: imagem PRÉ-PROCESSADA (upscale + cinza + contraste). Documentos
        // como o cartão CNPJ leem muito melhor depois desse tratamento.
        this._ocrStatus.set('Pré-processando imagem...');
        const canvas = await this.image.preprocessToCanvas(file);
        // Guarda a imagem tratada para o usuário inspecionar o que o OCR recebe.
        this._ocrImageUrl.set(canvas.toDataURL('image/png'));
        ocrInput = canvas;
      }

      // 2) OCR local com progresso.
      this._ocrStatus.set('Preparando OCR...');
      const text = await this.ocr.recognize(ocrInput, (status, progress) => {
        this._ocrStatus.set(this.translateStatus(status));
        this._ocrProgress.set(progress);
      });
      this._ocrText.set(text);

      // 3) Extração estruturada (puro processamento local de texto).
      this._ocrStatus.set('Extraindo dados...');
      let structured = this.extraction.extract(text);

      // 3b) Resgate do CNPJ: se o 1º passe não achou, refaz o OCR em modo
      //     "texto esparso" (PSM 11). Documentos como o cartão CNPJ embaralham
      //     a caixa do "NÚMERO DE INSCRIÇÃO" no layout automático; o modo
      //     esparso costuma recuperar esse número isolado. Só o CNPJ é
      //     aproveitado daqui — os demais campos vêm do 1º passe.
      if (!structured.cnpj) {
        this._ocrStatus.set('Procurando CNPJ (2º passe)...');
        this._ocrProgress.set(0);
        const sparseText = await this.ocr.recognize(
          ocrInput,
          (status, progress) => {
            this._ocrStatus.set(this.translateStatus(status));
            this._ocrProgress.set(progress);
          },
          'sparse',
        );
        const cnpj = this.extraction.extractCnpj(sparseText);
        if (cnpj) structured = { ...structured, cnpj };
      }

      this._structured.set(structured);
      this._ocrStatus.set('Concluído ✅');
    } catch (e) {
      // Tratamento de erro centralizado: qualquer falha do pipeline chega aqui.
      console.error('[DocumentProcessing] erro no pipeline:', e);
      this._error.set(
        e instanceof Error ? e.message : 'Erro desconhecido ao processar o documento.',
      );
    } finally {
      this._isProcessing.set(false);
    }
  }

  /** Limpa todo o estado e libera o object URL anterior (evita vazamento). */
  private reset(): void {
    const prev = this._previewUrl();
    if (prev) URL.revokeObjectURL(prev);

    this._fileName.set(null);
    this._fileDataUrl.set(null);
    this._docKind.set(null);
    this._previewUrl.set(null);
    this._canvasUrl.set(null);
    this._ocrImageUrl.set(null);
    this._ocrStatus.set('');
    this._ocrProgress.set(0);
    this._ocrText.set('');
    this._structured.set(null);
    this._error.set(null);
  }

  /** Lê um File como data URL (base64) para envio à IA. */
  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** Traduz os status técnicos do tesseract.js para mensagens em português. */
  private translateStatus(status: string): string {
    const map: Record<string, string> = {
      'loading tesseract core': 'Carregando núcleo do OCR...',
      'initializing tesseract': 'Inicializando OCR...',
      'loading language traineddata': 'Carregando idioma (português)...',
      'initializing api': 'Inicializando reconhecimento...',
      'recognizing text': 'Reconhecendo texto...',
    };
    return map[status] ?? status;
  }
}
