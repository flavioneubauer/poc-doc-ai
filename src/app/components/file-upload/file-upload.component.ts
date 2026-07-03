import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { DocumentProcessingService } from '../../services/document-processing.service';

/**
 * Componente de upload com suporte a clique e arrastar-e-soltar.
 *
 * Não guarda lógica de processamento: apenas captura o arquivo e delega para
 * o `DocumentProcessingService` (fachada).
 */
@Component({
  selector: 'app-file-upload',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="dropzone"
      [class.dragover]="isDragOver()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      <!-- input escondido; acionado pelo botão -->
      <input
        #fileInput
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        (change)="onFileChange($event)"
        hidden
      />

      <p class="dz-icon">📄</p>
      <p class="dz-text">Arraste um arquivo aqui ou</p>
      <button type="button" (click)="fileInput.click()" [disabled]="svc.isProcessing()">
        {{ svc.isProcessing() ? 'Processando…' : 'Selecionar arquivo' }}
      </button>
      <p class="dz-hint">Formatos aceitos: PDF, JPG, PNG</p>

      @if (svc.fileName()) {
        <p class="dz-file">Arquivo: <strong>{{ svc.fileName() }}</strong></p>
      }
    </div>
  `,
})
export class FileUploadComponent {
  // `protected` para que o template possa ler os signals da fachada.
  protected readonly svc = inject(DocumentProcessingService);

  /** Controle puramente visual do realce durante o arraste. */
  protected readonly isDragOver = signal(false);

  protected onFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.svc.process(file);
    // Reseta o valor para permitir reenviar o MESMO arquivo novamente.
    input.value = '';
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.svc.process(file);
  }
}
