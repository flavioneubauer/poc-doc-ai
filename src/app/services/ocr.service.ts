import { Injectable } from '@angular/core';
import { createWorker, OEM, PSM } from 'tesseract.js';

/** Entrada aceita pelo OCR: um canvas (vindo do PDF), um arquivo ou uma URL/dataURL. */
export type OcrInput = HTMLCanvasElement | File | string;

/** Callback de progresso: recebe o status atual e um valor 0..1. */
export type OcrProgressCallback = (status: string, progress: number) => void;

/**
 * Modo de segmentação de página:
 *  - 'auto'   : layout normal (default do Tesseract), bom para a leitura geral.
 *  - 'sparse' : "texto esparso" — acha texto solto que o auto às vezes pula
 *               (ex.: o número isolado no topo do cartão CNPJ).
 */
export type OcrMode = 'auto' | 'sparse';

/** Formato mínimo das mensagens emitidas pelo logger do tesseract.js. */
interface TesseractLog {
  status: string;
  progress: number;
}

/**
 * Serviço de OCR local usando tesseract.js.
 *
 * IMPORTANTE — privacidade:
 *  - O reconhecimento de texto roda inteiramente em WebAssembly NO NAVEGADOR.
 *  - A IMAGEM/DOCUMENTO do usuário nunca é enviada para nenhum servidor.
 *  - Na primeira execução, o tesseract.js baixa (uma única vez, e depois usa
 *    cache do browser) o "core" WASM e o modelo de idioma `por.traineddata`.
 *    Esse download é apenas de ARQUIVOS ESTÁTICOS do motor open-source — nenhum
 *    dado do documento trafega. Para um cenário 100% offline, é possível
 *    auto-hospedar esses arquivos (ver README → workerPath/corePath/langPath).
 */
@Injectable({ providedIn: 'root' })
export class OcrService {
  /**
   * Executa OCR em português sobre a entrada fornecida.
   *
   * @param image      Canvas, File ou URL da imagem.
   * @param onProgress Callback opcional para alimentar a barra de progresso.
   * @returns          Texto bruto reconhecido.
   */
  async recognize(
    image: OcrInput,
    onProgress?: OcrProgressCallback,
    mode: OcrMode = 'auto',
  ): Promise<string> {
    // Cria um worker dedicado para o idioma português usando o motor LSTM
    // (mais preciso). O logger reporta o andamento de cada fase.
    const worker = await createWorker('por', OEM.LSTM_ONLY, {
      logger: (m: TesseractLog) => onProgress?.(m.status, m.progress ?? 0),
    });

    try {
      if (mode === 'sparse') {
        // PSM 11: trata a página como texto esparso, sem assumir layout.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      }
      const { data } = await worker.recognize(image);
      return data.text ?? '';
    } finally {
      // Sempre encerrar o worker para liberar memória/threads — mesmo em erro.
      await worker.terminate();
    }
  }
}
