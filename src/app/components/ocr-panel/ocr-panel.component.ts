import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { DocumentProcessingService } from '../../services/document-processing.service';

/**
 * Coluna 2 — "Texto OCR".
 *
 * Exibe a barra de progresso durante o processamento e, ao final, o texto
 * bruto reconhecido pelo tesseract.js.
 */
@Component({
  selector: 'app-ocr-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>🔎 Texto OCR</h2>

    <!-- Loading + barra de progresso durante o OCR -->
    @if (svc.isProcessing()) {
      <div class="progress-wrap" role="status" aria-live="polite">
        <p class="status">{{ svc.ocrStatus() }}</p>
        <div
          class="progress-bar"
          role="progressbar"
          [attr.aria-valuenow]="svc.progressPercent()"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="progress-fill" [style.width.%]="svc.progressPercent()"></div>
        </div>
        <p class="pct">{{ svc.progressPercent() }}%</p>
      </div>
    }

    <!-- Texto reconhecido -->
    @if (svc.ocrText()) {
      <textarea class="ocr-text" readonly>{{ svc.ocrText() }}</textarea>
    } @else if (!svc.isProcessing()) {
      <p class="empty">O texto reconhecido aparecerá aqui.</p>
    }
  `,
})
export class OcrPanelComponent {
  protected readonly svc = inject(DocumentProcessingService);
}
