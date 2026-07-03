import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';

import { DocumentProcessingService } from '../../services/document-processing.service';

/**
 * Coluna 1 — "Documento Original".
 *
 * Mostra a imagem enviada (JPG/PNG) ou a primeira página do PDF renderizada
 * em canvas (exibida aqui como imagem a partir do dataURL gerado).
 */
@Component({
  selector: 'app-document-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>📑 Documento Original</h2>

    @if (!svc.fileName()) {
      <p class="empty">Nenhum documento carregado ainda.</p>
    }

    <!-- Imagem (JPG/PNG): preview do original com opção de ver a imagem do OCR -->
    @if (svc.docKind() === 'image' && svc.previewUrl()) {
      @if (svc.ocrImageUrl()) {
        <div class="toggle">
          <button type="button" [class.active]="!showOcr()" (click)="showOcr.set(false)">
            Original
          </button>
          <button type="button" [class.active]="showOcr()" (click)="showOcr.set(true)">
            Imagem do OCR
          </button>
        </div>
      }
      <img
        class="preview"
        [src]="showOcr() && svc.ocrImageUrl() ? svc.ocrImageUrl() : svc.previewUrl()"
        alt="Pré-visualização do documento"
      />
      @if (showOcr()) {
        <p class="note">
          Imagem pré-processada (upscale + cinza + contraste) enviada ao Tesseract.
        </p>
      }
    }

    <!-- PDF: canvas renderizado pelo pdfjs-dist (1ª página) -->
    @if (svc.docKind() === 'pdf' && svc.canvasUrl()) {
      <img
        class="preview"
        [src]="svc.canvasUrl()"
        alt="Primeira página do PDF renderizada em canvas"
      />
      <p class="note">Primeira página renderizada em canvas via pdfjs-dist.</p>
    }
  `,
})
export class DocumentPreviewComponent {
  protected readonly svc = inject(DocumentProcessingService);

  /** Alterna o preview entre a imagem original e a versão tratada para o OCR. */
  protected readonly showOcr = signal(false);
}
