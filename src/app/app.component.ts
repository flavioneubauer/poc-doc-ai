import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { DocumentPreviewComponent } from './components/document-preview/document-preview.component';
import { FileUploadComponent } from './components/file-upload/file-upload.component';
import { LlmAnalysisComponent } from './components/llm-analysis/llm-analysis.component';
import { OcrPanelComponent } from './components/ocr-panel/ocr-panel.component';
import { StructuredDataComponent } from './components/structured-data/structured-data.component';
import { DocumentProcessingService } from './services/document-processing.service';

/**
 * Componente raiz (standalone).
 *
 * Responsável apenas pelo layout: cabeçalho com os selos de privacidade,
 * área de upload e o grid de 3 colunas. Toda a lógica vive nos serviços.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FileUploadComponent,
    DocumentPreviewComponent,
    OcrPanelComponent,
    StructuredDataComponent,
    LlmAnalysisComponent,
  ],
  template: `
    <div class="app">
      <header class="app-header">
        <h1>POC — Documentos no Navegador</h1>
        <div class="badges">
          <span class="privacy-badge">🔒 Local no navegador</span>
          <span class="privacy-badge">🚫 Nada enviado a servidores</span>
        </div>
      </header>

      <section class="upload-section">
        <app-file-upload />
        @if (svc.error()) {
          <div class="error" role="alert">⚠️ {{ svc.error() }}</div>
        }
      </section>

      <main class="columns">
        <section class="col"><app-document-preview /></section>
        <section class="col"><app-ocr-panel /></section>
        <section class="col"><app-structured-data /></section>
        <section class="col"><app-llm-analysis /></section>
      </main>
    </div>
  `,
})
export class AppComponent {
  protected readonly svc = inject(DocumentProcessingService);
}
