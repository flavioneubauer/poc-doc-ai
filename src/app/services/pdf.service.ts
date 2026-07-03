import { Injectable } from '@angular/core';
import { getDocument, GlobalWorkerOptions, version } from 'pdfjs-dist';

/**
 * Serviço responsável por renderizar PDFs usando pdfjs-dist.
 *
 * IMPORTANTE — privacidade: pdfjs-dist roda 100% no navegador (inclusive o
 * web worker). O arquivo nunca é enviado para nenhum servidor; trabalhamos
 * apenas com o ArrayBuffer lido localmente pelo browser.
 */
@Injectable({ providedIn: 'root' })
export class PdfService {
  constructor() {
    // PARTE CRÍTICA: o pdf.js executa o parsing em um web worker.
    // Apontamos o worker para um arquivo COPIADO LOCALMENTE (ver angular.json),
    // garantindo que nenhum recurso seja buscado em CDN/servidor externo.
    //
    // O arquivo é copiado de node_modules/pdfjs-dist/build para /assets na build.
    GlobalWorkerOptions.workerSrc = new URL(
      'assets/pdf.worker.min.mjs',
      document.baseURI,
    ).toString();

    // Log informativo (ajuda a depurar incompatibilidade de versão worker x lib).
    console.info(`[PdfService] pdfjs-dist v${version} inicializado (worker local).`);
  }

  /**
   * Renderiza a PRIMEIRA página do PDF em um <canvas> e o retorna.
   *
   * @param file  Arquivo PDF selecionado pelo usuário.
   * @param scale Fator de escala. Usamos 2 por padrão porque uma resolução
   *              maior melhora bastante a qualidade do OCR posterior.
   */
  async renderFirstPageToCanvas(file: File, scale = 2): Promise<HTMLCanvasElement> {
    // Lê o conteúdo binário do arquivo localmente (sem upload).
    const data = await file.arrayBuffer();

    // Abre o documento. `getDocument` retorna uma "loading task".
    const pdf = await getDocument({ data }).promise;

    try {
      // Páginas em pdf.js são indexadas a partir de 1.
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale });

      // Cria o canvas com as dimensões da página renderizada.
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Não foi possível obter o contexto 2D do canvas.');
      }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      // Renderiza a página no canvas e aguarda a conclusão.
      await page.render({ canvasContext: context, viewport }).promise;

      return canvas;
    } finally {
      // Libera os recursos do documento (boas práticas com pdf.js).
      await pdf.destroy();
    }
  }
}
